import { BaseCommand } from '../../structures/BaseCommand';
import { Youtube } from '../../services/api/Youtube';
import { MusicPlayer } from '../../services/bot/MusicPlayer';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { Deezer } from '../../services/api/Deezer';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, TextChannel, GuildMember } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { TrackResolverService } from '../../services/api/TrackResolverService';

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

        if (!isPrefix && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        let query = args.join(' ');
        const dbUser = await prisma.user.findUnique({ where: { discordId: member.id } });

        try {
            // 1. Detect Spotify Links
            const spotifyTrackRegex = /(?:https?:\/\/)?open\.spotify\.com\/track\/([a-zA-Z0-9]+)(?:\?.*)?/;
            const spotifyAlbumRegex = /(?:https?:\/\/)?open\.spotify\.com\/album\/([a-zA-Z0-9]+)(?:\?.*)?/;
            const spotifyPlaylistRegex = /(?:https?:\/\/)?open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)(?:\?.*)?/;

            let tracksToProcess: { name: string; artist: string }[] = [];
            let collectionName = '';

            const trackMatch = query.match(spotifyTrackRegex);
            const albumMatch = query.match(spotifyAlbumRegex);
            const playlistMatch = query.match(spotifyPlaylistRegex);

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
                // Raw query search
                const meta = await Spotify.searchRaw(query);
                if (meta) tracksToProcess.push(meta);
                else tracksToProcess.push({ name: query, artist: '' }); // Fallback to raw query if searchRaw fails
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
    private async resolveAndQueue(guildId: string, name: string, artist: string, member: GuildMember, dbUser: any): Promise<{ position: number; artist: string; track: string; artworkUrl: string | null } | null> {
        const query = artist ? `${artist} - ${name}` : name;
        const result = await Youtube.search(query);
        if (!result) return null;

        // Resolve High-Res Artwork
        let finalArtist = artist;
        let finalTrack = name;
        if (!finalArtist || !finalTrack) {
            if (result.title.includes(' - ')) {
                const parts = result.title.split(' - ');
                finalArtist = parts[0].trim();
                finalTrack = parts[1].trim().replace(/\(.*\)|\[.*\]/g, '').trim();
            } else {
                finalTrack = result.title;
                finalArtist = result.channelTitle.replace(' - Topic', '');
            }
        }

        // ── GLOBAL RESOLUTION (UTR) ──
        const resolved = await TrackResolverService.resolve(finalArtist, finalTrack);

        finalArtist = resolved.artist;
        finalTrack = resolved.title;
        const artworkUrl = resolved.artworkUrl;

        let finalDuration = result.duration;
        if (resolved.durationMs > 0) {
            const totalSeconds = Math.floor(resolved.durationMs / 1000);
            result.durationSeconds = totalSeconds;
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            finalDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }

        // Fetch extra stats from Last.fm
        let statsText = '';
        try {
            const lfmInfo = await LastFM.getTrackInfo(finalArtist, finalTrack, dbUser?.lastfmUsername, dbUser?.lastfmSessionKey);
            const listeners = lfmInfo?.listeners ? parseInt(lfmInfo.listeners).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;
            const plays = lfmInfo?.playcount ? parseInt(lfmInfo.playcount).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;

            const parts = [];
            if (finalDuration) parts.push(finalDuration);
            if (listeners) parts.push(`${listeners} listeners`);
            if (plays) parts.push(`${plays} plays`);
            if (parts.length > 0) statsText = `\n${parts.join(' • ')}`;
        } catch { }

        result.artistName = finalArtist;
        result.trackTitle = finalTrack;
        result.artworkUrl = artworkUrl ?? undefined;
        result.statsText = statsText;
        result.requesterName = member.user.displayName;
        if (finalDuration) result.duration = finalDuration;

        const queuePos = await MusicPlayer.play(guildId, result);

        return {
            position: queuePos,
            artist: finalArtist,
            track: finalTrack,
            artworkUrl: artworkUrl
        };
    }
}
