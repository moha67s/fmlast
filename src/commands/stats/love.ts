import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class LoveCommand extends BaseCommand {
    name = 'love';
    description = 'Love a track on Last.fm';
    aliases = [];

    slashData = new SlashCommandBuilder()
        .setName('love')
        .setDescription('Love a track on Last.fm')
        .addStringOption(opt => 
            opt.setName('track')
                .setDescription('The track name to love (defaults to current track)')
                .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('artist')
                .setDescription('The artist name')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        const guildId = interactionOrMessage.guildId;
        
        let trackName = '';
        let artistName = '';

        if (isSlash) {
            trackName = interactionOrMessage.options.getString('track') || '';
            artistName = interactionOrMessage.options.getString('artist') || '';
        } else {
            const input = (args || []).join(' ').trim();
            if (input) {
                const parts = input.split('|').map(s => s.trim());
                if (parts.length >= 2) {
                    trackName = parts[0];
                    artistName = parts[1];
                } else {
                    trackName = input;
                }
            }
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbUser || !dbUser.lastfmSessionKey) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ You must be logged in to Last.fm to love tracks. Use `/login`.').build();
            return isSlash ? interactionOrMessage.reply({ ...payload, ephemeral: true }) : interactionOrMessage.reply(payload);
        }

        // AUTO-RESOLVE TRACK
        if (!trackName || !artistName) {
            // 1. Try currently playing track
            if (guildId) {
                const { QueueManager } = await import('../../services/music/QueueManager');
                const queue = QueueManager.getQueue(guildId);
                if (queue?.currentTrack) {
                    trackName = queue.currentTrack.trackTitle || queue.currentTrack.title;
                    artistName = queue.currentTrack.artistName || queue.currentTrack.channelTitle;
                }
            }

            // 2. Try Last.fm history if still nothing
            if (!trackName || !artistName) {
                try {
                    const result = await LastFM.getRecentTracksPaginated(dbUser.lastfmUsername, 1, 1, dbUser.lastfmSessionKey);
                    const lastTrack = result.tracks?.[0];
                    if (lastTrack) {
                        trackName = lastTrack.name;
                        artistName = lastTrack.artist?.['#text'] || lastTrack.artist?.name;
                    }
                } catch {}
            }
        }

        if (!trackName || !artistName) {
            const errorPayload = new ComponentsV2().setAccent(0xff0000).addText('❌ Could not determine a track to love. Please provide it manually: `.love track | artist`').build();
            return isSlash ? interactionOrMessage.reply({ ...errorPayload, ephemeral: true }) : interactionOrMessage.reply(errorPayload);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            await LastFM.love(artistName, trackName, dbUser.lastfmSessionKey);
            const payload = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`❤️ Loved **${trackName}** by **${artistName}** on Last.fm!`)
                .build();
                
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to love track: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
