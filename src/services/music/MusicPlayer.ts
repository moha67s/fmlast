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

const playLocks = new Map<string, Promise<void>>();

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

            queue.textChannel.send('🎵 **Autoplay**: Finding similar tracks...').then(m => setTimeout(() => m.delete().catch(() => {}), 5000));

            const { LastFM } = await import('../api/LastFM');
            let similar: any[] = [];

            const manualOverride = ARTIST_OVERRIDES[currentArtist.toLowerCase()];
            if (manualOverride?.related) {
                const randomRelated = manualOverride.related
                    .sort(() => Math.random() - 0.5)
                    .slice(0, 5);
                
                for (const relatedArtist of randomRelated) {
                    try {
                        const top = await LastFM.getArtistTopTracks(relatedArtist, 3);
                        similar.push(...top);
                    } catch {}
                }
            }

            if (similar.length === 0) {
                similar = await LastFM.getSimilarTracks(currentArtist, currentTitle, 15);
            }
            
            if (!similar || similar.length === 0) {
                similar = await LastFM.getArtistTopTracks(currentArtist, 15);
            }

            if (similar && similar.length > 0) {
                // Filter tracks that are already in the queue or just played
                const recentlyPlayed = queue.tracks.slice(-20).map(t => (t.trackTitle || t.title).toLowerCase());
                
                const filtered = similar.filter((t: any) => {
                    const tName = t.name.toLowerCase();
                    return !recentlyPlayed.includes(tName) && tName !== currentTitle.toLowerCase();
                });

                const related = filtered.slice(0, 3);
                if (related.length === 0 && similar.length > 0) {
                    related.push(similar[0]);
                }

                const { TrackResolverService } = await import('../api/TrackResolverService');
                const { MetadataService } = await import('../bot/MetadataService');

                for (const t of related) {
                    const artist = t.artist?.name || t.artist?.['#text'] || currentArtist;
                    const resolved = await TrackResolverService.resolve(artist, t.name);
                    
                    const ytUrl = resolved.links.youtube;
                    if (!ytUrl) continue;

                    const trackObj: YoutubeResult = {
                        id: t.mbid || String(Math.random()),
                        title: `${artist} - ${t.name}`,
                        url: ytUrl,
                        thumbnail: resolved.artworkUrl || '',
                        channelTitle: artist,
                        artistName: artist,
                        trackTitle: t.name,
                        requesterName: 'Autoplay'
                    };

                    await MetadataService.enrich(trackObj, null, null);
                    QueueManager.addTrack(guildId, trackObj);
                }

                return QueueManager.getNextTrack(guildId);
            }
        } catch (err) {
            console.error('[MusicPlayer] Last.fm Autoplay failed:', err);
        }
        return null;
    }

    private static async processQueue(guildId: string, _skipCount = 0): Promise<void> {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        if (_skipCount > 10) {
            console.warn(`[MusicPlayer] Too many consecutive failures for guild ${guildId}, stopping`);
            this.stop(guildId);
            return;
        }

        if (queue.isPlaying && queue.currentTrack) return; 

        this.stopProgressUpdate(guildId);

        let track = QueueManager.getNextTrack(guildId) || QueueManager.getNextMixTrack(guildId);

        if (!track) {
            track = await this.handleAutoplay(guildId, queue);
        }

        if (!track) {
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

        try {
            const { LyricsService } = await import('./LyricsService');
            LyricsService.cleanupForGuild(guildId);

            console.log(`[MusicPlayer] 🎵 Resolving track for: ${track.title}`);

            if (!queue.player) throw new Error('Player not initialized');
            const node = queue.player.node;
            
            let result = await node.rest.resolve(track.url);
            if (!result || !result.data || result.loadType === 'empty' || result.loadType === 'error') {
                result = await node.rest.resolve(`ytsearch:${track.title}`);
            }

            if (!result || !result.data || result.loadType === 'error' || result.loadType === 'empty') {
                console.warn(`[MusicPlayer] ⚠️ Failed to resolve ${track.title}`);
                return this.processQueue(guildId, _skipCount + 1);
            }

            const lavalinkTrack = Array.isArray(result.data) ? result.data[0] : result.data;
            
            if (!lavalinkTrack || !lavalinkTrack.encoded) {
                console.warn(`[MusicPlayer] ⚠️ Invalid track data for ${track.title}`);
                return this.processQueue(guildId, _skipCount + 1);
            }

            await queue.player.playTrack({ track: { encoded: lavalinkTrack.encoded } });
            console.log(`[MusicPlayer] ✅ Playback initiated: ${track.title}`);

            queue.currentTrack = track;

            await MusicUIController.sendPlaybackUI(guildId, track);

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

        queue.player.removeAllListeners();

        queue.player.on('start', async () => {
            console.log(`[Lavalink] Playback started in guild ${guildId}`);
            queue.isPlaying = true;
            queue.isPaused = false;
            
            VoteSkipCommand.resetVotes(guildId);

            const track = queue.currentTrack;
            if (track) {
                try {
                    await UserHistory.findOneAndUpdate(
                        { userId: track.requesterId || 'Unknown' },
                        { 
                            $push: { 
                                lastPlayed: { 
                                    $each: [{ title: track.title, url: track.url, playedAt: new Date() }],
                                    $slice: -50 
                                } 
                            }
                        },
                        { upsert: true, new: true, setDefaultsOnInsert: true }
                    ).catch(() => {});
                } catch {}

                const title = track.trackTitle || track.title;
                VoiceStatusService.setTrackStatus(client, queue.voiceChannelId, title);
                VoiceStatusService.updatePresence(client, title);
            }

            this.startProgressUpdate(guildId);
            MusicUIController.updateNowPlayingMessage(guildId);
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

    private static startProgressUpdate(guildId: string) {
        const queue = QueueManager.getQueue(guildId);
        if (!queue) return;

        this.stopProgressUpdate(guildId);

        queue.progressInterval = setInterval(() => {
            MusicUIController.updateNowPlayingMessage(guildId);
        }, 15000);
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
            const voiceChannel = await guild.channels.fetch(queue.voiceChannelId) as VoiceChannel;
            if (voiceChannel) {
                await guild.members.fetch(); 
                const listeners = voiceChannel.members.filter(m => !m.user.bot).map(m => m.id);
                
                const art = track.artistName || track.channelTitle.replace(' - Topic', '');
                const tit = track.trackTitle || track.title;

                if (listeners.length > 0 && art && tit) {
                    const res = await ScrobbleService.scrobbleForUsers(listeners, { artist: art, track: tit });
                    const successCount = res.filter(r => r.status === 'fulfilled').length;
                    (track as any).scrobbleCount = successCount;
                    MusicUIController.updateNowPlayingMessage(guildId);
                }
            }
        } catch (err: any) {
            console.error(`[MusicPlayer] Scrobble error:`, err.message);
        }
    }
}
