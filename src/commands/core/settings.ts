import {
  BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";

export default class SettingsCommand extends BaseCommand {
    name = 'settings';
    description = 'Configure your personal bot settings';
    aliases = ['config', 'conf'];

    slashData = new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Configure your personal bot settings');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {

        const user = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        const guild = interactionOrMessage.guild;

        const dbUser = await prisma.user.findUnique({ where: { discordId: user.id } });
        if (!dbUser) {
            const reply = '❌ You must be registered to use this command. Use `/login`.';
            return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
        }

        const activeImport = await prisma.importJob.findFirst({
            where: { userId: dbUser.id, status: { in: ['PENDING', 'PROCESSING'] } },
            orderBy: { createdAt: 'desc' }
        });

        const lfmAccount = dbUser.lastfmUsername || 'None';
        const lfmUrl = `https://last.fm/user/${encodeURIComponent(lfmAccount)}`;

        const builder = new ComponentsV2()
            .setAccent(0x5865F2) // hsla(218, 100%, 63.3%, 1) corresponds to Blurple-ish
            .addText(`## bot user settings — ${user.displayName}`)
            .addSeparator()
            .addText(`Connected with Last.fm account [${lfmAccount}](${lfmUrl}). Use \`/login\` to change.`)
            .addText(`For server-wide settings, use \`.configuration\`.`);

        if (activeImport) {
            const progress = Math.round((activeImport.scrobbledTracks / activeImport.totalTracks) * 100);
            builder.addText(`**History Import Active**: ${activeImport.scrobbledTracks.toLocaleString()} / ${activeImport.totalTracks.toLocaleString()} (${progress}%)`);
        }

        builder.addRow([
            {
                type: ComponentType.StringSelect, // String Select Menu
                custom_id: 'user-setting-picker',
                placeholder: 'Select setting to view or change',
                options: [
                    { label: 'Music bot scrobbling', value: 'us-view-BotScrobbling', description: 'Toggle automatically scrobbling other music bots' },
                    { label: 'History Import', value: 'us-view-HistoryImport', description: 'View progress and status of your music history imports' }
                ]
            }
        ]);

        const payload = builder.build();
        if (isSlash) {
            if (interactionOrMessage.replied || interactionOrMessage.deferred) {
                await interactionOrMessage.editReply(payload);
            } else {
                await interactionOrMessage.reply({ ...payload, ephemeral: true });
            }
        } else {
            await interactionOrMessage.reply(payload);
        }
    }
}
