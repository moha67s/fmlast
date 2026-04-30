import {
  ComponentsV2 } from '../../utils/ComponentsV2';
import { QueueManager,
  GuildQueue } from './QueueManager';
import { YoutubeResult } from '../api/Youtube';
import { createProgressBar,
  formatDuration } from '../../utils/formatDuration';
import { Message,
  TextChannel,
  ComponentType,
  ButtonStyle
} from "discord.js";

export class MusicUIController {

    /**
     * Builds and sends the playback UI to the queue's text channel.
     * Replaces the old message if it exists.
     */
    static async sendPlaybackUI(guildId: string, track: YoutubeResult): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        if (queue.nowPlayingMessage) {
            queue.nowPlayingMessage.delete().catch(() => { });
            queue.nowPlayingMessage = undefined;
        }

        // Fast check for lyrics
        queue.hasLyrics = false;
        const artist = track.artistName || (track.channelTitle || '').replace(' - Topic', '') || 'Unknown Artist';
        const title = track.trackTitle || (track.title || '').replace(/\(.*?\)|\[.*?\]/g, '').trim() || 'Unknown Track';
        const duration = track.durationSeconds || 0;

        try {
            const params = new URLSearchParams({
                artist_name: artist,
                track_name: title,
                ...(duration ? { duration: String(duration) } : {})
            });
            const res = await fetch(`https://lrclib.net/api/get?${params}`, {
                headers: { 'User-Agent': 'fm-discord-bot/1.0' }
            });
            if (res.ok) {
                queue.hasLyrics = true;
            }
        } catch { }

        const ui = await this.buildPlaybackUI(guildId, track, 0, false);

        try {
            const msg = await queue.textChannel.send(ui);
            queue.nowPlayingMessage = msg;
        } catch (err) {
            console.error('[MusicUIController] Failed to send playback UI:', err);
        }
    }

    /**
     * Updates the existing now playing message (progress bar, pause state, etc)
     */
    static async updateNowPlayingMessage(guildId: string): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue || !queue.nowPlayingMessage || !queue.isPlaying) return;

        const track = queue.currentTrack;
        if (!track) return;

        let elapsedMs = queue.player?.position ?? 0;
        if (!queue.isPaused && queue.lastUpdate) {
            elapsedMs += (Date.now() - queue.lastUpdate);
        }
        const elapsed = Math.floor(elapsedMs / 1000);

        const ui = await this.buildPlaybackUI(guildId, track, elapsed, queue.isPaused);

        try {
            await queue.nowPlayingMessage.edit(ui);
        } catch (err) {
            // Message might be deleted
            if (queue.progressInterval) {
                clearInterval(queue.progressInterval);
                queue.progressInterval = undefined;
            }
        }
    }

    private static async buildPlaybackUI(guildId: string, track: YoutubeResult, elapsed: number, isPaused: boolean) {
        const queue = QueueManager.getQueue(guildId);
        const total = track.durationSeconds || 0;
        const progressBar = createProgressBar(elapsed, total);

        const timeInfo = `\`${formatDuration(elapsed)} / ${track.duration || '0:00'}\``;

        let repeatInfo = '';
        let autoplayInfo = '';
        if (queue) {
            if (queue.repeatMode === 'one') repeatInfo = ' 🔂';
            else if (queue.repeatMode === 'all') repeatInfo = ' 🔁';
            if (queue.autoplay) autoplayInfo = ' 🤖';
        }

        const scrobbleInfo = (track as any).scrobbleCount ? ` •  Scrobbling for ${(track as any).scrobbleCount} users` : '';
        const statsLine = track.statsText ? (track.statsText.startsWith('\n') ? track.statsText : `\n${track.statsText}`) : '';

        const coverUrl = track.artworkUrl || track.thumbnail || 'https://i.imgur.com/Gis9d79.png';
        const artistDisplay = track.artistName || (track.channelTitle || '').replace(' - Topic', '') || 'Unknown Artist';
        const titleDisplay = (track.trackTitle || track.title || 'Unknown Track').replace(/\[.*?\]|\(.*?\)/g, '').trim();

        let embedColor = isPaused ? 0xFFA500 : 0x1DB954;
        if (!isPaused && track.requesterId) {
            const { prisma } = await import('../../database/client');
            const { SettingService } = await import('../bot/SettingService');
            const dbAuthor = await prisma.user.findUnique({ where: { discordId: track.requesterId } });
            if (dbAuthor) embedColor = SettingService.resolveAccentColor(dbAuthor);
        }

        const builder = new ComponentsV2()
            .setAccent(embedColor)
            .addThumbnail(coverUrl,
                `###  ${artistDisplay} - ${titleDisplay}${repeatInfo}${autoplayInfo}\n` +
                `${statsLine ? statsLine.trimStart() + '\n\n' : ''}` +
                `${progressBar} ${timeInfo}\n\n` +
                `-# Added to queue by ${track.requesterName || 'Unknown'}${scrobbleInfo}`
            )
            .addSeparator();

        const repeatEmojis: Record<string, string> = { 'off': '🔁', 'one': '🔂', 'all': '🔁' };
        const repeatMode = queue?.repeatMode || 'off';

        // ROW 1: Playback Controls
        builder.addRow([
            { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '', emoji: isPaused ? '▶️' : '⏸️', custom_id: isPaused ? `mp-resume:${guildId}` : `mp-pause:${guildId}` },
            { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '', emoji: '⏭️', custom_id: `mp-skip:${guildId}` },
            { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '', emoji: repeatEmojis[repeatMode] || '🔁', custom_id: `mp-repeat:${guildId}` },
            { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '', emoji: '🔊', custom_id: `mp-volume:${guildId}` },
            { type: ComponentType.Button, style: ButtonStyle.Danger, label: '', emoji: '🛑', custom_id: `mp-stop:${guildId}` }
        ]);

        // ROW 2: Library & Info
        const row2: any[] = [
            { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '', emoji: '🔀', custom_id: `mp-shuffle:${guildId}` },
            { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '', emoji: '📄', custom_id: `mp-queue:${guildId}` },
            { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '', emoji: 'ℹ️', custom_id: `mp-trackinfo:${guildId}` },
            { type: ComponentType.Button, style: queue?.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary, label: '', emoji: '🤖', custom_id: `mp-autoplay:${guildId}` }
        ];
        if (queue?.hasLyrics) {
            row2.push({ type: ComponentType.Button, style: ButtonStyle.Primary, label: '', emoji: '🎤', custom_id: `mp-lyrics:${guildId}` });
        }
        builder.addRow(row2);

        // ROW 3: Effects Select Menu
        builder.addRow([{
            type: ComponentType.StringSelect,
            custom_id: `mp-filter-select:${guildId}`,
            placeholder: '✨ Apply Audio Filters...',
            options: [
                { label: 'Clear Filters', value: 'clear', emoji: '❌' },
                { label: 'Bassboost', value: 'bassboost', emoji: '🔊' },
                { label: 'Nightcore', value: 'nightcore', emoji: '⚡' },
                { label: 'Vaporwave', value: 'vaporwave', emoji: '🌊' },
                { label: 'Daycore', value: 'daycore', emoji: '🕰️' },
                { label: 'Tremolo', value: 'tremolo', emoji: '📳' },
                { label: 'Vibrato', value: 'vibrato', emoji: '〰️' },
                { label: 'Distortion', value: 'distortion', emoji: '💢' },
                { label: '8D', value: '8d', emoji: '🎧' },
                { label: 'Pop', value: 'pop', emoji: '🎸' },
                { label: 'Treble', value: 'treble', emoji: '🎼' },
            ]
        }]);

        return builder.build();
    }
}
