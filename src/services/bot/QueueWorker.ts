import { Queue, Worker, Job } from 'bullmq';
import { prisma, pool } from '../../database/client';
import { Prisma } from '@prisma/client';
import { LastFM } from '../api/LastFM';
import { CrownService } from './CrownService';
import IORedis from 'ioredis';
import { LoggerService } from './LoggerService';
import { IdResolutionService } from './IdResolutionService';
import { CacheService } from './CacheService';
import { LRUCache } from 'lru-cache';
import { randomUUID } from 'crypto';

const REDIS_URL = process.env.REDIS_URL?.replace(/^["']|["']$/g, '') || '';

/**
 * High-performance bulk insert for user_plays.
 * Builds a single multi-row VALUES SQL statement per batch (up to 500 rows).
 * 10-50x faster than Prisma createMany on large datasets — mirrors FMBot's
 * PostgreSQLCopyHelper strategy.
 */
async function bulkInsertPlays(rows: {
    userId: string;
    artistId: string | null;
    trackId: string | null;
    albumId: string | null;
    artistName: string;
    trackName: string;
    albumName: string | null;
    timePlayed: Date;
}[]): Promise<void> {
    if (rows.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values: any[] = [];
        const placeholders = chunk.map((r, idx) => {
            const b = idx * 9;
            values.push(
                randomUUID(),
                r.userId,
                r.artistId || null,
                r.trackId || null,
                r.albumId || null,
                r.artistName,
                r.trackName,
                r.albumName || null,
                r.timePlayed
            );
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`;
        }).join(',');
        await pool.query(
            `INSERT INTO user_plays (id,user_id,artist_id,track_id,album_id,artist_name,track_name,album_name,time_played)
             VALUES ${placeholders}
             ON CONFLICT (user_id, time_played, artist_name, track_name) DO NOTHING`,
            values
        );
    }
}


const connectionConfig = {
    maxRetriesPerRequest: null,
    enableOfflineQueue: true,
    connectTimeout: 10000,
};

if (!REDIS_URL) {
    console.warn("⚠️ REDIS_URL is missing. Background indexing will not start.");
}

// BullMQ Best Practice: Separate connections for Queue and Worker
// Two separate queues mirroring FMBot's priority architecture:
// - Delta queue: high concurrency (3), reactive, triggered on every command interaction
// - Full queue:  low concurrency (1), heavyweight, used for new user full syncs & imports
export const deltaQueue = REDIS_URL ? new Queue('user-index-delta', {
    connection: new IORedis(REDIS_URL, connectionConfig)
}) : null;

export const fullQueue = REDIS_URL ? new Queue('user-index-full', {
    connection: new IORedis(REDIS_URL, connectionConfig)
}) : null;

// Keep backwards-compat alias so existing callers (AccountHandler, BotProfile) still compile
export const indexQueue = fullQueue;

interface IndexJobData {
    discordId: string;
    type: 'FULL_SYNC' | 'DELTA_SYNC' | 'HISTORY_IMPORT';
    jobId?: string;
}

export async function triggerDeltaSync(discordId: string, force = false) {
    if (!deltaQueue) return;
    try {
        const user = await prisma.user.findUnique({ where: { discordId } });
        if (!user || !user.lastfmUsername) return;
        const settings: any = user.settings || {};
        
        const lastSyncExecuted = settings.lastSyncExecuted || 0;
        const now = Math.floor(Date.now() / 1000);
        if (!force && (now - lastSyncExecuted < 600)) return;
        
        // Update the debounce timestamp immediately so we don't queue duplicates
        settings.lastSyncExecuted = now;
        await prisma.user.update({ where: { discordId }, data: { settings } });

        await deltaQueue.add(`${force ? 'force-' : ''}delta-${discordId}`, { discordId, type: 'DELTA_SYNC' }, {
            jobId: `delta-${discordId}`,
            removeOnComplete: true,
            removeOnFail: true
        });
    } catch (e) {
        console.error("Delta Sync Trigger Failed:", e);
    }
}

interface ParsedPlay {
    artistName: string;
    trackName: string;
    albumName: string | null;
    uts: number;
}

function parseTracksFromAPI(tracks: any[]): ParsedPlay[] {
    const plays: ParsedPlay[] = [];
    const trackList = Array.isArray(tracks) ? tracks : [tracks];
    for (const t of trackList) {
        if (!t || t['@attr']?.nowplaying === 'true') continue;
        const uts = parseInt(t.date?.uts);
        if (!uts) continue;
        const artistName = t.artist?.['#text'] || t.artist?.name;
        if (!artistName) continue;
        plays.push({
            artistName,
            trackName: t.name || 'Unknown',
            albumName: t.album?.['#text'] || null,
            uts
        });
    }
    return plays;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`[Timeout] ${label} exceeded ${ms}ms`)), ms)
        )
    ]);
};

async function handleIndexing(job: Job<IndexJobData>) {
    const { discordId, type } = job.data;
    const _type = type || 'FULL_SYNC';
    const syncStart = Date.now();

    const user = await prisma.user.findUnique({ where: { discordId } });
    if (!user || !user.lastfmUsername) return;

    const username = user.lastfmUsername;
    LoggerService.info(`▶ ${_type} | ${username}`, 'Queue');
    const sessionKey = user.lastfmSessionKey;
    const settings: any = user.settings || {};
    
    let fromTimestamp: number | undefined;
    let isDelta = _type === 'DELTA_SYNC';

    if (isDelta) {
        // FMBot Parity: To catch deleted scrobbles, we fetch an overlapping window (last 3 hours)
        // This gives us an overlap window to diff and delete scrobbles removed on Last.fm
        const lastSync = settings.lastSyncTimestamp;
        const now = Math.floor(Date.now() / 1000);
        if (lastSync) {
            fromTimestamp = lastSync - (3 * 3600);
            fromTimestamp = Math.max(fromTimestamp, now - (14 * 86400));
        } else {
            fromTimestamp = now - (14 * 86400);
        }
    }

    // Local L1 cache to avoid hitting Redis for items already seen in THIS sync
    const l1Cache = {
        artists: new LRUCache<string, string>({ max: 5000 }),
        tracks: new LRUCache<string, string>({ max: 5000 }),
        albums: new LRUCache<string, string>({ max: 5000 })
    };

    let firstPage;
    try {
        firstPage = await LastFM.getRecentTracksPaginated(username, 1000, 1, sessionKey, !!sessionKey, fromTimestamp);
    } catch (e: any) {
        console.error(`[Queue] Failed first page for ${username}: ${e.message}`);
        return;
    }

    const totalPages = parseInt(firstPage.meta?.totalPages || '0', 10);
    const totalItems = parseInt(firstPage.meta?.total || '0', 10);

    if (totalItems === 0 && !isDelta) {
         console.log(`[Queue] User ${username} has no scrobbles. Skipping.`);
         return;
    }

    if (totalItems === 0 && isDelta) {
        // No new scrobbles since last sync, this is normal.
        return;
    }

    if (!isDelta) {
        await prisma.$transaction([
            prisma.userArtist.deleteMany({ where: { userId: user.id } }),
            prisma.userTrack.deleteMany({ where: { userId: user.id } }),
            prisma.userAlbum.deleteMany({ where: { userId: user.id } }),
            prisma.userPlay.deleteMany({ where: { userId: user.id } }),
        ]);
    }

    const artistCounts = new Map<string, {name: string, count: number}>();
    const albumCounts = new Map<string, {artistName: string, albumName: string, count: number}>();
    const trackCounts = new Map<string, {artistName: string, trackName: string, count: number}>();
    
    let maxUtsEncountered = settings.lastSyncTimestamp || 0;
    let totalPlaysProcessed = 0;
    let pendingPlays: ParsedPlay[] = [];

    async function pingDatabase(): Promise<void> {
        await Promise.race([
            prisma.$queryRaw`SELECT 1`,
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('[DB Ping Timeout] Neon compute did not wake in 15s')), 15000)
            )
        ]);
    }

    const flushPlaysToDB = async (plays: ParsedPlay[]) => {
        if (plays.length === 0) return;
        
        // Bulk insert — no per-flush logging needed
        await pingDatabase();
        
        const startRes = Date.now();
        const uniqueCombos = new Set<string>();
        plays.forEach(p => uniqueCombos.add(`${p.artistName}|||${p.trackName}|||${p.albumName || ''}`));
        
        const idMap = await IdResolutionService.resolveBatch(Array.from(uniqueCombos), l1Cache);
        
        let data = plays.map(p => {
            const res = idMap.get(`${p.artistName}|||${p.trackName}|||${p.albumName || ''}`)!;
            return {
                userId: user.id,
                artistId: res.artistId,
                trackId: res.trackId,
                albumId: res.albumId,
                artistName: p.artistName,
                trackName: p.trackName,
                albumName: p.albumName,
                timePlayed: new Date(p.uts * 1000)
            };
        });

        await bulkInsertPlays(data);
        
        const totalTime = Date.now() - startRes;

    };

    const diffAndFlushDelta = async (plays: ParsedPlay[]) => {
        if (plays.length === 0) return;
        
        // Deduplicate incoming plays by exact UTS (keep newest)
        const uniquePlaysMap = new Map<number, ParsedPlay>();
        for (const p of plays) {
            if (!uniquePlaysMap.has(p.uts)) {
                uniquePlaysMap.set(p.uts, p);
            }
        }
        plays = Array.from(uniquePlaysMap.values());


        await pingDatabase();
        
        const uniqueCombos = new Set<string>();
        plays.forEach(p => uniqueCombos.add(`${p.artistName}|||${p.trackName}|||${p.albumName || ''}`));
        const idMap = await IdResolutionService.resolveBatch(Array.from(uniqueCombos), l1Cache);
        
        let data = plays.map(p => {
            const res = idMap.get(`${p.artistName}|||${p.trackName}|||${p.albumName || ''}`)!;
            return {
                userId: user.id,
                artistId: res.artistId,
                trackId: res.trackId,
                albumId: res.albumId,
                artistName: p.artistName,
                trackName: p.trackName,
                albumName: p.albumName,
                timePlayed: new Date(p.uts * 1000)
            };
        });

        const minUts = Math.min(...plays.map(p => p.uts));
        const maxUts = Math.max(...plays.map(p => p.uts));
        
        const existingPlays = await prisma.userPlay.findMany({
            where: { userId: user.id, timePlayed: { gte: new Date(minUts * 1000), lte: new Date(maxUts * 1000) } },
            select: { id: true, timePlayed: true, artistName: true, trackName: true, albumName: true }
        });
        
        const incomingSet = new Set(data.map(p => `${p.timePlayed.getTime()}|${p.artistName}|${p.trackName}`));
        const existingSet = new Set(existingPlays.map(p => `${p.timePlayed.getTime()}|${p.artistName}|${p.trackName}`));
        
        const addedPlays = data.filter(p => !existingSet.has(`${p.timePlayed.getTime()}|${p.artistName}|${p.trackName}`));
        const orphanedPlays = existingPlays.filter(p => !incomingSet.has(`${p.timePlayed.getTime()}|${p.artistName}|${p.trackName}`));
        
        if (orphanedPlays.length > 0) {
            if (orphanedPlays.length > 0) LoggerService.info(`  ↓ Removed ${orphanedPlays.length} orphaned plays`, 'Queue');
            for (let i = 0; i < orphanedPlays.length; i += 500) {
                const chunk = orphanedPlays.slice(i, i + 500);
                await prisma.userPlay.deleteMany({ where: { id: { in: chunk.map(r => r.id) } } });
            }
        }

        if (addedPlays.length > 0) {
            await bulkInsertPlays(addedPlays);
        }

        const updateAggs = (pName: string, pTrack: string, pAlbum: string | null, modifier: number) => {
            const ak = pName.toLowerCase();
            if (!artistCounts.has(ak)) artistCounts.set(ak, { name: pName, count: 0 });
            artistCounts.get(ak)!.count += modifier;
            
            const tk = `${ak}:::${pTrack.toLowerCase()}`;
            if (!trackCounts.has(tk)) trackCounts.set(tk, { artistName: pName, trackName: pTrack, count: 0 });
            trackCounts.get(tk)!.count += modifier;
            
            if (pAlbum) {
                const alk = `${ak}:::${pAlbum.toLowerCase()}`;
                if (!albumCounts.has(alk)) albumCounts.set(alk, { artistName: pName, albumName: pAlbum, count: 0 });
                albumCounts.get(alk)!.count += modifier;
            }
        };
        
        addedPlays.forEach(p => updateAggs(p.artistName, p.trackName, p.albumName, 1));
        orphanedPlays.forEach(p => updateAggs(p.artistName, p.trackName, p.albumName, -1));
        
        LoggerService.info(`  ✦ Delta diff: +${addedPlays.length} added, -${orphanedPlays.length} removed`, 'Queue');
    };

    const processPage = (tracks: any[]) => {
        const plays = parseTracksFromAPI(tracks);
        for (const p of plays) {
            if (p.uts > maxUtsEncountered) maxUtsEncountered = p.uts;
            
            if (!isDelta) {
                const ak = p.artistName.toLowerCase();
                if (!artistCounts.has(ak)) artistCounts.set(ak, { name: p.artistName, count: 0 });
                artistCounts.get(ak)!.count += 1;

                const tk = `${ak}:::${p.trackName.toLowerCase()}`;
                if (!trackCounts.has(tk)) trackCounts.set(tk, { artistName: p.artistName, trackName: p.trackName, count: 0 });
                trackCounts.get(tk)!.count += 1;

                if (p.albumName) {
                    const alk = `${ak}:::${p.albumName.toLowerCase()}`;
                    if (!albumCounts.has(alk)) albumCounts.set(alk, { artistName: p.artistName, albumName: p.albumName, count: 0 });
                    albumCounts.get(alk)!.count += 1;
                }
            }
            
            pendingPlays.push(p);
            totalPlaysProcessed++;
        }
    };

    for (let p = 1; p <= totalPages; p++) {
        let pageData;
        let retries = 0;
        const failureDelays = [500, 2500, 5000, 10000];
        while (retries < 4) {
            try {
                if (p === 1) pageData = firstPage;
                else pageData = await LastFM.getRecentTracksPaginated(username, 1000, p, sessionKey, !!sessionKey, fromTimestamp);
                if (pageData.tracks) processPage(pageData.tracks);
                break;
            } catch (err: any) {
                console.error(`[Queue] Page ${p} failed for ${username} (Retry ${retries + 1}/4)`);
                if (retries === 3) break;
                await new Promise(r => setTimeout(r, failureDelays[retries]));
                retries++;
            }
        }

        // Progress report every 25% of pages (4 lines total instead of 174)
        if (!isDelta) {
            const pct = Math.floor((p / totalPages) * 100);
            const prev = Math.floor(((p - 1) / totalPages) * 100);
            if ((pct >= 25 && prev < 25) || (pct >= 50 && prev < 50) || (pct >= 75 && prev < 75)) {
                LoggerService.info(`  ${pct}% — page ${p}/${totalPages} | ${totalPlaysProcessed.toLocaleString()} plays`, 'Queue');
            }
        }

        if (!isDelta && (p % 2 === 0 || p === totalPages)) {
            await withTimeout(flushPlaysToDB(pendingPlays), 120000, `flushPlaysToDB page ${p}`);
            pendingPlays = [];
        } else if (isDelta && p === totalPages) {
            await withTimeout(diffAndFlushDelta(pendingPlays), 120000, `diffAndFlushDelta`);
            pendingPlays = [];
        }
        if (p !== 1) await new Promise(r => setTimeout(r, 100));
    }

    await upsertAggregates(user.id, artistCounts, trackCounts, albumCounts, isDelta, l1Cache);

    if (maxUtsEncountered > (settings.lastSyncTimestamp || 0)) {
        settings.lastSyncTimestamp = maxUtsEncountered;
        await prisma.user.update({ where: { id: user.id }, data: { settings } });
    }

    const elapsed = ((Date.now() - syncStart) / 1000).toFixed(1);
    LoggerService.info(`✅ ${_type} | ${username} — ${totalPlaysProcessed.toLocaleString()} plays in ${elapsed}s`, 'Queue');
    
    // Check for milestones after sync
    await checkMilestones(user.id, discordId, username).catch(() => {});

    CrownService.reconcileUser(user.id).catch(() => {});
    detectDrift(user.id, username, sessionKey, discordId).catch(() => {});
    backfillTrackDurations(user.id, username, sessionKey).catch(() => {});
    runSmallIndexCorrection(user.id, username, sessionKey).catch(() => {});
}

async function upsertAggregates(userId: string, artists: Map<string, any>, tracks: Map<string, any>, albums: Map<string, any>, isDelta: boolean, l1Cache: { 
    artists: LRUCache<string, string>, 
    tracks: LRUCache<string, string>, 
    albums: LRUCache<string, string> 
}) {
    const BATCH_SIZE = 1000;

    if (!isDelta) {

        await prisma.$transaction([
            prisma.userArtist.deleteMany({ where: { userId } }),
            prisma.userTrack.deleteMany({ where: { userId } }),
            prisma.userAlbum.deleteMany({ where: { userId } })
        ]);
        
        // ── ARTISTS ──────────────────────────────────────────────────────────

        const artistNames = Array.from(artists.values()).map(d => d.name);
        
        // Check L1 first, then MGET from L2
        const artistIdMap = new Map<string, string>();
        const missingFromL1: string[] = [];
        for (const name of artistNames) {
            const cached = l1Cache.artists.get(name);
            if (cached) artistIdMap.set(name, cached);
            else missingFromL1.push(name);
        }

        if (missingFromL1.length > 0) {
            for (let i = 0; i < missingFromL1.length; i += 500) {
                const chunk = missingFromL1.slice(i, i + 500);
                const cacheKeys = chunk.map(n => `idres:artist:${n.toLowerCase()}`);
                const cachedFromL2 = await CacheService.mget<string>(cacheKeys);
                
                const missingFromCache: string[] = [];
                chunk.forEach((name, idx) => {
                    const val = cachedFromL2.get(cacheKeys[idx]);
                    if (val) {
                        artistIdMap.set(name, val);
                        l1Cache.artists.set(name, val);
                    } else {
                        missingFromCache.push(name);
                    }
                });

                if (missingFromCache.length > 0) {
                    const dbArtists = await prisma.artist.findMany({ where: { name: { in: missingFromCache } } });
                    dbArtists.forEach(a => {
                        artistIdMap.set(a.name, a.id);
                        l1Cache.artists.set(a.name, a.id);
                    });
                    
                    const stillMissing = missingFromCache.filter(n => !artistIdMap.has(n));
                    if (stillMissing.length > 0) {
                        await prisma.artist.createMany({ data: stillMissing.map(name => ({ name })), skipDuplicates: true });
                        const created = await prisma.artist.findMany({ where: { name: { in: stillMissing } } });
                        const msetEntries: any[] = [];
                        created.forEach(a => {
                            artistIdMap.set(a.name, a.id);
                            l1Cache.artists.set(a.name, a.id);
                            msetEntries.push({ key: `idres:artist:${a.name.toLowerCase()}`, value: a.id, ttl: 86400 });
                        });
                        if (msetEntries.length > 0) await CacheService.mset(msetEntries);
                    }
                }
            }
        }

        const artistRows = Array.from(artists.values()).map(d => ({
            userId,
            artistId: artistIdMap.get(d.name) || '',
            artistName: d.name,
            playcount: d.count
        })).filter(r => r.artistId);

        for (let i = 0; i < artistRows.length; i += BATCH_SIZE) {
            await prisma.userArtist.createMany({ data: artistRows.slice(i, i + BATCH_SIZE), skipDuplicates: true });
        }


        // ── TRACKS ───────────────────────────────────────────────────────────

        const trackIdMap = new Map<string, string>(); // key: artistId:trackName
        const trackList = Array.from(tracks.values());
        const missingFromL1Tracks: any[] = [];

        for (const d of trackList) {
            const artistId = artistIdMap.get(d.artistName);
            if (!artistId) continue;
            const l1Key = `${artistId}:${d.trackName.toLowerCase()}`;
            const cached = l1Cache.tracks.get(l1Key);
            if (cached) trackIdMap.set(l1Key, cached);
            else missingFromL1Tracks.push({ artistId, name: d.trackName });
        }

        if (missingFromL1Tracks.length > 0) {
            for (let i = 0; i < missingFromL1Tracks.length; i += 500) {
                const chunk = missingFromL1Tracks.slice(i, i + 500);
                const cacheKeys = chunk.map(t => `idres:track:${t.artistId}:${t.name.toLowerCase()}`);
                const cachedFromL2 = await CacheService.mget<string>(cacheKeys);
                
                const missingFromCache: any[] = [];
                chunk.forEach((t, idx) => {
                    const key = `${t.artistId}:${t.name.toLowerCase()}`;
                    const val = cachedFromL2.get(cacheKeys[idx]);
                    if (val) {
                        trackIdMap.set(key, val);
                        l1Cache.tracks.set(key, val);
                    } else {
                        missingFromCache.push(t);
                    }
                });

                if (missingFromCache.length > 0) {
                    const dbTracks = await prisma.track.findMany({ where: { OR: missingFromCache.map(t => ({ artistId: t.artistId, name: t.name })) } });
                    dbTracks.forEach(t => {
                        const key = `${t.artistId}:${t.name.toLowerCase()}`;
                        trackIdMap.set(key, t.id);
                        l1Cache.tracks.set(key, t.id);
                    });

                    const stillMissing = missingFromCache.filter(t => !trackIdMap.has(`${t.artistId}:${t.name.toLowerCase()}`));
                    if (stillMissing.length > 0) {
                        await prisma.track.createMany({ data: stillMissing.map(t => ({ name: t.name, artistId: t.artistId })), skipDuplicates: true });
                        const created = await prisma.track.findMany({ where: { OR: stillMissing.map(t => ({ artistId: t.artistId, name: t.name })) } });
                        const msetEntries: any[] = [];
                        created.forEach(t => {
                            const key = `${t.artistId}:${t.name.toLowerCase()}`;
                            trackIdMap.set(key, t.id);
                            l1Cache.tracks.set(key, t.id);
                            msetEntries.push({ key: `idres:track:${key}`, value: t.id, ttl: 86400 });
                        });
                        if (msetEntries.length > 0) await CacheService.mset(msetEntries);
                    }
                }
            }
        }

        const trackRows = Array.from(tracks.values()).map(d => {
            const artistId = artistIdMap.get(d.artistName) || '';
            const trackId = trackIdMap.get(`${artistId}:${d.trackName.toLowerCase()}`) || '';
            return { userId, artistId, trackId, artistName: d.artistName, trackName: d.trackName, playcount: d.count };
        }).filter(r => r.artistId && r.trackId);

        for (let i = 0; i < trackRows.length; i += BATCH_SIZE) {
            await prisma.userTrack.createMany({ data: trackRows.slice(i, i + BATCH_SIZE), skipDuplicates: true });
        }


        // ── ALBUMS ───────────────────────────────────────────────────────────

        const albumIdMap = new Map<string, string>();
        const albumList = Array.from(albums.values());
        const missingFromL1Albums: any[] = [];

        for (const d of albumList) {
            const artistId = artistIdMap.get(d.artistName);
            if (!artistId) continue;
            const l1Key = `${artistId}:${d.albumName.toLowerCase()}`;
            const cached = l1Cache.albums.get(l1Key);
            if (cached) albumIdMap.set(l1Key, cached);
            else missingFromL1Albums.push({ artistId, name: d.albumName });
        }

        if (missingFromL1Albums.length > 0) {
            for (let i = 0; i < missingFromL1Albums.length; i += 500) {
                const chunk = missingFromL1Albums.slice(i, i + 500);
                const cacheKeys = chunk.map(al => `idres:album:${al.artistId}:${al.name.toLowerCase()}`);
                const cachedFromL2 = await CacheService.mget<string>(cacheKeys);
                
                const missingFromCache: any[] = [];
                chunk.forEach((al, idx) => {
                    const key = `${al.artistId}:${al.name.toLowerCase()}`;
                    const val = cachedFromL2.get(cacheKeys[idx]);
                    if (val) {
                        albumIdMap.set(key, val);
                        l1Cache.albums.set(key, val);
                    } else {
                        missingFromCache.push(al);
                    }
                });

                if (missingFromCache.length > 0) {
                    const dbAlbums = await prisma.album.findMany({ where: { OR: missingFromCache.map(al => ({ artistId: al.artistId, name: al.name })) } });
                    dbAlbums.forEach(al => {
                        const key = `${al.artistId}:${al.name.toLowerCase()}`;
                        albumIdMap.set(key, al.id);
                        l1Cache.albums.set(key, al.id);
                    });

                    const stillMissing = missingFromCache.filter(al => !albumIdMap.has(`${al.artistId}:${al.name.toLowerCase()}`));
                    if (stillMissing.length > 0) {
                        await prisma.album.createMany({ data: stillMissing.map(al => ({ name: al.name, artistId: al.artistId })), skipDuplicates: true });
                        const created = await prisma.album.findMany({ where: { OR: stillMissing.map(al => ({ artistId: al.artistId, name: al.name })) } });
                        const msetEntries: any[] = [];
                        created.forEach(al => {
                            const key = `${al.artistId}:${al.name.toLowerCase()}`;
                            albumIdMap.set(key, al.id);
                            l1Cache.albums.set(key, al.id);
                            msetEntries.push({ key: `idres:album:${key}`, value: al.id, ttl: 86400 });
                        });
                        if (msetEntries.length > 0) await CacheService.mset(msetEntries);
                    }
                }
            }
        }

        const albumRows = Array.from(albums.values()).map(d => {
            const artistId = artistIdMap.get(d.artistName) || '';
            const albumId = albumIdMap.get(`${artistId}:${d.albumName.toLowerCase()}`) || '';
            return { userId, artistId, albumId, artistName: d.artistName, albumName: d.albumName, playcount: d.count };
        }).filter(r => r.artistId && r.albumId);

        for (let i = 0; i < albumRows.length; i += BATCH_SIZE) {
            await prisma.userAlbum.createMany({ data: albumRows.slice(i, i + BATCH_SIZE), skipDuplicates: true });
        }


    } else {
        // UPDATE PATH: Incremental updates for DELTA_SYNC
        const UPDATE_BATCH = 50; 
        const artistList = Array.from(artists.values());
        for (let i = 0; i < artistList.length; i += UPDATE_BATCH) {
            const chunk = artistList.slice(i, i + UPDATE_BATCH);
            const operations = [];
            for (const d of chunk) {
                const artistId = await IdResolutionService.getArtistId(d.name);
                operations.push(prisma.$executeRaw`INSERT INTO user_artists (id, user_id, artist_id, artist_name, playcount) VALUES (${'ar_'+Math.random().toString(36).substring(2)}, ${userId}, ${artistId}, ${d.name}, ${d.count}) ON CONFLICT (user_id, artist_name) DO UPDATE SET artist_id = EXCLUDED.artist_id, playcount = user_artists.playcount + ${d.count}`);
            }
            await prisma.$transaction(operations);
        }
        
        const trackList = Array.from(tracks.values());
        for (let i = 0; i < trackList.length; i += UPDATE_BATCH) {
            const chunk = trackList.slice(i, i + UPDATE_BATCH);
            const operations = [];
            for (const d of chunk) {
                const artistId = await IdResolutionService.getArtistId(d.artistName);
                const trackId = await IdResolutionService.getTrackId(artistId, d.trackName);
                operations.push(prisma.$executeRaw`INSERT INTO user_tracks (id, user_id, artist_id, track_id, artist_name, track_name, playcount) VALUES (${'tr_'+Math.random().toString(36).substring(2)}, ${userId}, ${artistId}, ${trackId}, ${d.artistName}, ${d.trackName}, ${d.count}) ON CONFLICT (user_id, artist_name, track_name) DO UPDATE SET artist_id = EXCLUDED.artist_id, track_id = EXCLUDED.track_id, playcount = user_tracks.playcount + ${d.count}`);
            }
            await prisma.$transaction(operations);
        }

        const albumList = Array.from(albums.values());
        for (let i = 0; i < albumList.length; i += UPDATE_BATCH) {
            const chunk = albumList.slice(i, i + UPDATE_BATCH);
            const operations = [];
            for (const d of chunk) {
                const artistId = await IdResolutionService.getArtistId(d.artistName);
                const albumId = await IdResolutionService.getAlbumId(artistId, d.albumName);
                operations.push(prisma.$executeRaw`INSERT INTO user_albums (id, user_id, artist_id, album_id, artist_name, album_name, playcount) VALUES (${'al_'+Math.random().toString(36).substring(2)}, ${userId}, ${artistId}, ${albumId}, ${d.artistName}, ${d.albumName}, ${d.count}) ON CONFLICT (user_id, artist_name, album_name) DO UPDATE SET artist_id = EXCLUDED.artist_id, album_id = EXCLUDED.album_id, playcount = user_albums.playcount + ${d.count}`);
            }
            await prisma.$transaction(operations);
        }
    }
}

async function backfillTrackDurations(userId: string, username: string, sessionKey: string | null) {
    try {
        const tracks = await prisma.userTrack.findMany({ where: { userId, duration: null }, orderBy: { playcount: 'desc' }, take: 50 });
        if (tracks.length === 0) return;
        for (const track of tracks) {
            try {
                const info = await LastFM.getTrackInfo(track.artistName, track.trackName, username, sessionKey);
                let dur = parseInt(info?.duration || '0', 10);
                if (dur > 0) dur = Math.floor(dur / 1000);
                if (dur > 30) await prisma.userTrack.update({ where: { id: track.id }, data: { duration: dur } });
            } catch { }
            await new Promise(r => setTimeout(r, 150));
        }
    } catch (err) { }
}

async function detectDrift(userId: string, username: string, sessionKey: string | null, discordId: string) {
    try {
        const lfmInfo = await LastFM.getUserInfo(username, sessionKey);
        const lfmTotal = parseInt(lfmInfo?.playcount || '0', 10);
        if (lfmTotal === 0) return;
        const dbTotal = await prisma.userArtist.aggregate({ where: { userId }, _sum: { playcount: true } });
        const localTotal = dbTotal._sum.playcount || 0;
        const drift = Math.abs(lfmTotal - localTotal);
        const driftPct = (drift / lfmTotal) * 100;
        if (driftPct > 5) {
            console.log(`[Queue] User ${username} has ${driftPct.toFixed(2)}% drift. Triggering DELTA_SYNC (auto healing).`);
            if (deltaQueue) await deltaQueue.add(`auto-delta-${discordId}`, { discordId, type: 'DELTA_SYNC' }, { jobId: `auto-delta-${discordId}`, removeOnComplete: true, removeOnFail: true, delay: 5000 });
        }
    } catch (err) { }
}

async function checkMilestones(userId: string, discordId: string, username: string) {
    try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return;

        const totalCount = await prisma.userArtist.aggregate({
            where: { userId },
            _sum: { playcount: true }
        });
        const count = totalCount._sum.playcount || 0;

        const settings = (user.settings as any) || {};
        const lastMilestone = settings.lastMilestone || 0;

        // Milestone rules:
        // - Every 1k until 10k
        // - Every 10k after 10k
        let nextMilestone = lastMilestone;
        if (count < 10000) {
            nextMilestone = Math.floor(count / 1000) * 1000;
        } else {
            nextMilestone = Math.floor(count / 10000) * 10000;
        }

        if (nextMilestone > lastMilestone) {
            settings.lastMilestone = nextMilestone;
            await prisma.user.update({
                where: { id: userId },
                data: { settings }
            });

            LoggerService.info(`🎉 User ${username} reached milestone: ${nextMilestone.toLocaleString()}`, 'Milestones');
            
            // TODO: In the future, send a message to a Discord channel here.
            // For now, we just update the DB state so the milestone is recorded.
        }
    } catch (err) {
        console.error("Milestone Check Failed:", err);
    }
}

async function handleHistoryImport(job: Job<IndexJobData>) {
    if (!job.data.jobId) return;
    const { jobId, discordId } = job.data;
    const importJob = await prisma.importJob.findUnique({ where: { id: jobId }, include: { user: true } });
    if (!importJob || ['COMPLETED', 'CANCELLED'].includes(importJob.status)) return;
    const pendingTracks = await prisma.importTrack.findMany({ where: { jobId, processed: false }, orderBy: { timestamp: 'asc' }, take: 2800 });
    if (pendingTracks.length === 0) {
        await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
        return;
    }
    const now = Math.floor(Date.now() / 1000);
    let scrobbledCount = 0;
    for (let i = 0; i < pendingTracks.length; i += 50) {
        const chunk = pendingTracks.slice(i, i + 50);
        try {
            await LastFM.scrobbleBatch(chunk.map((t: any, idx: number) => ({ artist: t.artist, track: t.track, album: t.album || undefined, timestamp: importJob.isLegacy ? (now - (pendingTracks.length - (i + idx))) : t.timestamp })), importJob.user.lastfmSessionKey!);
            await prisma.importTrack.updateMany({ where: { id: { in: chunk.map((t: any) => t.id) } }, data: { processed: true } });
            scrobbledCount += chunk.length;
            await new Promise(r => setTimeout(r, 500));
        } catch (err: any) {
            if (err.response?.status === 429) break;
        }
    }
    await prisma.importJob.update({ where: { id: jobId }, data: { scrobbledTracks: { increment: scrobbledCount }, lastProcessedAt: new Date(), status: 'PROCESSING' } });
    if (await prisma.importTrack.count({ where: { jobId, processed: false } }) > 0) await fullQueue?.add(`import-next-${jobId}`, job.data, { delay: 24 * 60 * 60 * 1000, removeOnComplete: true });
    else await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
}

if (REDIS_URL) {
    // ── Delta Worker: high-concurrency for reactive syncs ──────────────────
    // Mirrors FMBot's ConcurrentQueue + SemaphoreSlim(3) architecture
    const deltaWorker = new Worker('user-index-delta', async (job: Job<IndexJobData>) => {
        try {
            await handleIndexing(job);
        } catch (err: any) {
            console.error(`[DeltaWorker] Error on job ${job.id}:`, err);
            throw err;
        }
    }, {
        connection: new IORedis(REDIS_URL, connectionConfig),
        concurrency: 3,           // 3 users updated in parallel (FMBot parity)
        stalledInterval: 30000,
        lockDuration: 90000,      // Delta syncs are fast, 90s is plenty
        maxStalledCount: 1,
    });

    deltaWorker.on('completed', (job) => LoggerService.info(`✅ ${job.id}`, 'DeltaWorker'));
    deltaWorker.on('failed', (job, err) => LoggerService.error(`❌ ${job?.id} FAILED`, err, 'DeltaWorker'));
    deltaWorker.on('error', (err) => LoggerService.error('Worker error', err, 'DeltaWorker'));

    // ── Full Worker: single-concurrency for heavyweight full syncs / imports ──
    // Full syncs wipe-and-replace all user data — must run one at a time to avoid
    // DB lock contention and excessive memory usage.
    const fullWorker = new Worker('user-index-full', async (job: Job<IndexJobData>) => {
        try {
            if (job.data.type === 'HISTORY_IMPORT') await handleHistoryImport(job);
            else await handleIndexing(job);
        } catch (err: any) {
            console.error(`[FullWorker] Error on job ${job.id}:`, err);
            throw err;
        }
    }, {
        connection: new IORedis(REDIS_URL, connectionConfig),
        concurrency: 1,           // One at a time — full syncs are heavy
        stalledInterval: 30000,
        lockDuration: 300000,     // 5 min lock — full syncs for large histories take time
        maxStalledCount: 1,
    });

    fullWorker.on('completed', (job) => LoggerService.info(`✅ ${job.id}`, 'FullWorker'));
    fullWorker.on('failed', (job, err) => LoggerService.error(`❌ ${job?.id} FAILED`, err, 'FullWorker'));
    fullWorker.on('error', (err) => LoggerService.error('Worker error', err, 'FullWorker'));

    console.log(`[Queue] Workers initialized: DeltaWorker(concurrency=3) + FullWorker(concurrency=1)`);
}

async function runSmallIndexCorrection(userId: string, username: string, sessionKey: string | null) {
    try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (!user) return;
        const settings = (user.settings as any) || {};
        const lastCorrection = settings.lastSmallIndex || 0;
        const now = Math.floor(Date.now() / 1000);
        
        // 10% chance if last correction was > 15 days ago
        if (now - lastCorrection > 15 * 86400) {
            if (Math.random() < 0.10) {
                console.log(`[Queue] Running SmallIndex Correction for ${username}`);
                settings.lastSmallIndex = now;
                await prisma.user.update({ where: { id: userId }, data: { settings } });
                
                // Fetch top artists (limit 500)
                const topArtists = await LastFM.getTopArtists(username, 'overall', 500, sessionKey);
                for (const a of topArtists) {
                    const count = parseInt(a.playcount || '0', 10);
                    if (count > 0) {
                        await prisma.$executeRaw`
                            UPDATE user_artists 
                            SET playcount = ${count} 
                            WHERE user_id = ${userId} AND artist_name = ${a.name} AND playcount != ${count}
                        `;
                    }
                }
                
                // Fetch top albums
                const topAlbums = await LastFM.getTopAlbums(username, 'overall', 500, sessionKey);
                for (const a of topAlbums) {
                    const count = parseInt(a.playcount || '0', 10);
                    const artistName = a.artist?.name || a.artist?.['#text'];
                    if (count > 0 && artistName) {
                        await prisma.$executeRaw`
                            UPDATE user_albums 
                            SET playcount = ${count} 
                            WHERE user_id = ${userId} AND artist_name = ${artistName} AND album_name = ${a.name} AND playcount != ${count}
                        `;
                    }
                }
                
                // Fetch top tracks
                const topTracks = await LastFM.getTopTracks(username, 'overall', 500, sessionKey);
                for (const t of topTracks) {
                    const count = parseInt(t.playcount || '0', 10);
                    const artistName = t.artist?.name || t.artist?.['#text'];
                    if (count > 0 && artistName) {
                        await prisma.$executeRaw`
                            UPDATE user_tracks 
                            SET playcount = ${count} 
                            WHERE user_id = ${userId} AND artist_name = ${artistName} AND track_name = ${t.name} AND playcount != ${count}
                        `;
                    }
                }
                console.log(`[Queue] SmallIndex Correction complete for ${username}`);
            }
        }
    } catch (err) {
        console.error(`[Queue] SmallIndex failed for ${username}:`, err);
    }
}
