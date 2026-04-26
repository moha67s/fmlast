import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { QueueManager } from '../../services/music/QueueManager';
import { SlashCommandBuilder } from 'discord.js';

export default class JumpCommand extends BaseCommand {
    name = 'jump';
    description = 'Jump to a specific position in the queue';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description)
        .addIntegerOption(opt => opt.setName('position').setDescription('The position to jump to (1-based)').setRequired(true));

    async execute(interaction: any) {
        if (!interaction.guildId) return;
        const pos = interaction.options.getInteger('position');

        const track = QueueManager.jump(interaction.guildId, pos);
        if (track) {
            MusicPlayer.skip(interaction.guildId);
            await interaction.reply({ content: `⏭️ Jumped to position **${pos}**: ${track.title}` });
        } else {
            await interaction.reply({ content: '❌ Invalid position or no active queue.', ephemeral: true });
        }
    }
}
