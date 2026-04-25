import {
    AudioPlayerStatus,
    createAudioResource,
    joinVoiceChannel,
    VoiceConnectionStatus,
    NoSubscriberBehavior,
    StreamType,
    entersState
} from '@discordjs/voice';
import { Youtube, YoutubeResult } from '../api/Youtube';
import { VoiceChannel, TextChannel, Message } from 'discord.js';
import { ScrobbleService } from './ScrobbleService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { createProgressBar, formatDuration } from '../../utils/formatDuration';
import { config } from '../../../config';
import { QueueManager, GuildQueue, RepeatMode } from './QueueManager';

const playLocks = new Map<string, Promise<void>>();
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 5000;

export class MusicPlayer {
    /**
     * Join a voice channel and set up the connection
     */
    static async join(guildId: string, voiceChannelId: string, textChannel: TextChannel): Promise<GuildQueue> {
        let queue = QueueManager.getQueue(guildId);

        if (!queue || !queue.connection || queue.connection.state.status === VoiceConnectionStatus.Disconnected) {
            const connection = joinVoiceChannel({
                channelId: voiceChannelId,
                guildId: guildId,
                adapterCreator: textChannel.guild.voiceAdapterCreator,
            });

            if (!queue) {
                queue = QueueManager.createQueue(guildId, textChannel, voiceChannelId, connection);
            } else {
                queue.connection = connection;
                connection.subscribe(queue.player!);
            }

            connection.on(VoiceConnectionStatus.Disconnected, async () => {
                console.warn(`[MusicPlayer] Voice connection lost for guild ${guildId}, attempting recovery...`);
                for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
                    try {
                        await Promise.race([
                            entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_BASE_DELAY_MS),
                            entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_BASE_DELAY_MS),
                            entersState(connection, VoiceConnectionStatus.Ready, RECONNECT_BASE_DELAY_MS),
                        ]);
                        console.log(`[MusicPlayer] Voice connection recovered for guild ${guildId} on attempt ${attempt}`);
                        return;
                    } catch {
                        console.warn(`[MusicPlayer] Voice reconnection attempt ${attempt}/${RECONNECT_ATTEMPTS} failed for guild ${guildId}`);
                    }
                }
                console.error(`[MusicPlayer] Reconnection failed for guild ${guildId}, cleaning up`);
                this.stop(guildId);
            });
        }

        return queue;
    }

    /**
     * Start playing or add to queue
     */
    static async play(guildId: string, track?: YoutubeResult): Promise<number> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return 0;

        if (track) {
            QueueManager.addTrack(guildId, track);
        }

        const prev = playLocks.get(guildId) ?? Promise.resolve();
        const next = prev.then(() => this.processQueue(guildId));
        const stored = next.catch(() => { });
        stored.finally(() => {
            if (playLocks.get(guildId) === stored) {
                playLocks.delete(guildId);
            }
        });
        playLocks.set(guildId, stored);

        return queue.tracks.length;
    }

    static skip(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue && queue.player) {
            this.stopProgressUpdate(guildId);
            queue.player.stop();
            return true;
        }
        return false;
    }

    static stop(guildId: string) {
        QueueManager.deleteQueue(guildId);
        return true;
    }

    static pause(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue && queue.player && !queue.isPaused) {
            queue.player.pause();
            queue.isPaused = true;
            this.stopProgressUpdate(guildId);
            this.updateNowPlayingMessage(guildId);
            return true;
        }
        return false;
    }

    static resume(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue && queue.player && queue.isPaused) {
            queue.player.unpause();
            queue.isPaused = false;
            this.startProgressUpdate(guildId);
            this.updateNowPlayingMessage(guildId);
            return true;
        }
        return false;
    }

    private static async processQueue(guildId: string, _skipCount = 0): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        if (_skipCount > 10) {
            console.warn(`[MusicPlayer] Too many consecutive failures for guild ${guildId}, stopping`);
            this.stop(guildId);
            return;
        }

        if (queue.isPlaying && queue.currentTrack) return; // Already playing

        this.stopProgressUpdate(guildId);

        let track = QueueManager.getNextTrack(guildId);

        if (!track) {
            track = QueueManager.getNextMixTrack(guildId);
        }

        if (!track) {
            queue.currentTrack = null;
            queue.isPlaying = false;

            const endBuilder = new ComponentsV2()
                .addText(`✅ **Queue concluded.** Disconnecting in 5 minutes if inactive.`);
            queue.textChannel.send(endBuilder.build()).catch(() => { });

            // Auto-disconnect
            if (queue.inactivityTimer) clearTimeout(queue.inactivityTimer);
            queue.inactivityTimer = setTimeout(() => {
                const refreshed = QueueManager.getQueue(guildId);
                if (refreshed && !refreshed.isPlaying && refreshed.tracks.length === 0) {
                    this.stop(guildId);
                }
            }, config.INACTIVITY_TIMEOUT * 1000);
            return;
        }

        if (queue.inactivityTimer) {
            clearTimeout(queue.inactivityTimer);
            queue.inactivityTimer = undefined;
        }

        try {
            console.log(`[MusicPlayer] 🎵 Fetching stream for: ${track.title}`);

            const { stream } = await Youtube.getAudioStream(track.url);

            const resource = createAudioResource(stream, {
                inputType: StreamType.OggOpus,
                inlineVolume: true
            });

            queue.currentTrack = track;
            queue.currentResource = resource;
            queue.isPlaying = true;
            queue.isPaused = false;

            const cleanUp = () => {
                queue.player?.removeAllListeners(AudioPlayerStatus.Idle);
                queue.player?.removeAllListeners('error');
            };

            const onIdle = () => {
                cleanUp();
                queue.isPlaying = false;
                // We don't clear currentTrack here so getNextTrack can see it for repeat logic
                this.processQueue(guildId).catch(err => console.error(`[MusicPlayer] Auto-play failed:`, err));
            };

            const onError = (error: any) => {
                cleanUp();
                console.error(`[MusicPlayer] Audio Player Error in guild ${guildId}:`, error);
                queue.textChannel.send(`⚠️ Error playing **${track!.title}**: ${error.message}`);
                queue.isPlaying = false;
                this.processQueue(guildId, _skipCount + 1).catch(() => { });
            };

            queue.player?.on(AudioPlayerStatus.Idle, onIdle);
            queue.player?.on('error', onError);

            queue.player?.play(resource);

            console.log(`[MusicPlayer] ✅ Playback started: ${track.title}`);

            // Render UI
            await this.sendPlaybackUI(guildId, track);

            // Start progress updates
            this.startProgressUpdate(guildId);

            // Scrobble
            if (track.artistName && track.trackTitle) {
                this.handleScrobbling(guildId, track);
            }

        } catch (err: any) {
            console.error(`[MusicPlayer] Critical Playback Error:`, err);
            queue.textChannel.send(`❌ **Playback Failed**: ${err.message || 'Unknown error'}. Skipping...`);
            queue.currentTrack = null;
            queue.isPlaying = false;
            this.processQueue(guildId, _skipCount + 1).catch(() => { });
        }
    }

    private static async sendPlaybackUI(guildId: string, track: YoutubeResult) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        const ui = this.buildPlaybackUI(guildId, track, 0, false);
        try {
            const msg = await queue.textChannel.send(ui);
            queue.nowPlayingMessage = msg;
        } catch (err) {
            console.error('[MusicPlayer] Failed to send playback UI:', err);
        }
    }

    private static buildPlaybackUI(guildId: string, track: YoutubeResult, elapsed: number, isPaused: boolean) {
        const queue = QueueManager.getQueue(guildId);
        const total = track.durationSeconds || 0;
        const progressBar = createProgressBar(elapsed, total);
        const timeInfo = `\`${formatDuration(elapsed)} / ${track.duration || '0:00'}\``;
        
        let repeatInfo = '';
        if (queue) {
            if (queue.repeatMode === 'one') repeatInfo = ' 🔂';
            else if (queue.repeatMode === 'all') repeatInfo = ' 🔁';
        }

        const scrobbleInfo = (track as any).scrobbleCount ? ` • 🚀 Scrobbling for ${(track as any).scrobbleCount} users` : '';
        const statsLine = track.statsText ? (track.statsText.startsWith('\n') ? track.statsText : `\n${track.statsText}`) : '';

        const builder = new ComponentsV2()
            .setAccent(isPaused ? 0xFFA500 : 0x1DB954)
            .addThumbnail(track.artworkUrl || track.thumbnail,
                `### 🎵 ${track.artistName || 'Various Artists'} - ${(track.trackTitle || track.title).replace(/\[.*?\]|\(.*?\)/g, '')}${repeatInfo}\n` +
                `**${track.channelTitle}**${statsLine}\n\n` +
                `${progressBar} ${timeInfo}\n\n` +
                `-# Added to queue by ${track.requesterName || 'Unknown'}${scrobbleInfo}`
            )
            .addSeparator();

        const repeatLabels: Record<string, string> = { 'off': '🔁 Off', 'one': '🔂 One', 'all': '🔁 All' };
        const repeatMode = queue?.repeatMode || 'off';

        builder.addRow([
            { type: 2, style: 2, label: isPaused ? '▶️ Resume' : '⏸️ Pause', custom_id: isPaused ? `mp-resume:${guildId}` : `mp-pause:${guildId}` },
            { type: 2, style: 2, label: '⏭️ Skip', custom_id: `mp-skip:${guildId}` },
            { type: 2, style: 2, label: repeatLabels[repeatMode] || '🔁 Repeat', custom_id: `mp-repeat:${guildId}` },
            { type: 2, style: 4, label: '🛑 Stop', custom_id: `mp-stop:${guildId}` }
        ]);

        return builder.build();
    }

    private static startProgressUpdate(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        this.stopProgressUpdate(guildId);

        queue.progressInterval = setInterval(() => {
            this.updateNowPlayingMessage(guildId);
        }, 15000);
    }

    private static stopProgressUpdate(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue?.progressInterval) {
            clearInterval(queue.progressInterval);
            queue.progressInterval = undefined;
        }
    }

    public static async updateNowPlayingMessage(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue || !queue.nowPlayingMessage || !queue.isPlaying) return;

        const track = queue.currentTrack;
        if (!track) return;

        const elapsed = queue.currentResource ? Math.floor(queue.currentResource.playbackDuration / 1000) : 0;
        const ui = this.buildPlaybackUI(guildId, track, elapsed, queue.isPaused);

        try {
            await queue.nowPlayingMessage.edit(ui);
        } catch (err) {
            // Message might be deleted
            this.stopProgressUpdate(guildId);
        }
    }
    private static async handleScrobbling(guildId: string, track: YoutubeResult) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;
        try {
            const guild = queue.textChannel.guild;
            const voiceChannel = await guild.channels.fetch(queue.voiceChannelId) as VoiceChannel;
            if (voiceChannel) {
                // Ensure members are in cache
                await guild.members.fetch(); 
                const listeners = voiceChannel.members.filter(m => !m.user.bot).map(m => m.id);
                
                const art = track.artistName || track.channelTitle.replace(' - Topic', '');
                const tit = track.trackTitle || track.title;

                if (listeners.length > 0 && art && tit) {
                    const res = await ScrobbleService.scrobbleForUsers(listeners, { artist: art, track: tit });
                    const successCount = res.filter(r => r.status === 'fulfilled').length;
                    (track as any).scrobbleCount = successCount;
                    this.updateNowPlayingMessage(guildId);
                    this.updateNowPlayingMessage(guildId);
                }
            }
        } catch (err: any) {
            console.error(`[MusicPlayer] Scrobble error:`, err.message);
        }
    }
}
