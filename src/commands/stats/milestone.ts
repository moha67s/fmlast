import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class MilestoneCommand extends BaseCommand {
    name = 'milestone';
    description = 'View your Nth scrobble';
    aliases = ['ms'];

    slashData = new SlashCommandBuilder()
        .setName('milestone')
        .setDescription('View your Nth scrobble')
        .addStringOption((opt: any) => 
            opt.setName('query')
                .setDescription('The milestone number (e.g. 1000) and optional user')
                .setRequired(true)
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

        // Parse the number from remaining search value
        const { amount: num } = SettingService.getAmount(userSettings.searchValue, 0, 1000000);

        if (num <= 0) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Please specify a valid milestone number (e.g. `!ms 1000`).').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        try {
            // 1. Get total scrobbles
            const totalCount = await prisma.userPlay.count({
                where: { userId: targetDbUser.id }
            });

            if (num > totalCount) {
                const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ **${userSettings.displayName}** only has **${totalCount.toLocaleString()}** scrobbles in the database.`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            // 2. Fetch the specific scrobble
            const play = await prisma.userPlay.findMany({
                where: { userId: targetDbUser.id },
                orderBy: { timePlayed: 'asc' },
                skip: num - 1,
                take: 1
            });

            if (play.length === 0) {
                const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Milestone not found.').build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const p = play[0];
            const artistUrl = `https://www.last.fm/music/${encodeURIComponent(p.artistName)}`;
            const trackUrl = `${artistUrl}/_/${encodeURIComponent(p.trackName)}`;

            const builder = new ComponentsV2().setAccent(embedColor);
            builder.addText(`### Milestone #${num.toLocaleString()} for ${userSettings.displayName}`);
            builder.addText(`🎶 **[${p.trackName}](${trackUrl})** by **[${p.artistName}](${artistUrl})**`);
            if (p.albumName) builder.addText(`💿 From the album *${p.albumName}*`);
            builder.addText(`📅 Listened <t:${Math.floor(p.timePlayed.getTime() / 1000)}:R> (<t:${Math.floor(p.timePlayed.getTime() / 1000)}:f>)`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch milestone.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
