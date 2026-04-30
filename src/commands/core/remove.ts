import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class RemoveCommand extends BaseCommand {
    name = 'remove';
    description = 'Delete your account data and disconnect Last.fm';
    aliases = ['logout', 'unlink'];

    slashData = new SlashCommandBuilder()
        .setName('forgetme')
        .setDescription('Delete your account data and disconnect Last.fm');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;

        const dbUser = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbUser) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ You are not registered.').build();
            return isSlash ? interactionOrMessage.reply({ ...payload, ephemeral: true }) : interactionOrMessage.reply(payload);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply({ ephemeral: true });
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // Delete user data. Cascading should handle related records if set up, 
            // but we can just delete the user record.
            await prisma.user.delete({
                where: { id: dbUser.id }
            });

            const builder = new ComponentsV2()
                .setAccent(0xff0000)
                .addText(`✅ Successfully unlinked Last.fm and deleted your bot account data.`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to remove account: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
