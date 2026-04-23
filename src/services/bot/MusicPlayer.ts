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

// Immortal Proxy List (WebShare)
const PROXY_LIST = [
    'http://jgwncugf:0h41yf9sx1zj@31.59.20.176:6754',
    'http://jgwncugf:0h41yf9sx1zj@198.23.239.134:6540',
    'http://jgwncugf:0h41yf9sx1zj@45.38.107.97:6014',
    'http://jgwncugf:0h41yf9sx1zj@107.172.163.27:6543',
    'http://jgwncugf:0h41yf9sx1zj@198.105.121.200:6462',
    'http://jgwncugf:0h41yf9sx1zj@216.10.27.159:6837',
    'http://jgwncugf:0h41yf9sx1zj@142.111.67.146:5611',
    'http://jgwncugf:0h41yf9sx1zj@191.96.254.138:6185',
    'http://jgwncugf:0h41yf9sx1zj@31.58.9.4:6077',
    'http://jgwncugf:0h41yf9sx1zj@104.239.107.47:5699'
];

function getRandomProxy() {
    return PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
}

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
    isFallingBack?: boolean;
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
        let streamUrl = track.url;
        
        if (queue.isFallingBack) {
            // Consume the fallback flag so it doesn't loop
            queue.isFallingBack = false;
            const scQuery = track.artistName && track.trackTitle 
                ? `${track.artistName} ${track.trackTitle}` 
                : track.title;
            streamUrl = `scsearch1:${scQuery}`;
            queue.textChannel.send(`⚠️ **YouTube blocked this server's IP!** Rerouting audio through SoundCloud for \`${track.title}\`...`).catch(() => {});
        }

        if (!streamUrl) {
            queue.textChannel.send(`❌ Missing URL for: **${track.title}**`);
            this.onTrackEnd(guildId, true);
            return;
        }

        try {
            queue.isPlaying = true;
            let stderrBuffer = '';
            const useProxy = streamUrl.includes('youtube.com') || streamUrl.includes('youtu.be');
            const selectedProxy = getRandomProxy();

            console.log(`[MusicPlayer] 🎵 Streaming: ${track.title} ${useProxy ? '(via Proxy Handshake)' : '(Direct)'}`);

            // 1. DATA-SAVER HANDSHAKE: Get the direct audio URL using the proxy
            let finalStreamUrl = streamUrl;
            let proxyToUse: string | undefined = undefined;

            if (useProxy) {
                try {
                    const handshakeArgs: any = {
                        getUrl: true,
                        format: 'bestaudio*',
                        noCheckCertificates: true,
                        proxy: selectedProxy
                    };
                    if (fs.existsSync(COOKIES_FILE)) handshakeArgs.cookies = COOKIES_FILE;

                    console.log(`[MusicPlayer] 🤝 Handshake via ${selectedProxy.split('@')[1]}`);
                    const resolved = await ytdlExec(streamUrl, handshakeArgs);
                    if (resolved && typeof resolved === 'string') {
                        finalStreamUrl = resolved.trim();
                        console.log(`[MusicPlayer] ✅ Handshake successful`);
                    }
                } catch (err: any) {
                    console.warn(`[MusicPlayer] ⚠️ Handshake failed, falling back to direct/proxy stream:`, err.message);
                    proxyToUse = selectedProxy; // Fallback to full proxy if handshake fails
                }
            }

            // 2. STREAMING: Start yt-dlp to pipe the audio
            const ytdlArgs: any = {
                output: '-',
                format: 'bestaudio*',
                noCheckCertificates: true,
                noWarnings: true,
                noPlaylist: true,
                rmCacheDir: true,
                ageLimit: 99,
                addHeader: [
                    'referer:youtube.com',
                    'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
                ]
            };

            if (proxyToUse) {
                ytdlArgs.proxy = proxyToUse;
                console.log(`[MusicPlayer] 🔄 Full Proxy Mode: Streaming through ${proxyToUse.split('@')[1]}`);
            }

            if (fs.existsSync(COOKIES_FILE)) {
                ytdlArgs.cookies = COOKIES_FILE;
            }

            const ytProcess = ytdlExec(finalStreamUrl, ytdlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

            // Catch the promise rejection when the process is killed (SIGTERM = intentional skip/stop)
            // Code 1 = YouTube blocked us — send a helpful message and advance the queue.
            ytProcess.catch((err) => {
                if (err.signal === 'SIGTERM' || err.message?.includes('SIGTERM')) return;

                const errorLines = stderrBuffer.split('\n')
                    .filter(l => l.includes('ERROR') || l.includes('error'))
                    .slice(0, 3).join('\n');

                if (errorLines.includes('Sign in') || errorLines.includes('age') || errorLines.includes('unavailable')) {
                    if (!streamUrl.startsWith('scsearch1:')) {
                        // Mark for fallback. The pipe will close, triggering Idle, which calls onTrackEnd
                        queue.isFallingBack = true;
                        return; // Exit early to let onTrackEnd handle the fallback reboot
                    } else {
                        queue.textChannel.send(`⚠️ **Skipped**: \`${track.title}\` — Fallback stream is also unavailable.`).catch(() => { });
                    }
                } else if (!errorLines.includes('Errno 22')) {
                    // Only log real errors, ignore "unable to write data" (Errno 22) as it's just pipe cleanup
                    console.error('[MusicPlayer] yt-dlp failed (code 1):', errorLines || err.message);
                    queue.textChannel.send(`⚠️ **Skipped**: \`${track.title}\` — Could not stream this track.`).catch(() => { });
                }
                
                // If we reach here, it's a hard error, ensure fallback is false
                queue.isFallingBack = false;
                this.onTrackEnd(guildId, true);
            });

            queue.currentProcess = ytProcess;

            if (!ytProcess.stdout) {
                throw new Error("Failed to open stdout from yt-dlp");
            }

            const resource = createAudioResource(ytProcess.stdout, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true
            });

            // Capture stderr for diagnostics
            ytProcess.on('error', (err) => console.error('[MusicPlayer] yt-dlp process error:', err));
            ytProcess.stderr?.on('data', (data: Buffer) => {
                const msg = data.toString();
                stderrBuffer += msg;
                // Avoid logging Errno 22 as a warning
                if (msg.includes('ERROR:') && !msg.includes('Errno 22')) {
                    console.warn('[MusicPlayer] yt-dlp stderr:', msg.trim());
                }
            });

            // Resource-level error handling
            resource.playStream.on('error', (error) => {
                console.error(`[MusicPlayer] Resource stream error for ${track.url}:`, error);
                if (queue.currentProcess && !queue.currentProcess.killed) {
                    try { queue.currentProcess.kill(); } catch { }
                    queue.currentProcess = null;
                }
                this.onTrackEnd(guildId, true);
            });

            queue.isPaused = false;
            queue.player?.play(resource);
            queue.consecutiveErrors = 0; // Reset error counter on successful playback start

            console.log(`[MusicPlayer] ✅ Piped Playback started: ${track.title}`);

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
            // Intercept fallback request
            if (queue.isFallingBack) {
                queue.isPlaying = false; // Reset playing state so processQueue executes
                this.processQueue(guildId);
                return;
            }

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
