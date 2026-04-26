import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder } from 'discord.js';

export default class ShuffleCommand extends BaseCommand {
    name = 'shuffle';
    description = 'Shuffle the current music queue';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description);

    async execute(interaction: any) {
        if (!interaction.guildId) return;

        const success = MusicPlayer.shuffle(interaction.guildId);
        if (success) {
            await interaction.reply({ content: '🔀 Queue shuffled!' });
        } else {
            await interaction.reply({ content: '❌ No active queue to shuffle.', ephemeral: true });
        }
    }
}
