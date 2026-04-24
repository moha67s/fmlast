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
const YTDLP_THROTTLED_RATE = '100K';
const STREAM_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

const COOKIES_FILE = '/tmp/fm2_yt_cookies.txt';

function ensureCookiesFile(): void {
    const raw = process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIE;
    if (!raw) return;
    
    // If it exists and is not empty, we are good
    if (existsSync(COOKIES_FILE)) return;

    try {
        let content = raw.replace(/^["']|["']$/g, '').trim();

        if (content.startsWith('# Netscape')) {
            // Re-parse and re-write to guarantee real tab characters,
            // since Railway env vars often convert \t → spaces
            const lines = content.split('\n').map(line => {
                if (line.startsWith('#') || line.trim() === '') return line;
                // Split on any whitespace (handles both tabs and spaces from env var)
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 7) {
                    // Rejoin with real tabs: domain, flag, path, secure, expiry, name, value
                    // Value may contain spaces/= so rejoin tail
                    const [domain, flag, path, secure, expiry, name, ...valueParts] = parts;
                    return [domain, flag, path, secure, expiry, name, valueParts.join('')].join('\t');
                }
                return line;
            });
            content = lines.join('\n');
        } else {
            // Raw key=value format — build from scratch
            const lines = ['# Netscape HTTP Cookie File'];
            for (const part of content.split(';')) {
                const eq = part.indexOf('=');
                if (eq < 0) continue;
                const name = part.slice(0, eq).trim();
                const value = part.slice(eq + 1).trim();
                if (name) lines.push(`.youtube.com\tTRUE\t/\tFALSE\t0\t${name}\t${value}`);
            }
            content = lines.join('\n');
        }

        writeFileSync(COOKIES_FILE, content, { mode: 0o600 });
        console.log('[Youtube] Cookies file written with proper tab formatting');
    } catch (err) {
        console.error('[Youtube] Failed to ensure cookies file:', err);
    }
}

let ytdlpBinary = 'yt-dlp';
const systemYtdlp = '/usr/local/bin/yt-dlp';
if (existsSync(systemYtdlp)) {
    ytdlpBinary = systemYtdlp;
    console.log('[Youtube] Using system yt-dlp (pip) — plugin support enabled');
} else if (ytdlExec) {
    const constants = (ytdlExec as any).constants || (ytdlExec as any).default?.constants;
    if (constants?.YOUTUBE_DL_PATH) {
        ytdlpBinary = constants.YOUTUBE_DL_PATH;
        console.log('[Youtube] Using npm-bundled yt-dlp (no plugin support)');
    }
}

// --- Startup Diagnostic ---
try {
    const versionCheck = spawnSync(ytdlpBinary, ['--version'], { encoding: 'utf8' });
    console.log(`[Youtube] yt-dlp version: ${versionCheck.stdout?.trim()}`);

    // Check if bgutil plugin is loaded by passing dummy args and checking for errors
    const potCheck = spawnSync(ytdlpBinary, 
        ['--extractor-args', 'youtubepot-bgutilhttp:base_url=http://test', '-v', '--help'],
        { encoding: 'utf8' }
    );
    const pluginLoaded = potCheck.stderr?.includes('bgutil') || potCheck.stdout?.includes('bgutil');
    console.log(`[Youtube] bgutil PO token plugin loaded: ${pluginLoaded}`);
} catch (err) {
    console.warn('[Youtube] Startup diagnostic failed:', err);
}

// Log cookie status at startup
const startupCookie = process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIE;
if (startupCookie) {
    const hasAuthCookie = startupCookie.includes('SAPISID') || startupCookie.includes('__Secure-3PAPISID');
    console.log(`[Youtube] Cookie env var present: true, length: ${startupCookie.length}, Has SAPISID: ${hasAuthCookie}`);
} else {
    console.log(`[Youtube] Cookie env var present: false`);
}
ensureCookiesFile();

// Verify cookie tab formatting
try {
    if (existsSync(COOKIES_FILE)) {
        const cookieFileContent = require('fs').readFileSync(COOKIES_FILE, 'utf8');
        const firstDataLine = cookieFileContent.split('\n').find((l: string) => l.startsWith('.youtube.com'));
        const hasRealTabs = firstDataLine?.includes('\t');
        console.log(`[Youtube] Cookie file tab check: ${hasRealTabs ? '✓ tabs OK' : '⚠️ NO TABS — file is BROKEN'}`);
    }
} catch (err) {}

let ffmpegBinary = 'ffmpeg';
if (typeof ffmpegStatic === 'string') {
    ffmpegBinary = ffmpegStatic;
}

const CLIENT_ROTATION: readonly string[] = [
    'tv_simply,android,ios',
    'android,tv_simply,ios',
    'ios,android,tv_simply',
];

// On Railway, tv_simply is the most reliable client.
// We rotate to others if it fails or is throttled.
const POTOKEN_CLIENT_ROTATION: readonly string[] = [
    'tv_simply,ios,android',   // Attempt 1: King of Bypass (try Copy Mode)
    'ios,android,tv_simply',   // Attempt 2: Most reliable (Transcode Fallback)
    'tv_simply,ios,android',   // Attempt 3: Mobile web fallback
];

function getPlayerClients(attempt = 1): string {
    const rotation = config.POTOKEN_SERVER ? POTOKEN_CLIENT_ROTATION : CLIENT_ROTATION;
    const idx = Math.max(0, Math.min(rotation.length - 1, attempt - 1));
    return rotation[idx];
}

function getAuthFlags(attempt = 1): string[] {
    ensureCookiesFile(); // Guarantee file exists before any flags are generated

    const youtubeArgs: string[] = [`player_client=${getPlayerClients(attempt)}`];

    if (config.YT_VISITOR_DATA) {
        youtubeArgs.push(`visitor_data=${config.YT_VISITOR_DATA}`);
    }

    // IMPORTANT: On Railway, fetching the webpage for mobile/TV clients 
    // triggers an instant 403 "Sign in" block. We MUST skip it.
    // HOWEVER: If we have a PO Token server, we MUST NOT skip it, because
    // the plugin needs the webpage to generate the token!
    const clients = getPlayerClients(attempt);
    const isWebClient = clients.includes('web') || clients.includes('default');
    
    if (!isWebClient && !config.POTOKEN_SERVER) {
        youtubeArgs.push('player_skip=webpage,configs');
    }

    const flags: string[] = ['--extractor-args', `youtube:${youtubeArgs.join(';')}`];

    if (config.POTOKEN_SERVER) {
        // The bgutil PO Token plugin (installed via pip) auto-loads.
        // We just need to tell it where our Railway token server lives.
        let baseUrl = config.POTOKEN_SERVER.replace(/\/$/, '');
        
        // Defensive: ensure scheme is present
        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
            baseUrl = `https://${baseUrl}`;
            console.warn(`[Youtube] ⚠️ POTOKEN_SERVER was missing https://, auto-corrected to: ${baseUrl}`);
        }

        flags.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${baseUrl}`);
        console.log(`[Youtube] getAuthFlags: Linking PO Token Provider → ${baseUrl}`);

        // Background check for token server reachability (hit the root)
        if (attempt === 1) {
            fetch(baseUrl)
                .then(r => { 
                    if (r.status !== 200 && r.status !== 405) { // 405 is fine (method not allowed)
                        console.warn(`[Youtube] ⚠️ PO Token server (${baseUrl}) returned status ${r.status}`); 
                    }
                })
                .catch(e => console.warn(`[Youtube] ⚠️ PO Token server (${baseUrl}) UNREACHABLE: ${e.message}`));
        }
    }

    const cookieExists = existsSync(COOKIES_FILE);
    if (cookieExists) {
        flags.push('--cookies', COOKIES_FILE);
        console.log(`[Youtube] getAuthFlags: Using cookies file ✓ (${COOKIES_FILE})`);
    } else {
        console.warn(`[Youtube] getAuthFlags: ⚠️ Cookies file NOT found — yt-dlp will run unauthenticated!`);
    }

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

        const results = await this.searchByQuery(query);
        return results[0] ?? null;
    }

    public static async searchByQuery(query: string): Promise<YoutubeResult[]> {
        // Primary search using yt-dlp for maximum reliability on cloud IPs
        try {
            const res = await this.searchByQueryWithYtdlp(query);
            return res;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[Youtube] yt-dlp search failed, trying youtube-sr fallback: ${message}`);

            try {
                const results = await YouTubeSR.search(query, {
                    limit: 5,
                    type: 'video',
                });

                return results.map((video) => ({
                    title: video.title ?? 'Unknown Title',
                    url: video.url,
                    id: video.id ?? '',
                    thumbnail: video.thumbnail?.url ?? '',
                    channelTitle: video.channel?.name ?? 'Unknown Channel',
                    duration: video.durationFormatted,
                    durationSeconds: Math.floor((video.duration ?? 0) / 1000),
                }));
            } catch (srError) {
                console.error(`[Youtube] All search methods failed:`, srError);
                return [];
            }
        }
    }

    private static async searchByQueryWithYtdlp(query: string, limit = 5): Promise<YoutubeResult[]> {
        const cookieFlags = getAuthFlags();
        try {
            const result = await new Promise<any>((resolve, reject) => {
                const args = [
                    `ytsearch${limit}:${query}`,
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

            const entries = result.entries || [];
            return entries.map((entry: any) => {
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
            });
        } catch (error) {
            console.error('[Youtube] yt-dlp search error:', error);
            return [];
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
            // Always use transcode mode for maximum reliability on Railway.
            const mode: StreamMode = 'transcode';
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

        // Copy mode: Prefer Opus (251/250). Fallback to anything if Opus is missing.
        // Transcode mode: Grab anything playable.
        const formatSelector = mode === 'copy'
            ? 'bestaudio[acodec=opus]/bestaudio[ext=webm][acodec=opus]/251/250/bestaudio/best'
            : 'bestaudio/best';

        const ytdlpArgs = [
            url,
            '-f', formatSelector,
            '-o', '-',
            '--no-playlist',
            '--no-warnings',
            '--no-progress',
            '--no-check-certificates',
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
                '-vn', '-map', 'a:0',
                // For Copy Mode, we try to transcode anyway to be safe (high quality libopus),
                // as bitstream-copying AAC into OGG is impossible.
                '-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k',
                '-vbr', 'on', '-application', 'audio', '-frame_duration', '20',
                '-f', 'ogg', '-loglevel', 'error', 'pipe:1',
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
