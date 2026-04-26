import { shoukaku, client } from '../../index';
import { Player, Track, TrackExceptionEvent, TrackEndEvent } from 'shoukaku';
import { UserHistory } from '../../models/UserHistory';
import { Youtube, YoutubeResult } from '../api/Youtube';
import { VoiceChannel, TextChannel, Message, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { ScrobbleService } from '../bot/ScrobbleService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { createProgressBar, formatDuration } from '../../utils/formatDuration';
import { config } from '../../../config';
import { QueueManager, GuildQueue, RepeatMode } from './QueueManager';
import { VoiceStatusService } from './VoiceStatusService';
import { MusicCardService } from './MusicCardService';
import VoteSkipCommand from '../../commands/music/voteskip';
import { AttachmentBuilder } from 'discord.js';

const playLocks = new Map<string, Promise<void>>();
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 5000;

export class MusicPlayer {
    static async join(guildId: string, voiceChannelId: string, textChannel: TextChannel): Promise<GuildQueue> {
        let queue = QueueManager.getQueue(guildId);

        if (!queue || !queue.player) {
            const nodes = shoukaku.nodes;
            let player;
            let lastError;

            // Try all available nodes before giving up
            for (const [name, node] of nodes) {
                try {
                    console.log(`[MusicPlayer] 🛰️ Attempting to join voice using node: ${name}`);
                    const guild = client.guilds.cache.get(guildId);
                    const shardId = guild?.shardId ?? 0;

                    player = await shoukaku.joinVoiceChannel({
                        guildId: guildId,
                        channelId: voiceChannelId,
                        shardId: shardId,
                        deaf: true
                    });
                    console.log(`[MusicPlayer] ✅ Successfully joined using node: ${name}`);
                    break; 
                } catch (err: any) {
                    console.warn(`[MusicPlayer] ⚠️ Failed to join using node ${name}: ${err.message}`);
                    lastError = err;
                    continue;
                }
            }

            if (!player) throw lastError || new Error('All music nodes failed to join voice.');

            if (!queue) {
                queue = QueueManager.createQueue(guildId, textChannel, voiceChannelId, player);
            } else {
                queue.player = player;
            }

            // Hook events immediately
            this.setupPlayerEvents(guildId);
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
            queue.player.stopTrack();
            return true;
        }
        return false;
    }

    static stop(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue) {
            VoiceStatusService.clearStatus(client, queue.voiceChannelId);
            VoiceStatusService.updatePresence(client, null);
        }
        QueueManager.deleteQueue(guildId);
        return true;
    }

    static shuffle(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue) {
            for (let i = queue.tracks.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
            }
            this.updateNowPlayingMessage(guildId);
            return true;
        }
        return false;
    }

    static pause(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue && queue.player && !queue.isPaused) {
            queue.player.setPaused(true);
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
            queue.player.setPaused(false);
            queue.isPaused = false;
            this.startProgressUpdate(guildId);
            this.updateNowPlayingMessage(guildId);
            return true;
        }
        return false;
    }

    static async getLyrics(guildId: string): Promise<any | null> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue?.currentTrack) return null;

        const track = queue.currentTrack;
        const artist = track.artistName || track.channelTitle.replace(' - Topic', '');
        const title = track.trackTitle || track.title.replace(/\(.*?\)|\[.*?\]/g, '').trim();
        const duration = track.durationSeconds || 0;

        try {
            // LRCLib — free, no auth, returns synced + plain lyrics
            const params = new URLSearchParams({
                artist_name: artist,
                track_name: title,
                ...(duration ? { duration: String(duration) } : {})
            });

            const res = await fetch(`https://lrclib.net/api/get?${params}`, {
                headers: { 'User-Agent': 'fm-discord-bot/1.0' }
            });

            if (!res.ok) return null;

            const data = await res.json() as any;

            // Return in the same format your LyricsCommand expects
            if (data.syncedLyrics) {
                // Parse LRC format into lines array
                const lines = data.syncedLyrics
                    .split('\n')
                    .filter((l: string) => l.match(/^\[\d+:\d+/))
                    .map((l: string) => {
                        const match = l.match(/^\[(\d+):(\d+\.\d+)\](.*)/);
                        if (!match) return null;
                        const ms = (parseInt(match[1]) * 60 + parseFloat(match[2])) * 1000;
                        return { timestamp: Math.floor(ms), line: match[3].trim() };
                    })
                    .filter(Boolean);

                return { lines, text: data.plainLyrics };
            }

            if (data.plainLyrics) {
                return { lines: null, text: data.plainLyrics };
            }

            return null;
        } catch (err: any) {
            console.warn('[MusicPlayer] LRCLib lyrics failed:', err.message);
            return null;
        }
    }

    static async setFilters(guildId: string, filters: any): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (queue && queue.player) {
            await queue.player.setFilters(filters);
        }
    }

    static async seek(guildId: string, positionMs: number): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (queue && queue.player) {
            await queue.player.seekTo(positionMs);
        }
    }

    static async setVolume(guildId: string, volume: number): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (queue && queue.player) {
            await queue.player.setGlobalVolume(volume);
        }
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
            // Autoplay logic
            if (queue.autoplay && queue.currentTrack) {
                try {
                    console.log(`[MusicPlayer] 🤖 Autoplay triggered for guild ${guildId}`);
                    queue.textChannel.send('🎵 **Autoplay**: Searching for related tracks...').then(m => setTimeout(() => m.delete().catch(() => {}), 5000));

                    const YouTube = (await import('youtube-sr')).default as any;
                    // Search for the artist + title + "official audio" for better quality
                    const query = `${queue.currentTrack.artistName || ''} ${queue.currentTrack.trackTitle || queue.currentTrack.title} official music`.trim();
                    const results = await YouTube.search(query, { limit: 10, type: 'video' });
                    
                    if (results && results.length > 0) {
                        // Filter out tracks with the same title or extremely long/short durations
                        const currentTitle = (queue.currentTrack.trackTitle || queue.currentTrack.title).toLowerCase();
                        
                        const filtered = results.filter((v: any) => {
                            const vTitle = v.title.toLowerCase();
                            // Avoid exact same video titles from other channels
                            if (vTitle.includes(currentTitle) && vTitle.length < currentTitle.length + 5) return false;
                            // Avoid non-music keywords
                            const junk = ['مدفع', 'رمضان', 'علاء حسين', 'محمد عماد', 'clip', 'vlog', 'challenge', 'funny', 'comedy'];
                            if (junk.some(j => vTitle.includes(j))) return false;
                            // Avoid long mixes (> 15 mins) or short clips (< 1 min)
                            if (v.duration > 900000 || v.duration < 60000) return false;
                            return true;
                        });

                        const related = filtered.slice(0, 3); 
                        if (related.length === 0) {
                            // Fallback if filtering was too strict
                            related.push(results[0]);
                        }

                        for (const v of related) {
                            QueueManager.addTrack(guildId, {
                                title: v.title!,
                                url: v.url,
                                id: v.id!,
                                thumbnail: v.thumbnail?.url!,
                                duration: v.durationFormatted,
                                durationSeconds: Math.floor(v.duration / 1000),
                                channelTitle: v.channel?.name!,
                                requesterName: 'Autoplay'
                            });
                        }
                        track = QueueManager.getNextTrack(guildId);
                    }
                } catch (err) {
                    console.error('[MusicPlayer] Autoplay failed:', err);
                }
            }
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
            // Cleanup any active lyrics panels from the previous song
            const { LyricsService } = await import('./LyricsService');
            LyricsService.cleanupForGuild(guildId);

            console.log(`[MusicPlayer] 🎵 Resolving track for: ${track.title}`);

            if (!queue.player) throw new Error('Player not initialized');
            const node = queue.player.node;
            
            // Try resolving as direct link first, then search
            let result = await node.rest.resolve(track.url);
            if (!result || !result.data || result.loadType === 'empty' || result.loadType === 'error') {
                result = await node.rest.resolve(`ytsearch:${track.title}`);
            }

            if (!result || !result.data || result.loadType === 'error' || result.loadType === 'empty') {
                console.warn(`[MusicPlayer] ⚠️ Failed to resolve ${track.title}`);
                return this.processQueue(guildId, _skipCount + 1);
            }

            // Lavalink v4 returns an array for search, but an object for tracks
            const lavalinkTrack = Array.isArray(result.data) ? result.data[0] : result.data;
            
            if (!lavalinkTrack || !lavalinkTrack.encoded) {
                console.warn(`[MusicPlayer] ⚠️ Invalid track data for ${track.title}`);
                return this.processQueue(guildId, _skipCount + 1);
            }

            // Correct Shoukaku v4 format: { track: { encoded: string } }
            if (!queue.player) throw new Error('Player not initialized');
            await queue.player.playTrack({ 
                track: { 
                    encoded: lavalinkTrack.encoded 
                } 
            });

            console.log(`[MusicPlayer] ✅ Playback initiated: ${track.title}`);

            // Enrich metadata for playlist tracks that only have a combined title
            if (!track.artistName || !track.trackTitle) {
                try {
                    const { TrackResolverService } = await import('../api/TrackResolverService');
                    const sep = [' - ', ' – ', ' — '].find(s => track.title.includes(s));
                    let artist = '', title = track.title;
                    if (sep) {
                        const parts = track.title.split(sep);
                        // 1. Initial Split
                        let left = parts[0].trim();
                        let right = parts.slice(1).join(sep).replace(/\(.*?\)|\[.*?\]/g, '').trim();

                        // 2. Comprehensive Swap Detection
                        const bigArtists = ['cigarettes after sex', 'cas', 'tv girl', 'the weeknd', 'lana del rey', 'zaid khaled', 'el waili', 'arctic monkeys'];
                        const isBig = (s: string) => bigArtists.some(ba => s.toLowerCase().includes(ba) || ba.includes(s.toLowerCase()) && s.length > 5);

                        if (isBig(right)) {
                            // Already in Artist - Song or Song - Artist?
                            // If right is the artist, swap it to the left.
                            artist = right;
                            title = left;
                        } else if (isBig(left)) {
                            // Left is the artist, keep it there
                            artist = left;
                            title = right;
                        } else {
                            // Default fallback
                            artist = left;
                            title = right;
                        }
                    }

                    // Global Abbreviation Fixes
                    if (artist.toLowerCase() === 'cas') artist = 'Cigarettes After Sex';
                    
                    const resolved = await TrackResolverService.resolve(artist, title);

                    track.artistName  = resolved.artist  || artist  || 'Unknown Artist';
                    track.trackTitle  = resolved.title   || title;
                    track.artworkUrl  = resolved.artworkUrl ?? track.artworkUrl ?? track.thumbnail;
                    if (resolved.durationMs > 0) {
                        track.durationSeconds = Math.floor(resolved.durationMs / 1000);
                        const m = Math.floor(track.durationSeconds / 60);
                        const s = track.durationSeconds % 60;
                        track.duration = `${m}:${s.toString().padStart(2, '0')}`;
                    }

                    // Fetch Last.fm stats (listeners, plays) — same as MetadataService.enrich
                    try {
                        const { LastFM } = await import('../api/LastFM');
                        const lfmInfo = await LastFM.getTrackInfo(track.artistName, track.trackTitle);
                        const fmt = (n: string) => parseInt(n).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
                        const parts: string[] = [];
                        if (track.duration) parts.push(track.duration);
                        if (lfmInfo?.listeners) parts.push(`${fmt(lfmInfo.listeners)} listeners`);
                        if (lfmInfo?.playcount) parts.push(`${fmt(lfmInfo.playcount)} plays`);
                        if (parts.length > 0) track.statsText = `\n${parts.join(' • ')}`;
                    } catch {
                        if (track.duration) track.statsText = `\n${track.duration}`;
                    }
                } catch { /* non-fatal */ }
            }

            queue.currentTrack = track;

            // Render UI
            await this.sendPlaybackUI(guildId, track);


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

    private static setupPlayerEvents(guildId: string): void {
        const queue = QueueManager.getQueue(guildId);
        if (!queue || !queue.player) return;

        // Clear existing listeners to prevent multiple triggers skipping tracks
        queue.player.removeAllListeners();

        queue.player.on('start', async () => {
            console.log(`[Lavalink] Playback started in guild ${guildId}`);
            queue.isPlaying = true;
            queue.isPaused = false;
            
            // Reset votes
            VoteSkipCommand.resetVotes(guildId);

            const track = queue.currentTrack;
            if (track) {
                // Save to history (MongoDB)
                try {
                    await UserHistory.findOneAndUpdate(
                        { userId: track.requesterId || 'Unknown' },
                        { 
                            $push: { 
                                lastPlayed: { 
                                    $each: [{ title: track.title, url: track.url, playedAt: new Date() }],
                                    $slice: -50 // Keep last 50
                                } 
                            }
                        },
                        { upsert: true, new: true, setDefaultsOnInsert: true }
                    ).catch(() => {});
                } catch {}

                // VC Status and Presence
                const title = track.trackTitle || track.title;
                VoiceStatusService.setTrackStatus(client, queue.voiceChannelId, title);
                VoiceStatusService.updatePresence(client, title);
            }

            this.startProgressUpdate(guildId);
            this.updateNowPlayingMessage(guildId);
        });

        queue.player.on('stuck', () => {
            console.warn(`[Lavalink] Track stuck in guild ${guildId}, skipping...`);
            if (queue.player) queue.player.stopTrack();
        });

        queue.player.on('end', (data) => {
            console.log(`[Lavalink] Track ended in guild ${guildId}. Reason: ${data.reason}`);
            
            if (data.reason === 'replaced') return;
            
            queue.isPlaying = false;
            this.stopProgressUpdate(guildId);
            
            VoiceStatusService.clearStatus(client, queue.voiceChannelId);
            VoiceStatusService.updatePresence(client, null);

            this.processQueue(guildId).catch(err => {
                console.error(`[MusicPlayer] Error in processQueue after track end:`, err);
            });
        });

        queue.player.on('exception', (data) => {
            console.error(`[Lavalink] Playback exception in guild ${guildId}:`, data.exception);
            queue.isPlaying = false;
            this.processQueue(guildId, 1).catch(() => {});
        });
    }

    private static async sendPlaybackUI(guildId: string, track: YoutubeResult) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        // Delete previous NP message to keep channel clean
        if (queue.nowPlayingMessage) {
            queue.nowPlayingMessage.delete().catch(() => {});
            queue.nowPlayingMessage = undefined;
        }

        // Reset lyrics flag for new track
        queue.hasLyrics = false;


        // Check for lyrics availability (fast check)
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
        } catch {}

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
        let autoplayInfo = '';
        if (queue) {
            if (queue.repeatMode === 'one') repeatInfo = ' 🔂';
            else if (queue.repeatMode === 'all') repeatInfo = ' 🔁';
            if (queue.autoplay) autoplayInfo = ' 🤖';
        }

        const scrobbleInfo = (track as any).scrobbleCount ? ` • 🚀 Scrobbling for ${(track as any).scrobbleCount} users` : '';
        const statsLine = track.statsText ? (track.statsText.startsWith('\n') ? track.statsText : `\n${track.statsText}`) : '';

        const coverUrl = track.artworkUrl || track.thumbnail || 'https://i.imgur.com/Gis9d79.png';
        const artistDisplay = track.artistName || (track.channelTitle || '').replace(' - Topic', '') || 'Unknown Artist';
        const titleDisplay = (track.trackTitle || track.title || 'Unknown Track').replace(/\[.*?\]|\(.*?\)/g, '').trim();

        const builder = new ComponentsV2()
            .setAccent(isPaused ? 0xFFA500 : 0x1DB954)
            .addThumbnail(coverUrl, 
                `### 🎵 ${artistDisplay} - ${titleDisplay}${repeatInfo}${autoplayInfo}\n` +
                `${statsLine ? statsLine.trimStart() + '\n\n' : ''}` +
                `${progressBar} ${timeInfo}\n\n` +
                `-# Added to queue by ${track.requesterName || 'Unknown'}${scrobbleInfo}`
            )
            .addSeparator();

        const repeatLabels: Record<string, string> = { 'off': '🔁 Off', 'one': '🔂 One', 'all': '🔁 All' };
        const repeatMode = queue?.repeatMode || 'off';

        // ROW 1: Playback Controls
        builder.addRow([
            { type: 2, style: 2, label: isPaused ? '▶️' : '⏸️', custom_id: isPaused ? `mp-resume:${guildId}` : `mp-pause:${guildId}` },
            { type: 2, style: 2, label: '⏭️', custom_id: `mp-skip:${guildId}` },
            { type: 2, style: 2, label: repeatLabels[repeatMode] || '🔁', custom_id: `mp-repeat:${guildId}` },
            { type: 2, style: 2, label: '🔊', custom_id: `mp-volume:${guildId}` },
            { type: 2, style: 4, label: '🛑', custom_id: `mp-stop:${guildId}` }
        ]);

        // ROW 2: Library & Info
        const row2 = [
            { type: 2, style: 2, label: '🔀 Shuffle', custom_id: `mp-shuffle:${guildId}` },
            { type: 2, style: 2, label: '📄 Queue', custom_id: `mp-queue:${guildId}` },
            { type: 2, style: 2, label: 'ℹ️ Info', custom_id: `mp-trackinfo:${guildId}` }
        ];
        if (queue?.hasLyrics) {
            row2.push({ type: 2, style: 1, label: '🎤 Lyrics', custom_id: `mp-lyrics:${guildId}` });
        }
        builder.addRow(row2);

        // ROW 3: Effects Select Menu
        builder.addRow([{
            type: 3,
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

        const elapsed = queue.player ? Math.floor(queue.player.position / 1000) : 0;
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
                }
            }
        } catch (err: any) {
            console.error(`[MusicPlayer] Scrobble error:`, err.message);
        }
    }
}
