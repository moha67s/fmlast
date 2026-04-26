import { BaseCommand } from '../../structures/BaseCommand';
import { QueueManager } from '../../services/music/QueueManager';
import { SlashCommandBuilder } from 'discord.js';

export default class RemoveCommand extends BaseCommand {
    name = 'remove';
    description = 'Remove a track from the queue';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description)
        .addIntegerOption(opt => opt.setName('position').setDescription('The position to remove').setRequired(true));

    async execute(interaction: any) {
        if (!interaction.guildId) return;
        const pos = interaction.options.getInteger('position');

        const track = QueueManager.removeTrack(interaction.guildId, pos);
        if (track) {
            await interaction.reply({ content: `✅ Removed **${track.title}** from the queue.` });
        } else {
            await interaction.reply({ content: '❌ Invalid position or no active queue.', ephemeral: true });
        }
    }
}
