import { BaseCommand } from '../../structures/BaseCommand';
import { QueueManager } from '../../services/music/QueueManager';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { formatDuration } from '../../utils/formatDuration';

export default class TrackInfoCommand extends BaseCommand {
    name = 'trackinfo';
    description = 'Detailed information about the current track';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description);

    async execute(interaction: any) {
        if (!interaction.guildId) return;
        const queue = QueueManager.getQueue(interaction.guildId);
        
        if (!queue?.currentTrack) {
            return interaction.reply({ content: '❌ Nothing is currently playing.', ephemeral: true });
        }

        const track = queue.currentTrack;
        const player = queue.player;
        const pos = player ? player.position : 0;
        
        const builder = new ComponentsV2()
            .setAccent(0x1DB954)
            .addThumbnail(track.artworkUrl || track.thumbnail,
                `### ℹ️ Track Details\n` +
                `**Title:** [${track.trackTitle || track.title}](${track.url})\n` +
                `**Artist:** ${track.artistName || track.channelTitle}\n` +
                `**Duration:** \`${formatDuration(Math.floor(pos/1000))} / ${track.duration}\`\n` +
                `**Source:** ${(track as any).source || 'YouTube'}\n` +
                `**Requester:** ${track.requesterName || 'Unknown'}\n\n` +
                `**Queue:** ${queue.tracks.length} tracks remaining\n` +
                `**Repeat Mode:** ${queue.repeatMode.charAt(0).toUpperCase() + queue.repeatMode.slice(1)}\n` +
                `**Volume:** ${player ? player.volume : 100}%`
            );

        await interaction.reply(builder.build());
    }
}
