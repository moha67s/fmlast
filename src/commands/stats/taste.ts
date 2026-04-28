import { BaseCommand } from '../../structures/BaseCommand';
import { FriendService } from '../../services/bot/FriendService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder } from 'discord.js';
import { SettingService } from '../../services/bot/SettingService';
import { prisma } from '../../database/client';

export default class TasteCommand extends BaseCommand {
    name = 'taste';
    description = 'Compare your musical taste affinity with a friend';

    slashData = new SlashCommandBuilder()
        .setName('taste')
        .setDescription('Compare your musical taste affinity with a friend')
        .addStringOption(opt => opt.setName('query').setDescription('The user to compare with').setRequired(true));

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
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

        if (targetDbUser.id === dbAuthor.id) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ You have a 100% taste match with yourself!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        try {
            const result = await FriendService.getTasteAffinity(dbAuthor.id, targetDbUser.id);
            
            let color = 0x8a2be2; // Purple default
            if (result.percent > 85) color = 0x00ff00; // Green for high match
            else if (result.percent > 50) color = 0xffff00; // Yellow for mid
            else if (result.percent < 20) color = 0xff0000; // Red for low

            let desc = result.sharedArtists.length === 0 
                ? "You two literally have completely different taste. Nothing in common!" 
                : `You share **${result.sharedArtists.length}** artists in your top 150!`;

            if (result.sharedArtists.length > 0) {
                desc += `\n\n**Top Overlapping Artists:**\n`;
                for (let i = 0; i < Math.min(result.sharedArtists.length, 10); i++) {
                    const artist = result.sharedArtists[i];
                    desc += `🎧 **${artist.name}**\n`;
                }
            }

            const builder = new ComponentsV2()
                .setAccent(color)
                .addText(`### 🎼 Taste Affinity: **${result.percent}%**\n**${result.u1Name}** & **${result.u2Name}**\n\n${desc}`);

            const payload = builder.build();

            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ **Error:** ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
