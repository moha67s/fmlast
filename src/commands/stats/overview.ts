import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { buildQuickChartUrl } from '../../utils/quickchart';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class OverviewCommand extends BaseCommand {
    name = 'overview';
    description = 'View your daily listening overview (scrobbles per day)';
    aliases = ['ov'];

    slashData = new SlashCommandBuilder()
        .setName('overview')
        .setDescription('View your daily listening overview')
        .addStringOption(opt => 
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

        if (!targetDbUser.lastfmUsername) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Target user has no Last.fm linked.').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // Fire & Forget background sync
            triggerDeltaSync(targetDbUser.discordId);

            // Fetch last 30 days of listening
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

            const querySql = `
                SELECT DATE_TRUNC('day', time_played) as day_start, CAST(COUNT(*) AS INTEGER) as playcount
                FROM user_plays
                WHERE user_id = '${targetDbUser.id}' AND time_played >= '${thirtyDaysAgo.toISOString()}'
                GROUP BY 1
                ORDER BY 1 ASC
            `;

            const results: any[] = await prisma.$queryRawUnsafe(querySql);

            if (results.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no logged plays in the last 30 days.`)
                    .build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            // Fill in missing days with 0
            const completeData = [];
            let currentDate = new Date(thirtyDaysAgo.toISOString().split('T')[0]); // Start at beginning of 30 days ago
            const today = new Date();

            const resultMap = new Map();
            for (const r of results) {
                const dateStr = new Date(r.day_start).toISOString().split('T')[0];
                resultMap.set(dateStr, r.playcount);
            }

            while (currentDate <= today) {
                const dateStr = currentDate.toISOString().split('T')[0];
                completeData.push({
                    date: dateStr,
                    playcount: resultMap.get(dateStr) || 0
                });
                currentDate.setDate(currentDate.getDate() + 1);
            }

            const labels = completeData.map(d => d.date.substring(5)); // just MM-DD
            const values = completeData.map(d => d.playcount);

            const chartUrl = buildQuickChartUrl('Daily Scrobbles (Last 30 Days)', labels, values, '#5865F2', 'line');
            
            const totalPlays = values.reduce((a, b) => a + b, 0);
            const avgPlays = Math.round(totalPlays / completeData.length);

            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`## 30-Day Overview for ${userSettings.displayName}\nTotal: **${totalPlays.toLocaleString()}** | Avg: **${avgPlays}**/day`)
                .setImage(chartUrl);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to load overview: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
