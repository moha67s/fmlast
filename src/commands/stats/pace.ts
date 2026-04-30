import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { LastFM } from '../../services/api/LastFM';

export default class PaceCommand extends BaseCommand {
    name = 'pace';
    description = 'View your scrobbling pace and projections';
    aliases = ['pa'];

    slashData = new SlashCommandBuilder()
        .setName('pace')
        .setDescription('View scrobbling pace and projections')
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
            // 1. Get info from Last.fm (for registration date and total playcount)
            const lfmInfo = await LastFM.getUserInfo(targetDbUser.lastfmUsername!, targetDbUser.lastfmSessionKey);
            const totalPlaycount = parseInt(lfmInfo.playcount, 10);
            const registrationUts = parseInt(lfmInfo.registered?.uts || lfmInfo.registered?.['#text'], 10);

            if (!registrationUts) {
                throw new Error("Could not find registration date.");
            }

            const nowUts = Math.floor(Date.now() / 1000);
            const accountAgeDays = (nowUts - registrationUts) / 86400;
            const pacePerDay = totalPlaycount / accountAgeDays;

            // 2. Projections
            const nextMilestone = Math.ceil((totalPlaycount + 1) / 10000) * 10000;
            const remainingToMilestone = nextMilestone - totalPlaycount;
            const daysToMilestone = remainingToMilestone / pacePerDay;
            const milestoneDate = new Date(Date.now() + daysToMilestone * 86400 * 1000);

            // 3. Build Response
            const builder = new ComponentsV2().setAccent(embedColor);
            builder.addText(`### Scrobbling Pace for ${userSettings.displayName}`);

            builder.addText(`📊 **Overall Stats:**`);
            builder.addText(`• Total Scrobbles: **${totalPlaycount.toLocaleString()}**`);
            builder.addText(`• Account Age: **${Math.floor(accountAgeDays).toLocaleString()}** days`);
            builder.addText(`• Average Pace: **${pacePerDay.toFixed(2)}** scrobbles/day`);

            builder.addText(`\n🚀 **Projections:**`);
            builder.addText(`• Next Milestone: **${nextMilestone.toLocaleString()}**`);
            builder.addText(`• Remaining: **${remainingToMilestone.toLocaleString()}** scrobbles`);
            builder.addText(`• Estimated Date: <t:${Math.floor(milestoneDate.getTime() / 1000)}:D> (**<t:${Math.floor(milestoneDate.getTime() / 1000)}:R>**)`);

            // Weekly Pace (from DB)
            const sevenDaysAgo = new Date(Date.now() - 7 * 86400 * 1000);
            const weeklyCount = await prisma.userPlay.count({
                where: {
                    userId: targetDbUser.id,
                    timePlayed: { gte: sevenDaysAgo }
                }
            });
            const weeklyPace = weeklyCount / 7;

            builder.addText(`\n📈 **Recent Activity:**`);
            builder.addText(`• Last 7 Days: **${weeklyCount.toLocaleString()}** scrobbles`);
            builder.addText(`• Recent Pace: **${weeklyPace.toFixed(2)}** scrobbles/day`);

            if (weeklyPace > pacePerDay) {
                builder.addText(`🔥 You are scrobbling **${((weeklyPace / pacePerDay - 1) * 100).toFixed(1)}% faster** than your average!`);
            } else {
                builder.addText(`💤 You are scrobbling **${((1 - weeklyPace / pacePerDay) * 100).toFixed(1)}% slower** than your average.`);
            }

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to calculate pace.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
