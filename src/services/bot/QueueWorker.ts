import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../../database/client';
import { Prisma } from '@prisma/client';
import { LastFM } from '../api/LastFM';
import { CrownService } from './CrownService';
import IORedis from 'ioredis';
import { LoggerService } from './LoggerService';

const REDIS_URL = process.env.REDIS_URL?.replace(/^["']|["']$/g, '') || '';

if (!REDIS_URL) {
    console.warn("⚠️ REDIS_URL is missing. Background indexing will not start.");
}

const connection = REDIS_URL ? new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) : null;

export const indexQueue = connection ? new Queue('user-index', { connection }) : null;

interface IndexJobData {
    discordId: string;
    type: 'FULL_SYNC' | 'DELTA_SYNC' | 'HISTORY_IMPORT';
    jobId?: string;
}

export async function triggerDeltaSync(discordId: string, force = false) {
    if (!indexQueue) return;
    try {
        const user = await prisma.user.findUnique({ where: { discordId } });
        if (!user || !user.lastfmUsername) return;
        const settings: any = user.settings || {};
        const lastSync = settings.lastSyncTimestamp || 0;
        const now = Math.floor(Date.now() / 1000);
        if (!force && (now - lastSync < 600)) return;
        await indexQueue.add(`${force ? 'force-' : ''}delta-${discordId}`, { discordId, type: 'DELTA_SYNC' }, {
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

async function handleIndexing(job: Job<IndexJobData>) {
    const { discordId, type } = job.data;
    const _type = type || 'FULL_SYNC';
    LoggerService.info(`Started ${_type} indexing for discordId: ${discordId}`, 'Queue');

    const user = await prisma.user.findUnique({ where: { discordId } });
    if (!user || !user.lastfmUsername) return;

    const username = user.lastfmUsername;
    const sessionKey = user.lastfmSessionKey;
    const settings: any = user.settings || {};
    
    let fromTimestamp: number | undefined;
    let isDelta = _type === 'DELTA_SYNC';

    if (isDelta) {
        fromTimestamp = settings.lastSyncTimestamp ? settings.lastSyncTimestamp + 1 : Math.floor(Date.now() / 1000) - 86400;
    }

    let firstPage;
    try {
        firstPage = await LastFM.getRecentTracksPaginated(username, 200, 1, sessionKey, !!sessionKey, fromTimestamp);
    } catch (e: any) {
        console.error(`[Queue] Failed first page for ${username}: ${e.message}`);
        return;
    }

    const totalPages = parseInt(firstPage.meta?.totalPages || '1', 10);
    if (totalPages === 0 || (!firstPage.tracks && !isDelta)) {
         console.log(`[Queue] User ${username} has no scrobbles. Skipping.`);
         return;
    }

    if (!isDelta) {
        console.log(`[Queue] Clearing existing data for ${username} FULL_SYNC...`);
        await prisma.$transaction([
            prisma.userArtist.deleteMany({ where: { userId: user.id } }),
            prisma.userTrack.deleteMany({ where: { userId: user.id } }),
            prisma.userAlbum.deleteMany({ where: { userId: user.id } }),
            prisma.userPlay.deleteMany({ where: { userId: user.id } }),
        ], { timeout: 60000 });
    }

    const artistCounts = new Map<string, {name: string, count: number}>();
    const albumCounts = new Map<string, {artistName: string, albumName: string, count: number}>();
    const trackCounts = new Map<string, {artistName: string, trackName: string, count: number}>();
    
    let maxUtsEncountered = fromTimestamp || 0;
    let totalPlaysProcessed = 0;
    let pendingPlays: ParsedPlay[] = [];

    const flushPlaysToDB = async (plays: ParsedPlay[]) => {
        if (plays.length === 0) return;
        const data = plays.map(p => ({
            userId: user.id,
            artistName: p.artistName,
            trackName: p.trackName,
            albumName: p.albumName,
            timePlayed: new Date(p.uts * 1000)
        }));
        await prisma.userPlay.createMany({ data, skipDuplicates: true });
    };

    const processPage = (tracks: any[]) => {
        const plays = parseTracksFromAPI(tracks);
        for (const p of plays) {
            if (p.uts > maxUtsEncountered) maxUtsEncountered = p.uts;
            
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
            
            pendingPlays.push(p);
            totalPlaysProcessed++;
        }
    };

    for (let p = 1; p <= totalPages; p++) {
        let pageData;
        let retries = 0;
        while (retries < 3) {
            try {
                if (p === 1) pageData = firstPage;
                else pageData = await LastFM.getRecentTracksPaginated(username, 200, p, sessionKey, !!sessionKey, fromTimestamp);
                if (pageData.tracks) processPage(pageData.tracks);
                break;
            } catch (err: any) {
                retries++;
                console.error(`[Queue] Page ${p} failed for ${username} (Retry ${retries}/3)`);
                if (retries === 3) break;
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (p % 10 === 0 || p === totalPages) {
            console.log(`[Queue] [${username}] Syncing page ${p}/${totalPages} (${totalPlaysProcessed} plays)...`);
            await flushPlaysToDB(pendingPlays);
            pendingPlays = [];
        }
        if (p !== 1) await new Promise(r => setTimeout(r, 150));
    }

    console.log(`[Queue] Committing aggregate stats for ${username}...`);
    await upsertAggregates(user.id, artistCounts, trackCounts, albumCounts, isDelta);

    if (maxUtsEncountered > (settings.lastSyncTimestamp || 0)) {
        settings.lastSyncTimestamp = maxUtsEncountered;
        await prisma.user.update({ where: { id: user.id }, data: { settings } });
    }
    
    console.log(`[Queue] ${_type} complete for ${username}. Total: ${totalPlaysProcessed}`);
    CrownService.reconcileUser(user.id).catch(() => {});
    detectDrift(user.id, username, sessionKey, discordId).catch(() => {});
    backfillTrackDurations(user.id, username, sessionKey).catch(() => {});
}

async function upsertAggregates(userId: string, artists: Map<string, any>, tracks: Map<string, any>, albums: Map<string, any>, isDelta: boolean) {
    const BATCH_SIZE = 1000;
    
    if (!isDelta) {
        // FAST PATH: Use createMany for FULL_SYNC
        const artistList = Array.from(artists.values()).map(d => ({ userId, artistName: d.name, playcount: d.count }));
        for (let i = 0; i < artistList.length; i += BATCH_SIZE) {
            await prisma.userArtist.createMany({ data: artistList.slice(i, i + BATCH_SIZE), skipDuplicates: true });
        }
        
        const trackList = Array.from(tracks.values()).map(d => ({ userId, artistName: d.artistName, trackName: d.trackName, playcount: d.count }));
        for (let i = 0; i < trackList.length; i += BATCH_SIZE) {
            await prisma.userTrack.createMany({ data: trackList.slice(i, i + BATCH_SIZE), skipDuplicates: true });
        }
        
        const albumList = Array.from(albums.values()).map(d => ({ userId, artistName: d.artistName, albumName: d.albumName, playcount: d.count }));
        for (let i = 0; i < albumList.length; i += BATCH_SIZE) {
            await prisma.userAlbum.createMany({ data: albumList.slice(i, i + BATCH_SIZE), skipDuplicates: true });
        }
    } else {
        // UPDATE PATH: Incremental updates for DELTA_SYNC
        const UPDATE_BATCH = 100;
        const artistList = Array.from(artists.values());
        for (let i = 0; i < artistList.length; i += UPDATE_BATCH) {
            const chunk = artistList.slice(i, i + UPDATE_BATCH);
            await prisma.$transaction(chunk.map(d => 
                prisma.$executeRaw`INSERT INTO user_artists (id, user_id, artist_name, playcount) VALUES (${'ar_'+Math.random().toString(36).substring(2)}, ${userId}, ${d.name}, ${d.count}) ON CONFLICT (user_id, artist_name) DO UPDATE SET playcount = user_artists.playcount + ${d.count}`
            ));
        }
        
        const trackList = Array.from(tracks.values());
        for (let i = 0; i < trackList.length; i += UPDATE_BATCH) {
            const chunk = trackList.slice(i, i + UPDATE_BATCH);
            await prisma.$transaction(chunk.map(d => 
                prisma.$executeRaw`INSERT INTO user_tracks (id, user_id, artist_name, track_name, playcount) VALUES (${'tr_'+Math.random().toString(36).substring(2)}, ${userId}, ${d.artistName}, ${d.trackName}, ${d.count}) ON CONFLICT (user_id, artist_name, track_name) DO UPDATE SET playcount = user_tracks.playcount + ${d.count}`
            ));
        }

        const albumList = Array.from(albums.values());
        for (let i = 0; i < albumList.length; i += UPDATE_BATCH) {
            const chunk = albumList.slice(i, i + UPDATE_BATCH);
            await prisma.$transaction(chunk.map(d => 
                prisma.$executeRaw`INSERT INTO user_albums (id, user_id, artist_name, album_name, playcount) VALUES (${'al_'+Math.random().toString(36).substring(2)}, ${userId}, ${d.artistName}, ${d.albumName}, ${d.count}) ON CONFLICT (user_id, artist_name, album_name) DO UPDATE SET playcount = user_albums.playcount + ${d.count}`
            ));
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
        if (driftPct > 20) {
            if (indexQueue) await indexQueue.add(`auto-full-${discordId}`, { discordId, type: 'FULL_SYNC' }, { jobId: `auto-full-${discordId}`, removeOnComplete: true, removeOnFail: true, delay: 5000 });
        }
    } catch (err) { }
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
    if (await prisma.importTrack.count({ where: { jobId, processed: false } }) > 0) await indexQueue?.add(`import-next-${jobId}`, job.data, { delay: 24 * 60 * 60 * 1000, removeOnComplete: true });
    else await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
}

if (connection) {
    new Worker('user-index', async (job: Job<IndexJobData>) => {
        if (job.data.type === 'HISTORY_IMPORT') await handleHistoryImport(job);
        else await handleIndexing(job);
    }, { connection, concurrency: 1 });
}
