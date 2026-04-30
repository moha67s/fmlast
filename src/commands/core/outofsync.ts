import { BaseCommand } from '../../structures/BaseCommand';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

import { prisma } from '../../database/client';

export default class OutOfSyncCommand extends BaseCommand {
    name = 'outofsync';
    description = 'What to do if your Last.fm isn\'t up to date with Spotify';
    aliases = [];

    slashData = new SlashCommandBuilder()
        .setName('outofsync')
        .setDescription('What to do if your Last.fm isn\'t up to date with Spotify')
        .addBooleanOption(opt => 
            opt.setName('private')
                .setDescription('Show info privately?')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const isPrivate = isSlash ? (interactionOrMessage.options.getBoolean('private') ?? true) : false;

        const builder = new ComponentsV2()
            .setAccent(embedColor)
            .addText('## 🔄 Spotify scrobbles not syncing?')
            .addSeparator()
            .addText('If your Spotify plays are not showing up on Last.fm, try the following:')
            .addText('1. Go to your [Last.fm Applications Settings](https://www.last.fm/settings/applications)')
            .addText('2. Find **Spotify Scrobbling** and click **Disconnect**')
            .addText('3. Click **Connect** to link it again')
            .addText('4. Play a track on Spotify and see if it scrobbles')
            .addText('\n*Note: Last.fm occasionally has delays or outages with Spotify syncing. Usually, delayed scrobbles will appear within a few hours.*');

        const payload = builder.build();

        if (isSlash) {
            await interactionOrMessage.reply({ ...payload, ephemeral: isPrivate });
        } else {
            await interactionOrMessage.reply(payload);
        }
    }
}
