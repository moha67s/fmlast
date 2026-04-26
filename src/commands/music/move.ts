import { BaseCommand } from '../../structures/BaseCommand';
import { QueueManager } from '../../services/music/QueueManager';
import { SlashCommandBuilder } from 'discord.js';

export default class MoveCommand extends BaseCommand {
    name = 'move';
    description = 'Move a track in the queue';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description)
        .addIntegerOption(opt => opt.setName('from').setDescription('Current position').setRequired(true))
        .addIntegerOption(opt => opt.setName('to').setDescription('New position').setRequired(true));

    async execute(interaction: any) {
        if (!interaction.guildId) return;
        const from = interaction.options.getInteger('from');
        const to = interaction.options.getInteger('to');

        const track = QueueManager.move(interaction.guildId, from, to);
        if (track) {
            await interaction.reply({ content: `✅ Moved **${track.title}** from #${from} to #${to}` });
        } else {
            await interaction.reply({ content: '❌ Invalid positions or no active queue.', ephemeral: true });
        }
    }
}
