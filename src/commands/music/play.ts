import { BaseCommand } from '../../structures/BaseCommand';
import { Youtube } from '../../services/api/Youtube';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { InputParser } from '../../services/music/InputParser';
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
            // 1. Setup Voice Connection First (so it's fast)
            await MusicPlayer.join(guildId, member.voice.channelId!, textChannel);

            // 2. Parse Input cleanly
            const { tracks: tracksToProcess, collectionName } = await InputParser.parse(
                query, 
                dbUser?.lastfmUsername, 
                dbUser?.lastfmSessionKey
            );

            if (tracksToProcess.length === 0) {
                const msg = '❌ Please provide a song, album, or playlist to play!';
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // 3. Process Tracks
            if (tracksToProcess.length > 1) {
                const statusBuilder = new ComponentsV2()
                    .addText(`⏳ **Processing ${tracksToProcess.length} tracks from ${collectionName}...**`);
                
                let statusMsg: any;
                if (isSlash) {
                    statusMsg = await interactionOrMessage.editReply(statusBuilder.build());
                } else {
                    statusMsg = await interactionOrMessage.reply(statusBuilder.build());
                }

                let queuedCount = 0;
                for (const t of tracksToProcess) {
                    const result = await this.resolveAndQueue(guildId, t.name, t.artist, member, dbUser, t.url);
                    if (result) queuedCount++;
                }

                const finalBuilder = new ComponentsV2()
                    .addText(`✅ **Queued ${queuedCount} tracks from ${collectionName}.**`);
                
                if (isSlash) {
                    await interactionOrMessage.editReply(finalBuilder.build());
                } else if (statusMsg && statusMsg.edit) {
                    await statusMsg.edit(finalBuilder.build());
                }
            } else {
                // Single track
                const t = tracksToProcess[0];
                const res = await this.resolveAndQueue(guildId, t.name, t.artist, member, dbUser, t.url);

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

                    if (isSlash) await interactionOrMessage.editReply(builder.build());
                    else await interactionOrMessage.reply(builder.build());
                }
            }

        } catch (err: any) {
            console.error('[PlayCommand] Error:', err);
            const msg = `⚠️ Error: ${err.message || 'Something went wrong.'}`;
            if (isSlash) await interactionOrMessage.editReply({ content: msg }).catch(() => { });
            else await interactionOrMessage.reply(msg).catch(() => { });
        }
    }

    private async resolveAndQueue(guildId: string, name: string, artist: string, member: GuildMember, dbUser: any, existingUrl?: string): Promise<{ position: number; artist: string; track: string; artworkUrl: string | null } | null> {
        const query = existingUrl || (artist ? `${artist} - ${name}` : name);
        const result = await Youtube.search(query);
        if (!result) return null;

        if (artist && name) {
            result.artistName = artist;
            result.trackTitle = name;
        }

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
