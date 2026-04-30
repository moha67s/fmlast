import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class LogoutCommand extends BaseCommand {
    name = 'logout';
    description = 'Unlink your Last.fm account from the bot';
    aliases = ['lo'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('logout')
        .setDescription('Unlink your Last.fm account from the bot');

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {

        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        if (!dbUser?.lastfmSessionKey) {
            const payload = new ComponentsV2()
                .setAccent(0xff0000) // Red
                .addText(`❌ **Not Linked**\nYou aren't currently linked to a Last.fm account.`)
                .build();

            if (isSlash) {
                await interactionOrMessage.reply({ ...payload, ephemeral: true });
            } else {
                await interactionOrMessage.channel.send(payload);
            }
            return;
        }

        // Unlink the account
        await prisma.user.update({
            where: { discordId: userId },
            data: {
                lastfmUsername: null,
                lastfmSessionKey: null,
                lastfmRequestToken: null
            }
        });

        const payload = new ComponentsV2()
            .setAccent(0x5865F2) // Blurple
            .addText(`✅ **Successfully Logged Out**\nYour Last.fm account (**${dbUser.lastfmUsername}**) has been unlinked from the bot.`)
            .build();

        if (isSlash) {
            await interactionOrMessage.reply({ ...payload, ephemeral: true });
        } else {
            await interactionOrMessage.channel.send(payload);
        }
    }
}
