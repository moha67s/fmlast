import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class PlaysCommand extends BaseCommand {
    name = 'plays';
    description = 'View total scrobble count for a time period';
    aliases = [];

    slashData = new SlashCommandBuilder()
        .setName('plays')
        .setDescription('View total scrobble count for a time period')
        .addStringOption(opt => 
            opt.setName('period')
                .setDescription('Time period (e.g. weekly, monthly, yearly, alltime)')
                .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('query')
                .setDescription('User mention or username')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let periodStr = '';
        let query = '';

        if (isSlash) {
            periodStr = interactionOrMessage.options.getString('period') || 'alltime';
            query = interactionOrMessage.options.getString('query') || '';
        } else {
            const input = args ? args.join(' ') : '';
            // Basic extraction: if the first word looks like a period, use it.
            const parts = input.split(' ');
            if (parts.length > 0 && ['daily', 'weekly', 'monthly', 'yearly', 'alltime', 'overall'].includes(parts[0].toLowerCase())) {
                periodStr = parts.shift()!.toLowerCase();
                query = parts.join(' ');
            } else {
                periodStr = 'alltime';
                query = input;
            }
        }

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
            // Trigger a background sync so the DB is as fresh as possible
            triggerDeltaSync(targetDbUser.discordId);

            let fromDate: Date | null = null;
            let displayPeriod = 'overall';

            const now = new Date();
            if (periodStr === 'daily') {
                fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                displayPeriod = 'in the last 24 hours';
            } else if (periodStr === 'weekly' || periodStr === '7day') {
                fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                displayPeriod = 'in the last 7 days';
            } else if (periodStr === 'monthly' || periodStr === '1month') {
                fromDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                displayPeriod = 'in the last 30 days';
            } else if (periodStr === 'yearly' || periodStr === '12month') {
                fromDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
                displayPeriod = 'in the last 365 days';
            }

            let whereClause: any = { userId: targetDbUser.id };
            if (fromDate) {
                whereClause.timePlayed = { gte: fromDate };
            }

            const playCount = await prisma.userPlay.count({
                where: whereClause
            });

            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`**${userSettings.displayName}** has **${playCount.toLocaleString()}** plays ${displayPeriod}.`);
                
            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to count plays: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
