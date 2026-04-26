import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder } from 'discord.js';

export default class NowPlayingCommand extends BaseCommand {
    name = 'nowplaying';
    description = 'Refresh the Now Playing message';
    aliases = ['np'];

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description);

    async execute(interaction: any) {
        if (!interaction.guildId) return;
        
        // This will trigger a new NP message and delete the old one because of sendPlaybackUI logic
        // But since we want to "refresh" it in place if possible, we just call updateNowPlayingMessage
        // or re-send it. Let's re-send it to make it jump to the bottom.
        
        const { QueueManager } = await import('../../services/music/QueueManager');
        const queue = QueueManager.getQueue(interaction.guildId);
        
        if (!queue?.currentTrack) {
            return interaction.reply({ content: '❌ Nothing is currently playing.', ephemeral: true });
        }

        // Force a new message
        if (queue.nowPlayingMessage) {
            queue.nowPlayingMessage.delete().catch(() => {});
            queue.nowPlayingMessage = undefined;
        }

        await MusicPlayer.updateNowPlayingMessage(interaction.guildId);
        await interaction.reply({ content: '✅ NP Refreshed.', ephemeral: true });
    }
}
