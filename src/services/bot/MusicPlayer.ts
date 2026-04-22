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
    StreamType
} from '@discordjs/voice';
import { YoutubeResult } from '../api/Youtube';
import play from 'play-dl';
import youtubedl, { exec as ytdlExec } from 'youtube-dl-exec';
import { VoiceChannel, TextChannel } from 'discord.js';
import { ScrobbleService } from './ScrobbleService';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export interface GuildQueue {
    textChannel: TextChannel;
    voiceChannelId: string;
    connection: VoiceConnection | null;
    player: AudioPlayer | null;
    tracks: YoutubeResult[];
    isPlaying: boolean;
    isPaused: boolean;
    currentProcess: any | null;
    consecutiveErrors: number;
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
                currentProcess: null,
                consecutiveErrors: 0
            };
            this.queues.set(guildId, queue);
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
                try {
                    await Promise.race([
                        new Promise((resolve) => queue.connection?.once(VoiceConnectionStatus.Signalling, resolve)),
                        new Promise((resolve) => queue.connection?.once(VoiceConnectionStatus.Connecting, resolve)),
                    ]);
                    // Resumed
                } catch (e) {
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
                // Cleanup subprocess if it's still hanging around
                if (queue.currentProcess && !queue.currentProcess.killed) {
                    try { queue.currentProcess.kill(); } catch { }
                    queue.currentProcess = null;
                }
                this.onTrackEnd(guildId);
            });

            queue.player.on('error', (error) => {
                console.error(`[MusicPlayer] Error in guild ${guildId}:`, error);

                // Cleanup process on error too
                if (queue.currentProcess && !queue.currentProcess.killed) {
                    try { queue.currentProcess.kill(); } catch { }
                    queue.currentProcess = null;
                }

                queue.textChannel.send(`⚠️ Error playing track: ${error.message}`);
                this.onTrackEnd(guildId, true);
            });

            queue.connection.subscribe(queue.player);
        }

        return queue;
    }

    /**
     * Start playing or add to queue
     * Returns the position of the track in the queue
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

    /**
     * skip the current track
     */
    static skip(guildId: string) {
        const queue = this.queues.get(guildId);
        if (queue && queue.player) {
            queue.player.stop();
            return true;
        }
        return false;
    }

    /**
     * Stop playback and leave VC
     */
    static stop(guildId: string) {
        const queue = this.queues.get(guildId);
        if (queue) {
            queue.tracks = [];
            queue.isPlaying = false;

            if (queue.currentProcess && !queue.currentProcess.killed) {
                try { queue.currentProcess.kill(); } catch { }
                queue.currentProcess = null;
            }

            queue.player?.stop();
            queue.connection?.destroy();
            this.queues.delete(guildId);
            return true;
        }
        return false;
    }

    /**
     * Pause playback
     */
    static pause(guildId: string) {
        const queue = this.queues.get(guildId);
        if (queue && queue.player && !queue.isPaused) {
            queue.player.pause();
            queue.isPaused = true;
            return true;
        }
        return false;
    }

    /**
     * Resume playback
     */
    static resume(guildId: string) {
        const queue = this.queues.get(guildId);
        if (queue && queue.player && queue.isPaused) {
            queue.player.unpause();
            queue.isPaused = false;
            return true;
        }
        return false;
    }

    /**
     * Processing the next item in the queue
     */
    private static async processQueue(guildId: string) {
        const queue = this.queues.get(guildId);
        if (!queue) return;

        if (queue.tracks.length === 0) {
            queue.isPlaying = false;

            // Queue concluded message
            const endBuilder = new ComponentsV2()
                .addText(`✅ **Queue concluded.** Disconnecting in 30 seconds if inactive.`);
            queue.textChannel.send(endBuilder.build()).catch(() => { });

            // Auto-disconnect after 30 seconds of idle
            setTimeout(() => {
                const refreshed = this.queues.get(guildId);
                if (refreshed && !refreshed.isPlaying && refreshed.tracks.length === 0) {
                    this.stop(guildId);
                }
            }, 30000);
            return;
        }

        const track = queue.tracks[0];
        if (!track.url) {
            queue.textChannel.send(`❌ Missing URL for: **${track.title}**`);
            this.onTrackEnd(guildId, true);
            return;
        }

        try {
            queue.isPlaying = true;
            console.log(`[MusicPlayer] 🎵 Streaming (play-dl): ${track.url}`);
            
            const stream = await play.stream(track.url, { discordPlayerCompatibility: true });
            
            const resource = createAudioResource(stream.stream, {
                inputType: stream.type,
                inlineVolume: true
            });

            // Resource-level error handling
            resource.playStream.on('error', (error) => {
                console.error(`[MusicPlayer] Resource stream error for ${track.url}:`, error);
                this.onTrackEnd(guildId, true);
            });

            queue.isPaused = false;
            queue.player?.play(resource);
            queue.consecutiveErrors = 0; // Reset error counter on successful playback start

            console.log(`[MusicPlayer] ✅ Playback started: ${track.title}`);

            // Render Now Playing UI
            if (track.artistName && track.trackTitle) {
                try {
                    const pbBuilder = new ComponentsV2()
                        .setAccent(0x1DB954) // Spotify Green
                        .addThumbnail(track.artworkUrl || track.thumbnail, `### 🎵 ${track.artistName} - ${track.trackTitle.replace(/\[.*?\]|\(.*?\)/g, '')}\n**${track.channelTitle}**${track.statsText || ''}\n-# Added to queue by ${track.requesterName || 'Unknown'}`)
                        .addSeparator()
                        .addRow([
                            { type: 2, style: 2, label: '⏸️ Pause', custom_id: `mp-pause:${guildId}` },
                            { type: 2, style: 2, label: '⏭️ Skip', custom_id: `mp-skip:${guildId}` },
                            { type: 2, style: 4, label: '🛑 Stop', custom_id: `mp-stop:${guildId}` },
                            { type: 2, style: 2, label: '📝 Lyrics', custom_id: `wh-lyrics:${track.artistName.substring(0, 35)}|${track.trackTitle.substring(0, 35)}` }
                        ]);

                    queue.textChannel.send(pbBuilder.build()).catch(() => { });
                } catch (err) {
                    console.error('[MusicPlayer] Failed to send playback UI:', err);
                }
            }

            // Native Playback Scrobbling
            if (track.artistName && track.trackTitle) {
                try {
                    const voiceChannel = await queue.textChannel.guild.channels.fetch(queue.voiceChannelId) as VoiceChannel;
                    if (voiceChannel) {
                        const listenerDiscordIds = voiceChannel.members
                            .filter(m => !m.user.bot)
                            .map(m => m.id);

                        if (listenerDiscordIds.length > 0) {
                            await ScrobbleService.scrobbleForUsers(listenerDiscordIds, {
                                artist: track.artistName,
                                track: track.trackTitle,
                            });

                            const builder = new ComponentsV2()
                                .setAccent(0xd80000)
                                .addText(`၊،||၊ Scrobbling **${track.trackTitle}** by **${track.artistName}** for ${listenerDiscordIds.length} listener${listenerDiscordIds.length === 1 ? '' : 's'}`)
                                .addAction(`Length ${track.duration || '0:00'} — bot`, {
                                    type: 2, custom_id: 'user-setting-botscrobbling-manage', style: 2, label: 'Manage'
                                });

                            queue.textChannel.send(builder.build()).catch(() => { });
                        }
                    }
                } catch (err) {
                    console.error('[MusicPlayer] Failed to scrobble playback:', err);
                }
            }

        } catch (err: any) {
            console.error(`[MusicPlayer] Stream error for ${track.url}:`, err);
            queue.textChannel.send(`❌ Failed to stream: **${track.title}**\n-# Error: ${err.message || 'yt-dlp piping failed'}`);
            this.onTrackEnd(guildId, true);
        }
    }

    private static onTrackEnd(guildId: string, error = false) {
        const queue = this.queues.get(guildId);
        if (queue) {
            if (error) {
                queue.consecutiveErrors++;
                if (queue.consecutiveErrors >= 3) {
                    queue.textChannel.send('🛑 **Stopping playback** — Too many consecutive errors. Please check the track links or bot connection.');
                    this.stop(guildId);
                    return;
                }
            } else {
                queue.consecutiveErrors = 0;
            }

            queue.tracks.shift();
            this.processQueue(guildId);
        }
    }
}
