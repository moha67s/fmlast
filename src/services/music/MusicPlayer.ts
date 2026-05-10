import { shoukaku, client } from '../../index';
import { Player } from 'shoukaku';
import { UserHistory } from '../../models/UserHistory';
import { YoutubeResult } from '../api/Youtube';
import { VoiceChannel, TextChannel } from 'discord.js';
import { ScrobbleService } from '../bot/ScrobbleService';
import { config } from '../../../config';
import { QueueManager, GuildQueue } from './QueueManager';
import { VoiceStatusService } from './VoiceStatusService';
import VoteSkipCommand from '../../commands/music/voteskip';
import { MusicUIController } from './MusicUIController';

/**
 * Global mutex for each guild to ensure only one playback process runs at a time.
 */
const playbackMutex = new Map<string, boolean>();

const ARTIST_OVERRIDES: Record<string, { cluster: string, related?: string[] }> = {
    'zaf': {
        cluster: 'arabic',
        related: ['young giza', 'HAITHAM', 'ZDAN', 'zalka', 'ZIEN4L', 'ghassan', 'dokshan', 'Wg sad', 'kingoo', 'omar gangster', 'begad', '$savage', 'karim enzo', 'salah tayer', 'qetoo']
    },
};

export class MusicPlayer {
    static async join(guildId: string, voiceChannelId: string, textChannel: TextChannel): Promise<GuildQueue> {
        let queue = QueueManager.getQueue(guildId);

        if (!queue || !queue.player) {
            const nodes = shoukaku.nodes;
            let player: Player | undefined;
            let lastError;

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

            this.setupPlayerEvents(guildId);
        }

        return queue;
    }

    static async play(guildId: string, track?: YoutubeResult): Promise<number> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return 0;

        if (track) {
            QueueManager.addTrack(guildId, track);
        }

        // Kickstart the queue process
        this.processQueue(guildId).catch(err => {
            console.error(`[MusicPlayer] play() processQueue error:`, err);
        });

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
        playbackMutex.delete(guildId);
        return true;
    }

    static shuffle(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue) {
            QueueManager.shuffleQueue(guildId);
            MusicUIController.updateNowPlayingMessage(guildId);
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
            MusicUIController.updateNowPlayingMessage(guildId);
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
            MusicUIController.updateNowPlayingMessage(guildId);
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

            if (data.syncedLyrics) {
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

    static toggleAutoplay(guildId: string): boolean {
        const queue = QueueManager.getQueue(guildId);
        if (queue) {
            queue.autoplay = !queue.autoplay;
            this.updateNowPlayingMessage(guildId);
            return queue.autoplay;
        }
        return false;
    }

    static async updateNowPlayingMessage(guildId: string): Promise<void> {
        return MusicUIController.updateNowPlayingMessage(guildId);
    }

    private static async handleAutoplay(guildId: string, queue: GuildQueue) {
        if (!queue.autoplay || !queue.currentTrack) return null;

        try {
            console.log(`[MusicPlayer] 🤖 Last.fm Autoplay triggered for guild ${guildId}`);
            const currentArtist = queue.currentTrack.artistName || '';
            const currentTitle = queue.currentTrack.trackTitle || queue.currentTrack.title;
            if (!currentArtist) return null;

            // Notify user
            queue.textChannel.send('🎵 **Autoplay**: Finding similar tracks...').then(m => setTimeout(() => m.delete().catch(() => {}), 5000));

            const { LastFM } = await import('../api/LastFM');
            const { TrackResolverService } = await import('../api/TrackResolverService');
            const { MetadataService } = await import('../bot/MetadataService');

            let similar: any[] = [];
            const manualOverride = ARTIST_OVERRIDES[currentArtist.toLowerCase()];
            
            if (manualOverride?.related) {
                const randomRelated = manualOverride.related.sort(() => Math.random() - 0.5).slice(0, 5);
                for (const relatedArtist of randomRelated) {
                    try {
                        const top = await LastFM.getArtistTopTracks(relatedArtist, 3);
                        similar.push(...top);
                    } catch {}
                }
            }

            if (similar.length === 0) {
                similar = await LastFM.getSimilarTracks(currentArtist, currentTitle, 20);
            }
            if (!similar || similar.length === 0) {
                similar = await LastFM.getArtistTopTracks(currentArtist, 20);
            }

            if (similar && similar.length > 0) {
                // Deduplicate
                const seen = new Set<string>();
                const uniqueSimilar = similar.filter(t => {
                    const key = `${t.artist?.name || t.artist?.['#text']}-${t.name}`.toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                }).sort(() => Math.random() - 0.5);

                const recentlyPlayed = [currentTitle.toLowerCase()];
                const filtered = uniqueSimilar.filter((t: any) => {
                    const tName = t.name.toLowerCase();
                    return !recentlyPlayed.includes(tName);
                });

                const candidates = filtered.slice(0, 15);
                let firstTrack: YoutubeResult | null = null;
                
                console.log(`[MusicPlayer] 🤖 Checking ${candidates.length} candidates for autoplay...`);

                for (const t of candidates) {
                    const artist = t.artist?.name || t.artist?.['#text'] || currentArtist;
                    try {
                        const resolved = await TrackResolverService.resolve(artist, t.name);
                        if (!resolved.links.youtube) continue;

                        const trackObj: YoutubeResult = {
                            id: t.mbid || String(Math.random()),
                            title: `${artist} - ${t.name}`,
                            url: resolved.links.youtube,
                            thumbnail: resolved.artworkUrl || '',
                            channelTitle: artist,
                            artistName: artist,
                            trackTitle: t.name,
                            requesterName: 'Autoplay'
                        };

                        await MetadataService.enrich(trackObj, null, null);
                        
                        if (!firstTrack) {
                            firstTrack = trackObj;
                            console.log(`[MusicPlayer] 🤖 Autoplay match found: ${trackObj.title}. Starting playback.`);
                            
                            // Background resolve 2 more tracks
                            this.backgroundAutoplayResolve(guildId, candidates.slice(candidates.indexOf(t) + 1));
                            break; 
                        }
                    } catch { continue; }
                }

                return firstTrack;
            }
        } catch (err) {
            console.error('[MusicPlayer] Last.fm Autoplay failed:', err);
        }
        return null;
    }

    private static async backgroundAutoplayResolve(guildId: string, candidates: any[]) {
        const { TrackResolverService } = await import('../api/TrackResolverService');
        const { MetadataService } = await import('../bot/MetadataService');
        
        let addedCount = 0;
        for (const t of candidates) {
            const artist = t.artist?.name || t.artist?.['#text'];
            if (!artist) continue;
            try {
                const resolved = await TrackResolverService.resolve(artist, t.name);
                if (!resolved.links.youtube) continue;

                const trackObj: YoutubeResult = {
                    id: t.mbid || String(Math.random()),
                    title: `${artist} - ${t.name}`,
                    url: resolved.links.youtube,
                    thumbnail: resolved.artworkUrl || '',
                    channelTitle: artist,
                    artistName: artist,
                    trackTitle: t.name,
                    requesterName: 'Autoplay'
                };

                await MetadataService.enrich(trackObj, null, null);
                QueueManager.addTrack(guildId, trackObj);
                addedCount++;
                if (addedCount >= 2) break;
            } catch { continue; }
        }
        console.log(`[MusicPlayer] 🤖 Background autoplay resolve finished. Added ${addedCount} tracks.`);
    }

    private static async processQueue(guildId: string, _skipCount = 0): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        if (playbackMutex.get(guildId)) {
            console.log(`[MusicPlayer] ⏳ processQueue already running for guild ${guildId}, skipping.`);
            return;
        }
        playbackMutex.set(guildId, true);

        try {
            if (_skipCount > 5) {
                console.warn(`[MusicPlayer] 🛑 Too many consecutive failures for guild ${guildId}, stopping.`);
                this.stop(guildId);
                return;
            }

            if (queue.isPlaying) {
                console.log(`[MusicPlayer] ⏩ Already playing in guild ${guildId}, skipping processQueue.`);
                playbackMutex.delete(guildId);
                return;
            }

            this.stopProgressUpdate(guildId);

            let track = QueueManager.getNextTrack(guildId) || QueueManager.getNextMixTrack(guildId);

            if (!track) {
                console.log(`[MusicPlayer] 🤖 Queue empty, triggering autoplay for guild ${guildId}...`);
                track = await this.handleAutoplay(guildId, queue);
            }

            if (!track) {
                console.log(`[MusicPlayer] 🏁 Queue concluded for guild ${guildId}.`);
                queue.currentTrack = null;
                queue.isPlaying = false;
                queue.textChannel.send('✅ **Queue concluded.** Disconnecting in 5 minutes if inactive.').catch(() => { });

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

            console.log(`[MusicPlayer] 🎵 Preparing to play: ${track.title}`);
            const { LyricsService } = await import('./LyricsService');
            LyricsService.cleanupForGuild(guildId);

            if (!queue.player) throw new Error('Player not initialized');
            
            const nodes = Array.from(shoukaku.nodes.values());
            let lavalinkTrack = null;

            for (const node of nodes) {
                if (node.state !== 1) continue;
                try {
                    let res;
                    const searchStr = track.artistName && track.trackTitle ? `${track.artistName} ${track.trackTitle}` : track.title;
                    
                    if (track._failedFallback) {
                        console.log(`[MusicPlayer] 🔍 Retrying on node ${node.name} with spsearch/scsearch: ${searchStr}`);
                        res = await node.rest.resolve(`spsearch:${searchStr}`);
                        if (!res || !res.data || res.loadType === 'empty' || res.loadType === 'error') {
                            res = await node.rest.resolve(`scsearch:${searchStr}`);
                        }
                    } else {
                        console.log(`[MusicPlayer] 🔍 Resolving on node ${node.name}: ${track.url || track.title}`);
                        res = await node.rest.resolve(track.url);
                        if (!res || !res.data || res.loadType === 'empty' || res.loadType === 'error') {
                            res = await node.rest.resolve(`spsearch:${searchStr}`);
                        }
                        if (!res || !res.data || res.loadType === 'empty' || res.loadType === 'error') {
                            res = await node.rest.resolve(`ytmsearch:${searchStr}`);
                        }
                        if (!res || !res.data || res.loadType === 'empty' || res.loadType === 'error') {
                            res = await node.rest.resolve(`ytsearch:${track.title}`);
                        }
                    }

                    if (res && res.data && res.loadType !== 'empty' && res.loadType !== 'error') {
                        lavalinkTrack = Array.isArray(res.data) ? res.data[0] : res.data;
                        break;
                    }
                } catch (e: any) { 
                    console.warn(`[MusicPlayer] ⚠️ Node ${node.name} resolution failed: ${e.message}`);
                    continue; 
                }
            }

            if (!lavalinkTrack || !lavalinkTrack.encoded) {
                console.warn(`[MusicPlayer] ⚠️ Failed to resolve ${track.title} on all nodes. Skipping...`);
                queue.isPlaying = false;
                playbackMutex.delete(guildId);
                return this.processQueue(guildId, _skipCount + 1);
            }

            queue.isPlaying = true;
            queue.currentTrack = track; // Set BEFORE playTrack to avoid race condition
            queue.lastPlayedTrack = track;
            
            // Send UI first and wait for it
            await MusicUIController.sendPlaybackUI(guildId, track).catch(e => console.error(`[MusicPlayer] UI Error:`, e));

            // Then start audio
            await queue.player.playTrack({ track: { encoded: lavalinkTrack.encoded } });
            
            console.log(`[MusicPlayer] ✅ Playback started: ${track.title}`);
            
            // Background status updates
            const displayTitle = track.artistName ? `${track.artistName} - ${track.trackTitle || track.title}` : track.title;
            VoiceStatusService.setTrackStatus(client, queue.voiceChannelId, displayTitle).catch(() => {});
            VoiceStatusService.updatePresence(client, displayTitle).catch(() => {});

            if (track.artistName && track.trackTitle) {
                this.handleScrobbling(guildId, track).catch(e => console.error(`[MusicPlayer] Scrobbling Error:`, e));
            }
        } catch (err: any) {
            console.error(`[MusicPlayer] ❌ Critical Playback Error for guild ${guildId}:`, err);
            queue.textChannel.send(`❌ **Playback Failed**: ${err.message || 'Unknown error'}. Skipping...`);
            queue.isPlaying = false;
            playbackMutex.delete(guildId);
            this.processQueue(guildId, _skipCount + 1).catch(() => { });
        } finally {
            playbackMutex.delete(guildId);
        }
    }

    private static setupPlayerEvents(guildId: string): void {
        const queue = QueueManager.getQueue(guildId);
        if (!queue || !queue.player) return;

        queue.player.removeAllListeners();

        let exceptionPending = false;
        let endTimeout: NodeJS.Timeout | null = null;

        queue.player.on('start', async () => {
            console.log(`[Lavalink] Playback started in guild ${guildId}`);
            queue.isPlaying = true;
            queue.isPaused = false;
            queue.lastUpdate = Date.now();
            queue.lastStart = Date.now();
            
            VoteSkipCommand.resetVotes(guildId);
            this.startProgressUpdate(guildId);
            MusicUIController.updateNowPlayingMessage(guildId).catch(() => {});
        });

        queue.player.on('update', () => {
            queue.lastUpdate = Date.now();
        });

        queue.player.on('stuck', () => {
            console.warn(`[Lavalink] Track stuck in guild ${guildId}, skipping...`);
            if (queue.player) queue.player.stopTrack();
        });

        queue.player.on('end', (data) => {
            console.log(`[Lavalink] Track ended in guild ${guildId}. Reason: ${data.reason}`);
            if (data.reason === 'replaced') return;
            if (exceptionPending) {
                console.log(`[MusicPlayer] ⏭ End event suppressed — exception is handling retry.`);
                return;
            }
            
            // Check for silent stream failure (finished instantly)
            const playDuration = Date.now() - (queue.lastStart || 0);
            if (data.reason === 'finished' && playDuration < 2000 && queue.lastPlayedTrack && !queue.lastPlayedTrack._failedFallback) {
                console.log(`[MusicPlayer] ⚠️ Track finished instantly (possible silent stream failure). Triggering fallback...`);
                const failedTrack = queue.lastPlayedTrack;
                failedTrack._failedFallback = true;
                failedTrack.url = ''; 
                queue.tracks.unshift(failedTrack);
                
                if (endTimeout) clearTimeout(endTimeout);
                this.processQueue(guildId, 1).catch(() => {});
                return;
            }
            
            queue.isPlaying = false;
            this.stopProgressUpdate(guildId);
            
            VoiceStatusService.clearStatus(client, queue.voiceChannelId);
            VoiceStatusService.updatePresence(client, null);

            endTimeout = setTimeout(() => {
                if (exceptionPending) return;
                this.processQueue(guildId).catch(err => {
                    console.error(`[MusicPlayer] End event processQueue error:`, err);
                });
            }, 250);
        });

        queue.player.on('exception', (data) => {
            console.error(`[Lavalink] Playback exception in guild ${guildId}:`, data.exception);
            exceptionPending = true;
            queue.isPlaying = false;
            playbackMutex.delete(guildId);
            
            if (endTimeout) {
                clearTimeout(endTimeout);
                endTimeout = null;
                console.log(`[MusicPlayer] ⏭ End event processQueue cancelled due to incoming exception.`);
            }

            const failedTrack = queue.lastPlayedTrack;
            if (failedTrack && !failedTrack._failedFallback) {
                console.log(`[MusicPlayer] 🔄 Retrying track with fallback sources...`);
                failedTrack._failedFallback = true;
                failedTrack.url = ''; // Clear URL to force search
                queue.tracks.unshift(failedTrack);
            }
            
            setTimeout(() => {
                exceptionPending = false;
                this.processQueue(guildId, 1).catch(() => {});
            }, 250);
        });
    }

    private static startProgressUpdate(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue || queue.progressInterval) return;

        queue.progressInterval = setInterval(() => {
            MusicUIController.updateNowPlayingMessage(guildId).catch(() => {});
        }, 5000);
    }

    private static stopProgressUpdate(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (queue?.progressInterval) {
            clearInterval(queue.progressInterval);
            queue.progressInterval = undefined;
        }
    }

    private static async handleScrobbling(guildId: string, track: YoutubeResult) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;
        try {
            const guild = queue.textChannel.guild;
            const voiceChannel = guild.channels.cache.get(queue.voiceChannelId) as VoiceChannel;
            if (voiceChannel) {
                const listeners = voiceChannel.members.filter(m => !m.user.bot).map(m => m.id);
                if (listeners.length === 0) return;

                const art = track.artistName || track.channelTitle.replace(' - Topic', '');
                const tit = track.trackTitle || track.title;

                if (art && tit) {
                    const res = await ScrobbleService.scrobbleForUsers(listeners, { artist: art, track: tit });
                    const successCount = res.filter(r => r.status === 'fulfilled').length;
                    (track as any).scrobbleCount = successCount;
                    MusicUIController.updateNowPlayingMessage(guildId).catch(() => {});
                }
            }
        } catch (err: any) {
            console.error(`[MusicPlayer] Scrobble error:`, err.message);
        }
    }
}
