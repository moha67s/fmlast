import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class ConfigurationCommand extends BaseCommand {
    name = 'configuration';
    description = 'Manage server-wide bot configuration';
    aliases = ['config'];

    slashData = new SlashCommandBuilder()
        .setName('configuration')
        .setDescription('Manage server-wide bot configuration')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const guild = interactionOrMessage.guild;
        if (!guild) {
            return isSlash ? interactionOrMessage.reply('❌ This command can only be used in a server.') : interactionOrMessage.reply('❌ This command can only be used in a server.');
        }

        const member = isSlash ? interactionOrMessage.member : interactionOrMessage.member;
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
            const reply = '❌ You need Manage Server permissions to use this command.';
            return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply({ ephemeral: true });
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // Note: fm2 might not have a Guild table yet, so we will use a static embed for parity 
            // until we add Guild models for custom prefixes.
            
            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`### Server Configuration for ${guild.name}\n\n**Prefix:** \`.\` *(Global default)*\n**Crowns:** Enabled\n**Now Playing Reactions:** Disabled\n\n*(Note: Interactive configuration dashboard is currently under construction in the backend migration!)*`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to load config: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);
        }
    }
}
