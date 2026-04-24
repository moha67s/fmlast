import {
    AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    joinVoiceChannel,
    VoiceConnection,
    VoiceConnectionStatus,
    getVoiceConnection,
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
import fs from 'fs';
import path from 'path';

// Railway/Production Cookie Sync & Sanitization:
const COOKIES_FILE = path.join(process.cwd(), 'cookies.txt');
const rawEnvCookie = process.env.YOUTUBE_COOKIES?.replace(/^["']|["']$/g, '').trim();

if (rawEnvCookie) {
    try {
        let cookieContent: string;
        if (rawEnvCookie.startsWith('# Netscape HTTP Cookie File')) {
            const sanitized: string[] = [];
            for (const raw of rawEnvCookie.split('\n')) {
                const line = raw.trimEnd();
                if (line.startsWith('#') || line === '') {
                    sanitized.push(line);
                    continue;
                }
                const fields = line.split('\t').length;
                if (fields === 7) sanitized.push(line);
            }
            cookieContent = sanitized.join('\n');
        } else {
            // Convert semicolon-separated cookies to Netscape format
            const lines = ['# Netscape HTTP Cookie File'];
            for (const part of rawEnvCookie.split(';')) {
                const eq = part.indexOf('=');
                if (eq < 0) continue;
                const name = part.slice(0, eq).trim();
                const value = part.slice(eq + 1).trim();
                if (name) lines.push(`.youtube.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
            }
            cookieContent = lines.join('\n');
        }
        fs.writeFileSync(COOKIES_FILE, cookieContent, { encoding: 'utf8', mode: 0o600 });
        console.log('[MusicPlayer] 🍪 Synchronized and Sanitized cookies.txt.');
    } catch (err) {
        console.error('[MusicPlayer] ❌ Failed to write cookies.txt:', err);
    }
}

export interface GuildQueue {
    textChannel: TextChannel;
    voiceChannelId: string;
    connection: VoiceConnection | null;
    player: AudioPlayer | null;
    tracks: YoutubeResult[];
    isPlaying: boolean;
    isPaused: boolean;
    consecutiveErrors: number;
    currentResource: any | null;
    nowPlayingMessage?: Message;
    progressInterval?: NodeJS.Timeout;
    inactivityTimer?: NodeJS.Timeout;
}

export class MusicPlayer {
    private static queues = new Map<string, GuildQueue>();

    /**
     * Get or create a queue for a guild
     */
    static getQueue(guildId: string, textChannel?: TextChannel, voiceChannelId?: string): GuildQueue {
        let queue = this.queues.get(guildId);
        if (!queue && textChannel && voiceChannelId) {
            queue = {
                textChannel,
                voiceChannelId,
                connection: null,
                player: null,
                tracks: [],
                isPlaying: false,
                isPaused: false,
                consecutiveErrors: 0,
                currentResource: null
            };
            MusicPlayer.queues.set(guildId, queue);
        }
        return queue!;
    }

    /**
     * Join a voice channel and set up the connection
     */
    static async join(guildId: string, voiceChannelId: string, textChannel: TextChannel): Promise<GuildQueue> {
        const queue = this.getQueue(guildId, textChannel, voiceChannelId);

        if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Disconnected) {
            queue.connection = joinVoiceChannel({
                channelId: voiceChannelId,
                guildId: guildId,
                adapterCreator: textChannel.guild.voiceAdapterCreator,
            });

            queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                console.warn(`[MusicPlayer] Voice connection lost for guild ${guildId}, attempting recovery...`);
                try {
                    // Try to reconnect for 15 seconds
                    await Promise.race([
                        entersState(queue.connection!, VoiceConnectionStatus.Signalling, 5000),
                        entersState(queue.connection!, VoiceConnectionStatus.Connecting, 5000),
                    ]);
                    // Reconnected
                } catch (e) {
                    console.error(`[MusicPlayer] Reconnection failed for guild ${guildId}`);
                    this.stop(guildId);
                }
            });
        }

        if (!queue.player) {
            queue.player = createAudioPlayer({
                behaviors: {
                    noSubscriber: NoSubscriberBehavior.Play
                }
            });

            queue.player.on(AudioPlayerStatus.Idle, () => {
                this.onTrackEnd(guildId);
            });

            queue.player.on('error', (error) => {
                console.error(`[MusicPlayer] Audio Player Error in guild ${guildId}:`, error);
                queue.textChannel.send(`⚠️ Error playing track: ${error.message}`);
                this.onTrackEnd(guildId, true);
            });

            queue.connection.subscribe(queue.player);
        }

        return queue;
    }

    /**
     * Start playing or add to queue
     */
    static async play(guildId: string, track: YoutubeResult): Promise<number> {
        const queue = this.queues.get(guildId);
        if (!queue) return 0;

        queue.tracks.push(track);

        if (!queue.isPlaying) {
            this.processQueue(guildId);
        }

        return queue.tracks.length;
    }

    static skip(guildId: string) {
        const queue = this.queues.get(guildId);
        if (queue && queue.player) {
            this.stopProgressUpdate(guildId);
            queue.player.stop();
            return true;
        }
        return false;
    }

    static stop(guildId: string) {
        const queue = this.queues.get(guildId);
        if (queue) {
            this.stopProgressUpdate(guildId);
            if (queue.inactivityTimer) clearTimeout(queue.inactivityTimer);
            
            queue.tracks = [];
            queue.isPlaying = false;
            queue.player?.stop();
            queue.connection?.destroy();
            this.queues.delete(guildId);
            return true;
        }
        return false;
    }

    static pause(guildId: string) {
        const queue = this.queues.get(guildId);
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
        const queue = this.queues.get(guildId);
        if (queue && queue.player && queue.isPaused) {
            queue.player.unpause();
            queue.isPaused = false;
            this.startProgressUpdate(guildId);
            this.updateNowPlayingMessage(guildId);
            return true;
        }
        return false;
    }

    private static async processQueue(guildId: string) {
        const queue = this.queues.get(guildId);
        if (!queue) return;

        if (queue.tracks.length === 0) {
            queue.isPlaying = false;
            this.stopProgressUpdate(guildId);
            
            const endBuilder = new ComponentsV2()
                .addText(`✅ **Queue concluded.** Disconnecting in 5 minutes if inactive.`);
            queue.textChannel.send(endBuilder.build()).catch(() => { });

            // Auto-disconnect
            if (queue.inactivityTimer) clearTimeout(queue.inactivityTimer);
            queue.inactivityTimer = setTimeout(() => {
                const refreshed = this.queues.get(guildId);
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

        const track = queue.tracks[0];
        try {
            queue.isPlaying = true;
            console.log(`[MusicPlayer] 🎵 Fetching stream for: ${track.title}`);

            const { stream } = await Youtube.getAudioStream(track.url);
            
            const resource = createAudioResource(stream, {
                inputType: StreamType.OggOpus,
                inlineVolume: true
            });

            queue.currentResource = resource;
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
            this.onTrackEnd(guildId, true);
        }
    }

    private static async sendPlaybackUI(guildId: string, track: YoutubeResult) {
        const queue = this.queues.get(guildId);
        if (!queue) return;

        const ui = this.buildPlaybackUI(track, 0, false);
        try {
            const msg = await queue.textChannel.send(ui);
            queue.nowPlayingMessage = msg;
        } catch (err) {
            console.error('[MusicPlayer] Failed to send playback UI:', err);
        }
    }

    private static buildPlaybackUI(track: YoutubeResult, elapsed: number, isPaused: boolean) {
        const total = track.durationSeconds || 0;
        const progressBar = createProgressBar(elapsed, total);
        const timeInfo = `\`${formatDuration(elapsed)} / ${track.duration || '0:00'}\``;

        const builder = new ComponentsV2()
            .setAccent(isPaused ? 0xFFA500 : 0x1DB954)
            .addThumbnail(track.artworkUrl || track.thumbnail, 
                `### 🎵 ${track.artistName || ''} - ${(track.trackTitle || track.title).replace(/\[.*?\]|\(.*?\)/g, '')}\n` +
                `**${track.channelTitle}** ${track.statsText || ''}\n\n` +
                `${progressBar} ${timeInfo}\n\n` +
                `-# Added to queue by ${track.requesterName || 'Unknown'}`
            )
            .addSeparator()
            .addRow([
                { type: 2, style: 2, label: isPaused ? '▶️ Resume' : '⏸️ Pause', custom_id: isPaused ? `mp-resume:${track.url}` : `mp-pause:${track.url}` },
                { type: 2, style: 2, label: '⏭️ Skip', custom_id: `mp-skip:${track.url}` },
                { type: 2, style: 4, label: '🛑 Stop', custom_id: `mp-stop:${track.url}` },
                { type: 2, style: 2, label: '📝 Lyrics', custom_id: `wh-lyrics:${(track.artistName || '').substring(0, 35)}|${(track.trackTitle || '').substring(0, 35)}` }
            ]);

        return builder.build();
    }

    private static startProgressUpdate(guildId: string) {
        const queue = this.queues.get(guildId);
        if (!queue) return;

        this.stopProgressUpdate(guildId);

        queue.progressInterval = setInterval(() => {
            this.updateNowPlayingMessage(guildId);
        }, 15000);
    }

    private static stopProgressUpdate(guildId: string) {
        const queue = this.queues.get(guildId);
        if (queue?.progressInterval) {
            clearInterval(queue.progressInterval);
            queue.progressInterval = undefined;
        }
    }

    private static async updateNowPlayingMessage(guildId: string) {
        const queue = this.queues.get(guildId);
        if (!queue || !queue.nowPlayingMessage || !queue.isPlaying) return;

        const track = queue.tracks[0];
        if (!track) return;

        const elapsed = queue.currentResource ? Math.floor(queue.currentResource.playbackDuration / 1000) : 0;
        const ui = this.buildPlaybackUI(track, elapsed, queue.isPaused);

        try {
            await queue.nowPlayingMessage.edit(ui);
        } catch (err) {
            // Message might be deleted
            this.stopProgressUpdate(guildId);
        }
    }

    private static async handleScrobbling(guildId: string, track: YoutubeResult) {
        const queue = this.queues.get(guildId);
        if (!queue) return;
        try {
            const voiceChannel = await queue.textChannel.guild.channels.fetch(queue.voiceChannelId) as VoiceChannel;
            if (voiceChannel) {
                const listeners = voiceChannel.members.filter(m => !m.user.bot).map(m => m.id);
                if (listeners.length > 0 && track.artistName && track.trackTitle) {
                    await ScrobbleService.scrobbleForUsers(listeners, { artist: track.artistName, track: track.trackTitle });
                    const builder = new ComponentsV2().setAccent(0xd80000).addText(`Scrobbling **${track.trackTitle}** by **${track.artistName}**`);
                    queue.textChannel.send(builder.build()).catch(() => { });
                }
            }
        } catch { }
    }

    private static onTrackEnd(guildId: string, error = false) {
        const queue = this.queues.get(guildId);
        if (!queue) return;

        this.stopProgressUpdate(guildId);

        if (error) {
            queue.consecutiveErrors++;
            if (queue.consecutiveErrors >= 3) {
                queue.textChannel.send('🛑 **Stopping playback** — Too many consecutive errors.');
                MusicPlayer.stop(guildId);
                return;
            }
        } else {
            queue.consecutiveErrors = 0;
        }

        queue.tracks.shift();
        this.processQueue(guildId);
    }
}
