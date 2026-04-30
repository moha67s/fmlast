import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class LocalizationCommand extends BaseCommand {
    name = 'localization';
    description = 'Change your timezone and number format preferences';
    aliases = ['timezone'];

    slashData = new SlashCommandBuilder()
        .setName('localization')
        .setDescription('Change your timezone and number format preferences')
        .addStringOption(opt => 
            opt.setName('timezone')
                .setDescription('Timezone offset (e.g. UTC, UTC+2, UTC-5)')
                .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('number_format')
                .setDescription('Number format')
                .setRequired(false)
                .addChoices(
                    { name: 'Comma (1,000.00)', value: 'comma' },
                    { name: 'Dot (1.000,00)', value: 'dot' },
                    { name: 'Space (1 000,00)', value: 'space' },
                    { name: 'None (1000)', value: 'none' }
                )
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        let timezoneStr = '';
        let numberFormat = '';

        if (isSlash) {
            timezoneStr = interactionOrMessage.options.getString('timezone') || '';
            numberFormat = interactionOrMessage.options.getString('number_format') || '';
        } else {
            if (args && args.length > 0) {
                // simple logic for text command
                const joined = args.join(' ').toLowerCase();
                if (['comma', 'dot', 'space', 'none'].includes(joined)) {
                    numberFormat = joined;
                } else {
                    timezoneStr = joined;
                }
            }
        }

        if (!timezoneStr && !numberFormat) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Please specify a timezone or number format to change.').build();
            return isSlash ? interactionOrMessage.reply({ ...payload, ephemeral: true }) : interactionOrMessage.reply(payload);
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
            
            let updates = [];
            if (timezoneStr) {
                settings.timezone = timezoneStr;
                updates.push(`Timezone set to **${timezoneStr}**`);
            }
            if (numberFormat) {
                settings.numberFormat = numberFormat;
                updates.push(`Number format set to **${numberFormat}**`);
            }

            await prisma.user.update({
                where: { id: dbUser.id },
                data: { settings }
            });

            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`✅ Localization settings updated:\n- ${updates.join('\n- ')}`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to update localization: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
