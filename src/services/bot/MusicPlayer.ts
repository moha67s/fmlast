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
import fs from 'fs';
import path from 'path';

const COOKIES_FILE = path.join(process.cwd(), 'cookies.txt');



// Always (re)create cookies.txt from env var on every boot to ensure freshness
if (process.env.YOUTUBE_COOKIES) {
    try {
        let cookieContent = process.env.YOUTUBE_COOKIES;
        // Railway may encode newlines as literal \n — restore them
        if (!cookieContent.includes('\n')) {
            cookieContent = cookieContent.replace(/\\n/g, '\n');
        }
        // Strip any wrapping quotes Railway might inject
        cookieContent = cookieContent.replace(/^["']|["']$/g, '');
        fs.writeFileSync(COOKIES_FILE, cookieContent, 'utf-8');
        const lines = cookieContent.split('\n').filter(l => l.trim().length > 0);
        console.log(`[MusicPlayer] ✅ cookies.txt written (${lines.length} lines, ${cookieContent.length} bytes)`);
        console.log(`[MusicPlayer] 🍪 First line: ${lines[0]?.substring(0, 60)}...`);
    } catch (err) {
        console.error('[MusicPlayer] Failed to write cookies.txt from env:', err);
    }
} else {
    if (fs.existsSync(COOKIES_FILE)) {
        console.log('[MusicPlayer] 🍪 Using existing cookies.txt file');
    } else {
        console.warn('[MusicPlayer] ⚠️ No YOUTUBE_COOKIES env var and no cookies.txt found!');
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
    currentProcess: any | null;
    consecutiveErrors: number;
    currentResource: any | null;
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
        const streamUrl = track.url;

        if (!streamUrl) {
            queue.textChannel.send(`❌ Missing URL for: **${track.title}**`);
            MusicPlayer.onTrackEnd(guildId, true);
            return;
        }

        try {
            queue.isPlaying = true;
            let stderrBuffer = '';

            console.log(`[MusicPlayer] 🎵 Playing: ${track.title} (Direct YouTube Engine)`);

            // Combined logic: Old-school bypass flags + Modern Cookies + bestaudio*
            const ytdlArgs: any = {
                output: '-',
                format: 'bestaudio/best',
                noCheckCertificates: true,
                noWarnings: true,
                noPlaylist: true,
                addHeader: [
                    'referer:youtube.com',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                ]
            };

            if (fs.existsSync(COOKIES_FILE)) {
                ytdlArgs.cookies = COOKIES_FILE;
            }

            const ytProcess = ytdlExec(streamUrl, ytdlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
            queue.currentProcess = ytProcess;

            ytProcess.catch((err) => {
                if (err.signal === 'SIGTERM' || err.message?.includes('SIGTERM')) return;
                const fullError = (err.stderr || stderrBuffer || err.message || '').toLowerCase();

                console.error('[MusicPlayer] YouTube Error:', fullError.substring(0, 300));
                
                if (fullError.includes('sign in')) {
                    queue.textChannel.send(`❌ **YouTube Blocked**: Sign-in required for \`${track.title}\`. Your cookies might be expired.`).catch(() => { });
                } else {
                    queue.textChannel.send(`❌ **YouTube Error**: Could not stream \`${track.title}\`.`).catch(() => { });
                }

                if (queue.currentProcess === ytProcess) {
                    queue.currentProcess = null;
                    MusicPlayer.onTrackEnd(guildId, true);
                }
            });

            if (!ytProcess.stdout) throw new Error("Failed to open stdout");

            const resource = createAudioResource(ytProcess.stdout, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true
            });

            ytProcess.stderr?.on('data', (data: Buffer) => { stderrBuffer += data.toString(); });

            queue.player?.play(resource);
            queue.currentResource = resource;

            console.log(`[MusicPlayer] ✅ Stream started: ${track.title}`);

            // Render UI and Scrobble
            if (track.artistName && track.trackTitle) {
                MusicPlayer.sendPlaybackUI(guildId, track);
                MusicPlayer.handleScrobbling(guildId, track);
            }

        } catch (err: any) {
            console.error(`[MusicPlayer] Critical Error:`, err);
            MusicPlayer.onTrackEnd(guildId, true);
        }
    }

    private static sendPlaybackUI(guildId: string, track: any) {
        const queue = MusicPlayer.queues.get(guildId);
        if (!queue) return;
        try {
            const pbBuilder = new ComponentsV2()
                .setAccent(0x1DB954)
                .addThumbnail(track.artworkUrl || track.thumbnail, `### 🎵 ${track.artistName} - ${track.trackTitle.replace(/\[.*?\]|\(.*?\)/g, '')}\n**${track.channelTitle}**${track.statsText || ''}\n-# Added to queue by ${track.requesterName || 'Unknown'}`)
                .addSeparator()
                .addRow([
                    { type: 2, style: 2, label: '⏸️ Pause', custom_id: `mp-pause:${guildId}` },
                    { type: 2, style: 2, label: '⏭️ Skip', custom_id: `mp-skip:${guildId}` },
                    { type: 2, style: 4, label: '🛑 Stop', custom_id: `mp-stop:${guildId}` },
                    { type: 2, style: 2, label: '📝 Lyrics', custom_id: `wh-lyrics:${track.artistName.substring(0, 35)}|${track.trackTitle.substring(0, 35)}` }
                ]);
            queue.textChannel.send(pbBuilder.build()).catch(() => { });
        } catch { }
    }

    private static async handleScrobbling(guildId: string, track: any) {
        const queue = MusicPlayer.queues.get(guildId);
        if (!queue) return;
        try {
            const voiceChannel = await queue.textChannel.guild.channels.fetch(queue.voiceChannelId) as VoiceChannel;
            if (voiceChannel) {
                const listeners = voiceChannel.members.filter(m => !m.user.bot).map(m => m.id);
                if (listeners.length > 0) {
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
        MusicPlayer.processQueue(guildId);
    }
}
