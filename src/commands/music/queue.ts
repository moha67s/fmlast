import {
  BaseCommand } from '../../structures/BaseCommand';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder,
  ChatInputCommandInteraction,
  Message,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { QueueManager } from '../../services/music/QueueManager';

export default class QueueCommand extends BaseCommand {
    name = 'queue';
    description = 'Display the current music queue';
    aliases = ['q'];

    slashData = new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Display the current music queue');

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {

        const guildId = interactionOrMessage.guildId;
        if (!guildId) return;

        const queue = QueueManager.getQueue(guildId);
        if (!queue || (!queue.currentTrack && queue.tracks.length === 0)) {
            const builder = new ComponentsV2().addText('ℹ️ The queue is currently empty.');
            if (isSlash) await interactionOrMessage.reply({ ...builder.build(), ephemeral: true });
            else await interactionOrMessage.reply(builder.build());
            return;
        }

        const renderQueue = (page: number) => {
            const itemsPerPage = 10;
            const totalPages = Math.max(1, Math.ceil(queue.tracks.length / itemsPerPage));
            const start = page * itemsPerPage;
            const end = start + itemsPerPage;
            const pageTracks = queue.tracks.slice(start, end);

            let description = '';
            if (queue.currentTrack) {
                description += `**Now Playing:**\n[${queue.currentTrack.title}](${queue.currentTrack.url}) | \`${queue.currentTrack.duration}\`\n\n`;
            }

            if (queue.tracks.length > 0) {
                description += `**Up Next:**\n`;
                description += pageTracks.map((track, i) => `${start + i + 1}. [${track.title}](${track.url}) | \`${track.duration}\``).join('\n');
            } else {
                description += '*No more tracks in queue.*';
            }

            let repeatStatus = 'Off';
            if (queue.repeatMode === 'one') repeatStatus = '🔂 Single';
            else if (queue.repeatMode === 'all') repeatStatus = '🔁 All';

            const builder = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(`## 🎧 Music Queue\n${description}`)
                .addSeparator()
                .addText(`**Tracks:** ${queue.tracks.length} | **Repeat:** ${repeatStatus} | **Page:** ${page + 1}/${totalPages}`);

            if (totalPages > 1) {
                builder.addRow([
                    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '◀️', customId: `q-prev:${page}`, disabled: page === 0 },
                    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '▶️', customId: `q-next:${page}`, disabled: page === totalPages - 1 }
                ]);
            }

            return builder.build();
        };

        const payload = renderQueue(0);
        let message: Message;

        if (isSlash) {
            await interactionOrMessage.reply({ ...payload, fetchReply: true });
            message = await interactionOrMessage.fetchReply() as Message;
        } else {
            message = await interactionOrMessage.reply(payload);
        }

        const collector = message.createMessageComponentCollector({
            filter: (i) => i.customId.startsWith('q-'),
            time: 60000
        });

        collector.on('collect', async (i) => {
            const [action, currentPageStr] = i.customId.split(':');
            let currentPage = parseInt(currentPageStr);

            if (action === 'q-prev') currentPage--;
            if (action === 'q-next') currentPage++;

            await i.update(renderQueue(currentPage));
        });
    }
}
