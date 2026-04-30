import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import * as os from 'os';
import { SettingService } from '../../services/bot/SettingService';

export default class BotStatsCommand extends BaseCommand {
    name = 'botstats';
    description = 'View global statistics for the fm2 bot';
    aliases = ['stats', 'system'];

    slashData = new SlashCommandBuilder()
        .setName('botstats')
        .setDescription('View global statistics for the fm2 bot');

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        if (isSlash) await interactionOrMessage.deferReply();
        else try { await interactionOrMessage.channel.sendTyping(); } catch { }

        try {
            // Run counts in parallel
            const [userCount, guildCount, artistCount, trackCount, albumCount, scrobbleCount] = await Promise.all([
                prisma.user.count(),
                prisma.guild.count(),
                prisma.artist.count(),
                prisma.track.count(),
                prisma.album.count(),
                prisma.userPlay.count()
            ]);

            const uptime = process.uptime();
            const days = Math.floor(uptime / 86400);
            const hours = Math.floor((uptime % 86400) / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const uptimeStr = `${days}d ${hours}h ${minutes}m`;

            const totalMemory = os.totalmem();
            const freeMemory = os.freemem();
            const usedMemory = totalMemory - freeMemory;
            const memoryStr = `${(usedMemory / 1024 / 1024 / 1024).toFixed(2)} GB / ${(totalMemory / 1024 / 1024 / 1024).toFixed(2)} GB`;

            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`### 📊 fm2 Global Statistics`)
                .addText(`**System**\n- Uptime: ${uptimeStr}\n- Memory: ${memoryStr}`)
                .addSeparator()
                .addText(`**Database Index**\n- Users: **${userCount.toLocaleString()}**\n- Servers: **${guildCount.toLocaleString()}**\n- Total Scrobbles: **${scrobbleCount.toLocaleString()}**`)
                .addSeparator()
                .addText(`**Catalog**\n- Artists: **${artistCount.toLocaleString()}**\n- Albums: **${albumCount.toLocaleString()}**\n- Tracks: **${trackCount.toLocaleString()}**`);

            const payload = builder.build();
            
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to retrieve bot statistics.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);
        }
    }
}
