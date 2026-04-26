import { BaseCommand } from '../../structures/BaseCommand';
import { QueueManager } from '../../services/music/QueueManager';
import { SlashCommandBuilder } from 'discord.js';

export default class AutoplayCommand extends BaseCommand {
    name = 'autoplay';
    description = 'Toggle autoplay (related songs will be added when queue ends)';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description);

    async execute(interaction: any) {
        if (!interaction.guildId) return;
        const queue = QueueManager.getQueue(interaction.guildId);
        
        if (!queue) {
            return interaction.reply({ content: '❌ No active queue.', ephemeral: true });
        }

        queue.autoplay = !queue.autoplay;
        await interaction.reply({ content: `🎵 Autoplay is now **${queue.autoplay ? 'Enabled' : 'Disabled'}**.` });
    }
}
