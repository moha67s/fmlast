import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import YouTubeSR from 'youtube-sr';
import ytdlExec from 'youtube-dl-exec';
import ffmpegStatic from 'ffmpeg-static';
import { config } from '../../../config';
import { formatDuration } from '../../utils/formatDuration';

export interface YoutubeResult {
    title: string;
    url: string;
    id: string;
    thumbnail: string;
    channelTitle: string;
    duration?: string;
    durationSeconds?: number;
    views?: string;
    publishedAt?: string;
    artistName?: string;
    trackTitle?: string;
    artworkUrl?: string;     // For UI rendering
    statsText?: string;      // For UI rendering
    requesterName?: string;  // For UI rendering
}

export interface AudioStreamResult {
    stream: Readable;
}

interface CacheEntry {
    song: YoutubeResult;
    expiresAt: number;
}

type StreamMode = 'copy' | 'transcode';

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;
const metadataCache = new Map<string, CacheEntry>();

// ffmpeg/yt-dlp settings from MusicBox-prod
const FFMPEG_PROBE_SIZE_COPY = 262_144;
const FFMPEG_ANALYZE_DURATION_COPY = 1_000_000;
const FFMPEG_PROBE_SIZE_TRANSCODE = 131_072;
const FFMPEG_ANALYZE_DURATION_TRANSCODE = 200_000;
const PASS_THROUGH_BUFFER_SIZE = 2 * 1024 * 1024;
const YTDLP_CONCURRENT_FRAGMENTS = 4;
const YTDLP_THROTTLED_RATE = '30K';
const STREAM_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

let cookieFilePath: string | null = null;
const COOKIES_FILE = join(process.cwd(), 'cookies.txt');

if (existsSync(COOKIES_FILE)) {
    cookieFilePath = COOKIES_FILE;
}

let ytdlpBinary = 'yt-dlp';
if (ytdlExec && (ytdlExec as any).constants?.YOUTUBE_DL_PATH) {
    ytdlpBinary = (ytdlExec as any).constants.YOUTUBE_DL_PATH;
}

let ffmpegBinary = 'ffmpeg';
if (typeof ffmpegStatic === 'string') {
    ffmpegBinary = ffmpegStatic;
}

const CLIENT_ROTATION: readonly string[] = [
    'default,mweb,ios',
    'mweb,default,ios',
    'ios,mweb,default',
];

const POTOKEN_CLIENT_ROTATION: readonly string[] = [
    'ios,mweb,tv_simply',
    'mweb,ios,tv_simply',
    'tv_simply,mweb,ios',
];

function getPlayerClients(attempt = 1): string {
    const rotation = config.POTOKEN_SERVER ? POTOKEN_CLIENT_ROTATION : CLIENT_ROTATION;
    const idx = Math.max(0, Math.min(rotation.length - 1, attempt - 1));
    return rotation[idx];
}

function getAuthFlags(attempt = 1): string[] {
    const youtubeArgs: string[] = [`player_client=${getPlayerClients(attempt)}`];
    const flags: string[] = ['--extractor-args', `youtube:${youtubeArgs.join(';')}`];

    if (config.POTOKEN_SERVER) {
        flags.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${config.POTOKEN_SERVER}`);
    }

    if (cookieFilePath) flags.push('--cookies', cookieFilePath);
    return flags;
}

export class Youtube {
    private static quotaExceeded = false;

    /**
     * Search for a music video based on artist and track names.
     */
    static async searchMusicVideo(artist: string, track: string): Promise<YoutubeResult | null> {
        const query = `${artist} - ${track} (Official Music Video)`;
        return this.search(query);
    }

    /**
     * General YouTube search.
     */
    static async search(query: string): Promise<YoutubeResult | null> {
        // 1. Handle direct YouTube URLs
        if (query.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/)) {
            try {
                return await this.getInfoByUrl(query);
            } catch (err) {
                console.error('[Youtube] getInfoByUrl failed:', err);
            }
        }

        // 2. youtube-sr search
        try {
            const results = await YouTubeSR.search(query, { limit: 1, type: 'video' });
            if (results.length > 0) {
                const video = results[0];
                const url = video.url || `https://www.youtube.com/watch?v=${video.id}`;
                return {
                    title: video.title || 'Unknown Title',
                    url: url,
                    id: video.id || '',
                    thumbnail: video.thumbnail?.url || '',
                    channelTitle: video.channel?.name || 'Unknown Channel',
                    duration: video.durationFormatted,
                    durationSeconds: Math.floor((video.duration ?? 0) / 1000),
                    views: video.views ? video.views.toLocaleString() : undefined
                };
            }
        } catch (err) {
            console.warn('[Youtube] youtube-sr search failed, falling back to yt-dlp:', err instanceof Error ? err.message : String(err));
            return this.searchByQueryWithYtdlp(query);
        }

        return null;
    }

    private static async searchByQueryWithYtdlp(query: string): Promise<YoutubeResult | null> {
        const cookieFlags = getAuthFlags();
        try {
            const result = await new Promise<any>((resolve, reject) => {
                const args = [
                    `ytsearch1:${query}`,
                    '--dump-single-json',
                    '--flat-playlist',
                    '--no-warnings',
                    '--no-check-certificates',
                    ...cookieFlags,
                ];

                const proc = spawn(ytdlpBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
                const stdoutChunks: Buffer[] = [];
                let stderr = '';

                proc.stdout!.on('data', (d: Buffer) => {
                    stdoutChunks.push(d);
                });
                proc.stderr!.on('data', (d: Buffer) => {
                    stderr += d.toString();
                });

                proc.on('close', (code) => {
                    if (code !== 0) {
                        reject(new Error(`yt-dlp search failed (code ${code}): ${stderr}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(stdoutChunks).toString()));
                    } catch {
                        reject(new Error('Failed to parse yt-dlp search JSON output'));
                    }
                });

                proc.on('error', (err: Error) => {
                    reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
                });
            });

            const entry = result.entries?.[0];
            if (!entry) return null;

            const duration = Number(entry.duration) || 0;
            const videoId = entry.id || entry.url;

            return {
                title: entry.title || 'Unknown Title',
                url: `https://www.youtube.com/watch?v=${videoId}`,
                id: videoId,
                durationSeconds: duration,
                duration: formatDuration(duration),
                thumbnail: entry.thumbnails?.[0]?.url || entry.thumbnail || '',
                channelTitle: entry.uploader || entry.channel || 'Unknown Channel',
            };
        } catch (err) {
            console.error('[Youtube] yt-dlp search fallback failed:', err);
            return null;
        }
    }

    static async getInfoByUrl(url: string): Promise<YoutubeResult> {
        const cached = metadataCache.get(url);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.song;
        }

        const cookieFlags = getAuthFlags();
        const result = await new Promise<any>((resolve, reject) => {
            const args = [
                url,
                '--dump-single-json',
                '--no-playlist',
                '--no-warnings',
                '--no-check-certificates',
                ...cookieFlags,
            ];

            const proc = spawn(ytdlpBinary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            const stdoutChunks: Buffer[] = [];
            let stderr = '';

            const timeout = setTimeout(() => {
                if (!proc.killed) {
                    proc.kill('SIGKILL');
                    reject(new Error(`yt-dlp metadata timed out after ${config.YT_METADATA_TIMEOUT_MS}ms`));
                }
            }, config.YT_METADATA_TIMEOUT_MS);

            proc.stdout!.on('data', (d: Buffer) => {
                stdoutChunks.push(d);
            });
            proc.stderr!.on('data', (d: Buffer) => {
                stderr += d.toString();
            });

            proc.on('close', (code) => {
                clearTimeout(timeout);
                if (code !== 0) {
                    reject(new Error(`yt-dlp metadata failed (code ${code}): ${stderr}`));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(stdoutChunks).toString()));
                } catch {
                    reject(new Error('Failed to parse yt-dlp JSON output'));
                }
            });

            proc.on('error', (err: Error) => {
                clearTimeout(timeout);
                reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
            });
        });

        const song: YoutubeResult = {
            title: result.title || 'Unknown Title',
            url: result.webpage_url || url,
            id: result.id || '',
            durationSeconds: Math.floor(result.duration || 0),
            duration: formatDuration(Math.floor(result.duration || 0)),
            thumbnail: result.thumbnail || '',
            channelTitle: result.uploader || 'Unknown Channel',
            views: result.view_count?.toLocaleString()
        };

        metadataCache.set(url, { song, expiresAt: Date.now() + CACHE_TTL_MS });
        return song;
    }

    static async getAudioStream(url: string): Promise<AudioStreamResult> {
        let lastError: unknown;
        const sanitizedUrl = url.trim();

        for (let attempt = 1; attempt <= STREAM_RETRY_ATTEMPTS; attempt++) {
            const mode: StreamMode = attempt < STREAM_RETRY_ATTEMPTS ? 'copy' : 'transcode';
            try {
                const { stream, ready } = this.createYtdlpStream(sanitizedUrl, attempt, mode);
                await ready;
                console.log(`[Youtube] Audio stream started (mode=${mode}, attempt ${attempt})`);
                return { stream };
            } catch (error) {
                lastError = error;
                console.warn(`[Youtube] Stream attempt ${attempt}/${STREAM_RETRY_ATTEMPTS} failed: ${error}`);

                if (attempt < STREAM_RETRY_ATTEMPTS) {
                    const expo = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
                    const jitter = Math.floor(Math.random() * Math.min(expo, 500));
                    await new Promise((resolve) => setTimeout(resolve, expo + jitter));
                }
            }
        }

        throw new Error(`Failed to get audio stream after ${STREAM_RETRY_ATTEMPTS} attempts: ${lastError}`);
    }

    private static createYtdlpStream(
        url: string,
        attempt = 1,
        mode: StreamMode = 'transcode',
    ): { stream: Readable; ready: Promise<void> } {
        const cookieFlags = getAuthFlags(attempt);

        const formatSelector = 'bestaudio/best';

        const ytdlpArgs = [
            url,
            '-f', formatSelector,
            '-o', '-',
            '--no-playlist',
            '--no-warnings',
            '--no-progress',
            '--no-check-certificates',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            '--buffer-size', '512K',
            '-N', String(YTDLP_CONCURRENT_FRAGMENTS),
            '--throttled-rate', YTDLP_THROTTLED_RATE,
            '-R', '3',
            '--socket-timeout', '15',
            '--extractor-retries', '3',
            '--force-ipv4',
            '--ignore-config',
            '--no-mtime',
            ...cookieFlags,
        ];

        const ffmpegArgs: string[] = mode === 'copy'
            ? [
                '-analyzeduration', String(FFMPEG_ANALYZE_DURATION_COPY),
                '-probesize', String(FFMPEG_PROBE_SIZE_COPY),
                '-i', 'pipe:0',
                '-vn', '-map', 'a:0', '-c:a', 'copy', '-f', 'ogg', '-loglevel', 'error', 'pipe:1',
            ]
            : [
                '-analyzeduration', String(FFMPEG_ANALYZE_DURATION_TRANSCODE),
                '-probesize', String(FFMPEG_PROBE_SIZE_TRANSCODE),
                '-i', 'pipe:0',
                '-vn', '-map', 'a:0', '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k',
                '-vbr', 'on', '-application', 'audio', '-frame_duration', '20', '-f', 'ogg', '-loglevel', 'error', 'pipe:1',
            ];

        const ytdlpProc: ChildProcess = spawn(ytdlpBinary, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        const ffmpegProc: ChildProcess = spawn(ffmpegBinary, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

        const passThrough = new PassThrough({ highWaterMark: PASS_THROUGH_BUFFER_SIZE });

        let hasData = false;
        let startupSettled = false;
        let resolvePending: (() => void) | null = null;
        let rejectPending: ((reason?: unknown) => void) | null = null;
        let ytdlpStderr = '';
        let ffmpegStderr = '';

        const ready = new Promise<void>((resolve, reject) => {
            resolvePending = resolve;
            rejectPending = reject;
        });

        const settleResolve = (): void => {
            if (startupSettled) return;
            startupSettled = true;
            resolvePending?.();
        };

        const settleReject = (reason: unknown): void => {
            if (startupSettled) return;
            startupSettled = true;
            rejectPending?.(reason);
        };

        const cleanup = (): void => {
            if (!ytdlpProc.killed) ytdlpProc.kill('SIGKILL');
            if (!ffmpegProc.killed) ffmpegProc.kill('SIGKILL');
            if (!passThrough.destroyed) passThrough.destroy();
        };

        const startupTimeout = setTimeout(() => {
            if (!hasData) {
                const startupError = new Error(`Stream startup timed out after ${config.YT_STREAM_TIMEOUT_MS}ms. yt-dlp stderr: ${ytdlpStderr}`);
                settleReject(startupError);
                cleanup();
            }
        }, config.YT_STREAM_TIMEOUT_MS);

        ffmpegProc.stdout!.on('data', () => {
            if (!hasData) {
                hasData = true;
                clearTimeout(startupTimeout);
                settleResolve();
            }
        });

        ytdlpProc.stdout!.pipe(ffmpegProc.stdin!);
        ffmpegProc.stdout!.pipe(passThrough);

        ytdlpProc.stderr!.on('data', (d: Buffer) => { ytdlpStderr += d.toString(); });
        ffmpegProc.stderr!.on('data', (d: Buffer) => { ffmpegStderr += d.toString(); });

        ffmpegProc.stdin?.on('error', (err: any) => {
            if (err.code === 'EPIPE') return;
            cleanup();
        });

        ytdlpProc.on('error', (err) => { settleReject(err); cleanup(); });
        ffmpegProc.on('error', (err) => { settleReject(err); cleanup(); });

        ytdlpProc.on('close', (code) => {
            if (code !== 0 && code !== null && !hasData) {
                console.error(`[Youtube] yt-dlp error (code ${code}): ${ytdlpStderr}`);
                settleReject(new Error(`yt-dlp exited with code ${code}`));
            }
        });

        ffmpegProc.on('close', (code) => {
            if (code !== 0 && code !== null && !hasData) {
                console.error(`[Youtube] ffmpeg error (code ${code}): ${ffmpegStderr}`);
                settleReject(new Error(`ffmpeg exited with code ${code}`));
            }
            if (!passThrough.destroyed) passThrough.end();
        });

        return { stream: passThrough, ready };
    }
}
