import {
  BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { TextChannel,
  ButtonStyle,
  ComponentType
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class LoginCommand extends BaseCommand {
    name = 'login';
    description = 'Link your Last.fm account for private stats';
    aliases = ['l'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('login')
        .setDescription('Link your Last.fm account for private stats');

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {

        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

        // Check if already fully linked
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        let content = "You aren't currently linked to a Last.fm account. Click the button below to start the connection process.";
        if (dbUser?.lastfmSessionKey) {
            content = `You are currently linked as **${dbUser.lastfmUsername}**. To change your account or re-link, click the button below.`;
        }

        const payload = new ComponentsV2()
            .setAccent(0x5865F2) // Blurple
            .addText(content)
            .addRow([
                {
                    type: ComponentType.Button,
                    style: ButtonStyle.Secondary,
                    custom_id: "user-login",
                    label: "Connect Last.fm account"
                },
                {
                    type: ComponentType.Button,
                    style: ButtonStyle.Link,
                    url: "https://www.last.fm/join",
                    label: "Sign up"
                }
            ])
            .build();

        if (isSlash) {
            await interactionOrMessage.reply({ ...payload, ephemeral: true });
        } else {
            await interactionOrMessage.channel.send(payload);
        }
    }
}
