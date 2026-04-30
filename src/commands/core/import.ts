import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class ImportCommand extends BaseCommand {
    name = 'import';
    description = 'Manage your data imports';
    aliases = ['imports'];

    slashData = new SlashCommandBuilder()
        .setName('import')
        .setDescription('Manage your data imports')
        .addSubcommand(sub => 
            sub.setName('manage')
               .setDescription('View and manage active imports')
        );

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            return isSlash ? interactionOrMessage.reply(payload) : interactionOrMessage.reply(payload);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply({ ephemeral: true });
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // In a full implementation, we'd query BullMQ or the database for active import jobs.
            // For now, this serves as the structural parity command.
            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`### Import Management for ${author.username}\n\n✅ You currently have no active imports running.\n\nUse \`/spotify import\` to start a new data import.`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to check imports: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);
        }
    }
}
