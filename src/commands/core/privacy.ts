import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class PrivacyCommand extends BaseCommand {
    name = 'privacy';
    description = 'Manage your Global WhoKnows privacy setting';
    aliases = [];

    slashData = new SlashCommandBuilder()
        .setName('privacy')
        .setDescription('Manage your Global WhoKnows privacy setting')
        .addBooleanOption(opt => 
            opt.setName('visible')
                .setDescription('Should you be visible in Global WhoKnows?')
                .setRequired(true)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        let visible = true;

        if (isSlash) {
            visible = interactionOrMessage.options.getBoolean('visible');
        } else {
            if (!args || args.length === 0) {
                return interactionOrMessage.reply('❌ Please specify `true` or `false`. Example: `.privacy false`');
            }
            visible = args[0].toLowerCase() === 'true';
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbUser) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ You must be registered to use this command. Use `/login`.').build();
            return isSlash ? interactionOrMessage.reply({ ...payload, ephemeral: true }) : interactionOrMessage.reply(payload);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply({ ephemeral: true });
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            const settings = (dbUser.settings as any) || {};
            settings.gwkVisible = visible;

            await prisma.user.update({
                where: { id: dbUser.id },
                data: { settings }
            });

            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`✅ Global WhoKnows visibility set to: **${visible ? 'Visible' : 'Hidden'}**`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to update privacy: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
