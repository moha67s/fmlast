import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class StreakCommand extends BaseCommand {
    name = 'streak';
    description = 'View your current listening streak';
    aliases = ['st'];

    slashData = new SlashCommandBuilder()
        .setName('streak')
        .setDescription('View current listening streak')
        .addStringOption((opt: any) => 
            opt.setName('query')
                .setDescription('User mention or username')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const query = isSlash 
            ? interactionOrMessage.options.getString('query') || '' 
            : (args ? args.join(' ') : '');

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        const userSettings = await SettingService.getUser(query, dbAuthor);
        const targetDbUser = userSettings.targetUser;

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        try {
            // 1. Fetch latest plays from DB
            const latestPlays = await prisma.userPlay.findMany({
                where: { userId: targetDbUser.id },
                orderBy: { timePlayed: 'desc' },
                take: 100 // Should be enough for most streaks
            });

            if (latestPlays.length === 0) {
                const payload = new ComponentsV2().addText(`**${userSettings.displayName}** has no recorded plays yet.`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const current = latestPlays[0];
            
            // 2. Calculate Artist Streak
            let artistStreak = 0;
            for (const play of latestPlays) {
                if (play.artistName.toLowerCase() === current.artistName.toLowerCase()) artistStreak++;
                else break;
            }

            // 3. Calculate Track Streak
            let trackStreak = 0;
            for (const play of latestPlays) {
                if (play.artistName.toLowerCase() === current.artistName.toLowerCase() && 
                    play.trackName.toLowerCase() === current.trackName.toLowerCase()) trackStreak++;
                else break;
            }

            // 4. Calculate Album Streak
            let albumStreak = 0;
            if (current.albumName) {
                for (const play of latestPlays) {
                    if (play.artistName.toLowerCase() === current.artistName.toLowerCase() && 
                        play.albumName?.toLowerCase() === current.albumName.toLowerCase()) albumStreak++;
                    else break;
                }
            }

            // 5. Build Response
            const builder = new ComponentsV2().setAccent(embedColor);
            
            if (artistStreak <= 1 && trackStreak <= 1 && albumStreak <= 1) {
                builder.addText(`### No active streak found for ${userSettings.displayName}`);
                builder.addText(`Try scrobbling multiple of the same artist, album or track in a row to get started.`);
                const payload = builder.build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const artistUrl = `https://www.last.fm/music/${encodeURIComponent(current.artistName)}`;
            const trackUrl = `${artistUrl}/_/${encodeURIComponent(current.trackName)}`;

            builder.addText(`### Current Streak for ${userSettings.displayName}`);
            if (artistStreak > 1) builder.addText(`🎶 **Artist:** **[${current.artistName}](${artistUrl})** — **${artistStreak}** consecutive plays`);
            if (trackStreak > 1) builder.addText(`🎵 **Track:** **[${current.trackName}](${trackUrl})** — **${trackStreak}** consecutive plays`);
            
            if (current.albumName && albumStreak > 1) {
                const albumUrl = `${artistUrl}/${encodeURIComponent(current.albumName)}`;
                builder.addText(`💿 **Album:** **[${current.albumName}](${albumUrl})** — **${albumStreak}** consecutive plays`);
            }

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to calculate streak.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
