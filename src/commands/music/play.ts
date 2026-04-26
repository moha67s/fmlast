import { BaseCommand } from '../../structures/BaseCommand';
import { Youtube } from '../../services/api/Youtube';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { Deezer } from '../../services/api/Deezer';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, TextChannel, GuildMember } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { MetadataService } from '../../services/bot/MetadataService';

export default class PlayCommand extends BaseCommand {
    name = 'play';
    description = 'Play a YouTube video in your voice channel';
    aliases = ['p', 'join'];

    slashData = new SlashCommandBuilder()
        .setName('play')
        .setDescription('Play a YouTube video in your voice channel')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The song to search for (or YouTube/Spotify URL)')
                .setRequired(false)
                .setAutocomplete(true)
        );

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const isPrefix = !isSlash;
        const member = (isSlash ? interactionOrMessage.member : interactionOrMessage.member) as GuildMember;
        const textChannel = interactionOrMessage.channel as TextChannel;
        const guildId = interactionOrMessage.guildId!;

        if (!member.voice.channel) {
            const msg = '❌ You must be in a voice channel to use this command!';
            if (isSlash) await interactionOrMessage.reply({ content: msg, ephemeral: true });
            else await interactionOrMessage.reply(msg);
            return;
        }

        if (!isSlash) await interactionOrMessage.channel.sendTyping();

        if (!isPrefix && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        let query = args.join(' ');
        const dbUser = await prisma.user.findUnique({ where: { discordId: member.id } });

        try {
            // 1. Detect Spotify & YouTube Links
            const spotifyTrackRegex = /(?:https?:\/\/)?open\.spotify\.com\/track\/([a-zA-Z0-9]+)(?:\?.*)?/;
            const spotifyAlbumRegex = /(?:https?:\/\/)?open\.spotify\.com\/album\/([a-zA-Z0-9]+)(?:\?.*)?/;
            const spotifyPlaylistRegex = /(?:https?:\/\/)?open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)(?:\?.*)?/;
            const youtubePlaylistRegex = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/;

            let tracksToProcess: { name: string; artist: string; url?: string }[] = [];
            let collectionName = '';

            const trackMatch = query.match(spotifyTrackRegex);
            const albumMatch = query.match(spotifyAlbumRegex);
            const playlistMatch = query.match(spotifyPlaylistRegex);
            const ytPlaylistMatch = query.match(youtubePlaylistRegex);

            if (trackMatch) {
                const meta = await Spotify.getTrackMetadataById(trackMatch[1]);
                if (meta) tracksToProcess.push(meta);
            } else if (albumMatch) {
                const tracks = await Spotify.getAlbumTracks(albumMatch[1]);
                tracksToProcess = tracks;
                collectionName = 'Album';
            } else if (playlistMatch) {
                const tracks = await Spotify.getPlaylistTracks(playlistMatch[1]);
                tracksToProcess = tracks;
                collectionName = 'Playlist';
            } else if (ytPlaylistMatch) {
                const playlist = await Youtube.getPlaylistInfo(query);
                tracksToProcess = playlist.songs.map(s => ({ name: s.title, artist: s.channelTitle, url: s.url }));
                collectionName = `YouTube Playlist (${playlist.title})`;
            } else if (!query) {
                // If no query, try to find user's current track from Last.fm
                if (dbUser?.lastfmUsername) {
                    const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey || undefined);
                    if (tracks && tracks.length > 0) {
                        tracksToProcess.push({
                            name: tracks[0].name,
                            artist: tracks[0].artist['#text']
                        });
                    }
                }
            } else if (!query.startsWith('http')) {
                // Raw query search - check for 'by' keyword
                let trackPart = query;
                let artistPart = '';

                if (query.includes(' by ')) {
                    const parts = query.split(' by ');
                    trackPart = parts[0].trim();
                    artistPart = parts[1].trim();
                    
                    // Handle common abbreviations
                    if (artistPart.toLowerCase() === 'cas') artistPart = 'Cigarettes After Sex';
                }

                const meta = await Spotify.searchRaw(artistPart ? `${trackPart} ${artistPart}` : query);
                if (meta) {
                    tracksToProcess.push(meta);
                } else {
                    tracksToProcess.push({ name: trackPart, artist: artistPart });
                }
            } else {
                // YouTube link or similar (handled by Youtube.search directly)
                tracksToProcess.push({ name: query, artist: '' });
            }

            if (tracksToProcess.length === 0) {
                const msg = '❌ Please provide a song, album, or playlist to play!';
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // 2. Setup Voice Connection
            await MusicPlayer.join(guildId, member.voice.channelId!, textChannel);

            // 3. Process Tracks
            if (tracksToProcess.length > 1) {
                const statusBuilder = new ComponentsV2()
                    .addText(`⌛ **Processing ${tracksToProcess.length} tracks from ${collectionName}...**`);
                const statusPayload = statusBuilder.build();

                let statusMsg: any;
                if (isSlash) {
                    statusMsg = await interactionOrMessage.editReply(statusPayload);
                } else {
                    statusMsg = await interactionOrMessage.reply(statusPayload);
                }

                let queuedCount = 0;
                for (const t of tracksToProcess) {
                    const result = await this.resolveAndQueue(guildId, t.name, t.artist, member, dbUser);
                    if (result) queuedCount++;
                }

                const finalBuilder = new ComponentsV2()
                    .addText(`✅ **Queued ${queuedCount} tracks from ${collectionName}.**`);
                const finalPayload = finalBuilder.build();

                if (isSlash) {
                    await interactionOrMessage.editReply(finalPayload);
                } else if (statusMsg && statusMsg.edit) {
                    await statusMsg.edit(finalPayload);
                }
            } else {
                // Single track logic
                const t = tracksToProcess[0];
                const res = await this.resolveAndQueue(guildId, t.name, t.artist, member, dbUser);

                if (!res) {
                    const msg = `❌ I couldn't find a playable version for **${t.name}${t.artist ? ` by ${t.artist}` : ''}**.`;
                    if (isSlash) await interactionOrMessage.editReply(msg);
                    else await interactionOrMessage.reply(msg);
                    return;
                }

                if (res.position === 1) {
                    if (isSlash) await interactionOrMessage.deleteReply().catch(() => { });
                } else {
                    const builder = new ComponentsV2()
                        .addThumbnail(res.artworkUrl || "https://i.imgur.com/Gis9d79.png", `### 📝 Added to queue\n**${res.artist} - ${res.track.replace(/\[.*?\]|\(.*?\)/g, '')}**\n-# Position in queue: ${res.position}`);

                    const payload = builder.build();
                    if (isSlash) await interactionOrMessage.editReply(payload);
                    else await interactionOrMessage.reply(payload);
                }
            }

        } catch (err: any) {
            console.error('[PlayCommand] Error:', err);
            const msg = `⚠️ Error: ${err.message || 'Something went wrong.'}`;
            if (isSlash) await interactionOrMessage.editReply({ content: msg }).catch(() => { });
            else await interactionOrMessage.reply(msg).catch(() => { });
        }
    }

    /**
     * Helper to resolve a track name/artist to a YouTube result and add to queue
     */
    private async resolveAndQueue(guildId: string, name: string, artist: string, member: GuildMember, dbUser: any, existingUrl?: string): Promise<{ position: number; artist: string; track: string; artworkUrl: string | null } | null> {
        const query = existingUrl || (artist ? `${artist} - ${name}` : name);
        const result = await Youtube.search(query);
        if (!result) return null;

        // Force original metadata if we have it (prevents YouTube covers from overwriting)
        if (artist && name) {
            result.artistName = artist;
            result.trackTitle = name;
        }

        // Enrich track with metadata
        await MetadataService.enrich(result, member, dbUser);

        const queuePos = await MusicPlayer.play(guildId, result);

        return {
            position: queuePos,
            artist: result.artistName!,
            track: result.trackTitle!,
            artworkUrl: result.artworkUrl || null
        };
    }

    async autocomplete(interaction: any) {
        const focusedValue = interaction.options.getFocused();
        if (!focusedValue) return interaction.respond([]);

        try {
            const YouTube = (await import('youtube-sr')).default as any;
            const results = await YouTube.search(focusedValue, { limit: 10, type: 'video' });
            
            await interaction.respond(
                results.map(video => ({
                    name: `${video.title} (${video.channel?.name})`.substring(0, 100),
                    value: video.url
                }))
            );
        } catch (err) {
            await interaction.respond([]);
        }
    }
}
