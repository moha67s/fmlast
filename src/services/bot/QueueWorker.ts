import { Queue, Worker, Job } from 'bullmq';
import { prisma } from '../../database/client';
import { LastFM } from '../api/LastFM';
import { CrownService } from './CrownService';
import IORedis from 'ioredis';
import { LoggerService } from './LoggerService';

const REDIS_URL = process.env.REDIS_URL?.replace(/^["']|["']$/g, '') || '';

if (!REDIS_URL) {
    console.warn("⚠️ REDIS_URL is missing. Background indexing will not start.");
}

const connection = REDIS_URL ? new IORedis(REDIS_URL, { maxRetriesPerRequest: null }) : null;

// The queue for kicking off jobs
export const indexQueue = connection ? new Queue('user-index', { connection }) : null;

interface IndexJobData {
    discordId: string;
    type: 'FULL_SYNC' | 'DELTA_SYNC' | 'HISTORY_IMPORT';
    jobId?: string; // Used for HISTORY_IMPORT
}

/** 
 * Safely trigger a delta sync for a user with a 15-minute debounce
 */
export async function triggerDeltaSync(discordId: string, force = false) {
    if (!indexQueue) return;
    
    try {
        const user = await prisma.user.findUnique({ where: { discordId } });
        if (!user || !user.lastfmUsername) return; // not linked

        const settings: any = user.settings || {};
        const lastSync = settings.lastSyncTimestamp || 0;
        const now = Math.floor(Date.now() / 1000);

        // 10 minute cooldown (600 seconds) - bypass if forced
        if (!force && (now - lastSync < 600)) {
            return; // Too soon
        }

        await indexQueue.add(`${force ? 'force-' : ''}delta-${discordId}`, { discordId, type: 'DELTA_SYNC' }, {
            jobId: `delta-${discordId}`,
            removeOnComplete: true,
            removeOnFail: true
        });
    } catch (e) {
        console.error("Delta Sync Trigger Failed:", e);
    }
}

async function handleIndexing(job: Job<IndexJobData>) {
    const { discordId, type } = job.data;
    const _type = type || 'FULL_SYNC';
    
    LoggerService.info(`Started ${_type} indexing for discordId: ${discordId}`, 'Queue');

    const user = await prisma.user.findUnique({ where: { discordId } });
    if (!user || !user.lastfmUsername) {
        console.log(`[Queue] User ${discordId} not found or not linked.`);
        return;
    }

    const username = user.lastfmUsername;
    const sessionKey = user.lastfmSessionKey;
    const settings: any = user.settings || {};
    
    let fromTimestamp: number | undefined;
    let isDelta = _type === 'DELTA_SYNC';

    if (isDelta) {
        if (!settings.lastSyncTimestamp) {
            console.log(`[Queue] No lastSyncTimestamp found for ${username}, defaulting to 24-hours ago to protect queue.`);
            fromTimestamp = Math.floor(Date.now() / 1000) - 86400;
        } else {
            fromTimestamp = settings.lastSyncTimestamp + 1;
        }
    }

    let firstPage;
    try {
        firstPage = await LastFM.getRecentTracksPaginated(username, 200, 1, sessionKey, !!sessionKey, fromTimestamp);
    } catch (e: any) {
        console.error(`[Queue] Failed to fetch first page for ${username}: ${e.message}`);
        return;
    }

    const totalPages = parseInt(firstPage.meta?.totalPages || '1', 10);
    if (totalPages === 0 || firstPage.tracks.length === 0) {
         console.log(`[Queue] User ${username} has no new scrobbles for ${_type}. Skipping.`);
         return;
    }

    let maxUtsEncountered = fromTimestamp || 0;
    const artistCounts = new Map<string, {name: string, count: number}>();
    const albumCounts = new Map<string, {artistName: string, albumName: string, count: number}>();
    const trackCounts = new Map<string, {artistName: string, trackName: string, count: number}>();

    const processTracks = (tracks: any[]) => {
        for (const t of tracks) {
            if (t['@attr']?.nowplaying === 'true') continue;
            const uts = parseInt(t.date?.uts);
            if (uts && uts > maxUtsEncountered) maxUtsEncountered = uts;
            const artistName = t.artist?.['#text'] || t.artist?.name;
            const trackName = t.name;
            const albumName = t.album?.['#text'];
            if (!artistName) continue;
            const artistKey = artistName.toLowerCase();
            if (!artistCounts.has(artistKey)) artistCounts.set(artistKey, { name: artistName, count: 0 });
            artistCounts.get(artistKey)!.count += 1;
            if (trackName) {
                const trackKey = `${artistKey}:::${trackName.toLowerCase()}`;
                if (!trackCounts.has(trackKey)) trackCounts.set(trackKey, { artistName, trackName, count: 0 });
                trackCounts.get(trackKey)!.count += 1;
            }
            if (albumName) {
                const albumKey = `${artistKey}:::${albumName.toLowerCase()}`;
                if (!albumCounts.has(albumKey)) albumCounts.set(albumKey, { artistName, albumName, count: 0 });
                albumCounts.get(albumKey)!.count += 1;
            }
        }
    };

    processTracks(firstPage.tracks);

    for (let p = 2; p <= totalPages; p++) {
        try {
            if (p % 2 === 0) console.log(`[Queue] [${username}] Fetching page ${p} of ${totalPages}...`);
            const pageData = await LastFM.getRecentTracksPaginated(username, 200, p, sessionKey, !!sessionKey, fromTimestamp);
            processTracks(pageData.tracks);
            await new Promise(r => setTimeout(r, 200));
        } catch (e: any) {
            console.error(`[Queue] Error on page ${p} for ${username}: ${e.message}`);
        }
    }

    console.log(`[Queue] Finished downloading for ${username}. Aggregated ${artistCounts.size} artists, ${trackCounts.size} tracks, ${albumCounts.size} albums.`);

    if (!isDelta) {
        console.log(`[Queue] Starting FULL_SYNC DB commit for ${username}...`);
        await prisma.$transaction(async (tx) => {
            await tx.userArtist.deleteMany({ where: { userId: user.id } });
            await tx.userTrack.deleteMany({ where: { userId: user.id } });
            await tx.userAlbum.deleteMany({ where: { userId: user.id } });
            const maxBatch = 10000;
            const aBatch = Array.from(artistCounts.values()).map(d => ({ userId: user.id, artistName: d.name, playcount: d.count }));
            for (let i = 0; i < aBatch.length; i += maxBatch) await tx.userArtist.createMany({ data: aBatch.slice(i, i + maxBatch), skipDuplicates: true });
            const tBatch = Array.from(trackCounts.values()).map(d => ({ userId: user.id, artistName: d.artistName, trackName: d.trackName, playcount: d.count }));
            for (let i = 0; i < tBatch.length; i += maxBatch) await tx.userTrack.createMany({ data: tBatch.slice(i, i + maxBatch), skipDuplicates: true });
            const alBatch = Array.from(albumCounts.values()).map(d => ({ userId: user.id, artistName: d.artistName, albumName: d.albumName, playcount: d.count }));
            for (let i = 0; i < alBatch.length; i += maxBatch) await tx.userAlbum.createMany({ data: alBatch.slice(i, i + maxBatch), skipDuplicates: true });
        }, { maxWait: 100000, timeout: 600000 });
    } else {
        const chunk = <T>(arr: T[], size: number): T[][] => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
        const esc = (str: string) => `'${str.replace(/'/g, "''")}'`;
        const artistList = Array.from(artistCounts.values());
        const aChunks = chunk(artistList, 1000);
        for (const c of aChunks) {
            const values = c.map(d => `('ar_${Math.random().toString(36).substring(2)}', '${user.id}', ${esc(d.name)}, ${d.count})`).join(',');
            await prisma.$executeRawUnsafe(`INSERT INTO user_artists (id, user_id, artist_name, playcount) VALUES ${values} ON CONFLICT (user_id, artist_name) DO UPDATE SET playcount = user_artists.playcount + EXCLUDED.playcount;`);
        }
        const trackList = Array.from(trackCounts.values());
        const tChunks = chunk(trackList, 1000);
        for (const c of tChunks) {
            const values = c.map(d => `('tr_${Math.random().toString(36).substring(2)}', '${user.id}', ${esc(d.artistName)}, ${esc(d.trackName)}, ${d.count})`).join(',');
            await prisma.$executeRawUnsafe(`INSERT INTO user_tracks (id, user_id, artist_name, track_name, playcount) VALUES ${values} ON CONFLICT (user_id, artist_name, track_name) DO UPDATE SET playcount = user_tracks.playcount + EXCLUDED.playcount;`);
        }
        const albumList = Array.from(albumCounts.values());
        const alChunks = chunk(albumList, 1000);
        for (const c of alChunks) {
            const values = c.map(d => `('al_${Math.random().toString(36).substring(2)}', '${user.id}', ${esc(d.artistName)}, ${esc(d.albumName)}, ${d.count})`).join(',');
            await prisma.$executeRawUnsafe(`INSERT INTO user_albums (id, user_id, artist_name, album_name, playcount) VALUES ${values} ON CONFLICT (user_id, artist_name, album_name) DO UPDATE SET playcount = user_albums.playcount + EXCLUDED.playcount;`);
        }
    }

    if (maxUtsEncountered > (settings.lastSyncTimestamp || 0)) {
        settings.lastSyncTimestamp = maxUtsEncountered;
        await prisma.user.update({ where: { id: user.id }, data: { settings } });
        console.log(`[Queue] Successfully committed ${_type} index for ${username}. Cursor advanced to ${new Date(maxUtsEncountered * 1000).toISOString()}`);
    } else {
        console.log(`[Queue] Successfully committed ${_type} index for ${username}. No cursor advancement needed.`);
    }
    CrownService.reconcileUser(user.id).catch(err => console.error(`[Queue] Crown re-sync failed:`, err));

    // Fire-and-forget: backfill missing track durations for top tracks
    backfillTrackDurations(user.id, username, sessionKey).catch(() => {});
}

/**
 * Lazily populate `duration` on UserTrack rows that haven't been checked yet.
 * Processes up to 50 tracks per sync, highest-playcount first, so the most
 * impactful tracks (for weighted-average listening time) are filled first.
 */
async function backfillTrackDurations(userId: string, username: string, sessionKey: string | null) {
    try {
        const tracks = await prisma.userTrack.findMany({
            where: { userId, duration: null },
            orderBy: { playcount: 'desc' },
            take: 50,
        });

        if (tracks.length === 0) return;
        console.log(`[Queue] Backfilling durations for ${tracks.length} tracks of ${username}...`);

        let filled = 0;
        for (const track of tracks) {
            try {
                const info = await LastFM.getTrackInfo(track.artistName, track.trackName, username, sessionKey);
                let dur = parseInt(info?.duration || '0', 10);
                // Last.fm returns milliseconds, convert to seconds
                if (dur > 0) dur = Math.floor(dur / 1000);

                // Only store real durations (> 30s). Tracks with no duration stay null
                // and will be retried next sync until Last.fm knows them.
                if (dur > 30) {
                    await prisma.userTrack.update({ where: { id: track.id }, data: { duration: dur } });
                    filled++;
                }
            } catch { /* skip individual failures */ }
            await new Promise(r => setTimeout(r, 150));
        }

        console.log(`[Queue] Duration backfill done for ${username}: ${filled}/${tracks.length} filled.`);
    } catch (err) {
        console.error('[Queue] backfillTrackDurations error:', err);
    }
}

async function handleHistoryImport(job: Job<IndexJobData>) {
    if (!job.data.jobId) return;
    const { jobId, discordId } = job.data;
    console.log(`[Import] Starting batch for Job ${jobId} (User: ${discordId})`);

    const importJob = await prisma.importJob.findUnique({
        where: { id: jobId },
        include: { user: true }
    });

    if (!importJob || ['COMPLETED', 'CANCELLED'].includes(importJob.status)) {
        console.log(`[Import] Job ${jobId} is ${importJob?.status || 'NOT_FOUND'}. Skipping.`);
        return;
    }
    if (!importJob.user.lastfmSessionKey) {
        console.error(`[Import] No session key for user ${discordId}. Aborting.`);
        return;
    }

    const BATCH_LIMIT = 2800;
    const pendingTracks = await prisma.importTrack.findMany({
        where: { jobId, processed: false },
        orderBy: { timestamp: 'asc' },
        take: BATCH_LIMIT
    });

    if (pendingTracks.length === 0) {
        await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
        console.log(`[Import] Job ${jobId} COMPLETED.`);
        return;
    }

    console.log(`[Import] Scrobbling batch of ${pendingTracks.length} tracks for ${importJob.user.lastfmUsername}...`);

    const CHUNK_SIZE = 50;
    let scrobbledCount = 0;
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < pendingTracks.length; i += CHUNK_SIZE) {
        const chunk = pendingTracks.slice(i, i + CHUNK_SIZE);
        try {
            await LastFM.scrobbleBatch(
                chunk.map((t: any, idx: number) => {
                    // Calculate shifted timestamp if Legacy mode is enabled
                    // We scrobble backwards from 'now' to preserve order within the batch
                    // i + idx gives the global index in the current batch (0 to 2799)
                    const effectiveTimestamp = importJob.isLegacy 
                        ? (now - (pendingTracks.length - (i + idx)))
                        : t.timestamp;

                    return {
                        artist: t.artist,
                        track: t.track,
                        album: t.album || undefined,
                        timestamp: effectiveTimestamp
                    };
                }),
                importJob.user.lastfmSessionKey
            );
            await prisma.importTrack.updateMany({ where: { id: { in: chunk.map((t: any) => t.id) } }, data: { processed: true } });
            scrobbledCount += chunk.length;
            await new Promise(r => setTimeout(r, 500));
        } catch (err: any) {
            const status = err.response?.status;
            const errMsg = err.message || '';
            LoggerService.error(`Batch failed for Job ${jobId}`, err, 'Import');
            
            // Break early if we hit rate limits or auth errors
            if (status === 403 || status === 401 || status === 429 || 
                errMsg.includes('Rate Limit') || 
                errMsg.includes('Too many scrobbles')) {
                LoggerService.warn(`Stopping current batch for Job ${jobId} due to Rate Limit/Auth error.`, 'Import');
                break;
            }
        }
    }

    await prisma.importJob.update({
        where: { id: jobId },
        data: { scrobbledTracks: { increment: scrobbledCount }, lastProcessedAt: new Date(), status: 'PROCESSING' }
    });

    const remainingCount = await prisma.importTrack.count({ where: { jobId, processed: false } });

    if (remainingCount > 0) {
        console.log(`[Import] ${remainingCount} tracks remain for Job ${jobId}. Scheduling next batch in 24 hours.`);
        await indexQueue?.add(`import-next-${jobId}`, job.data, { delay: 24 * 60 * 60 * 1000, removeOnComplete: true });
    } else {
        await prisma.importJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
        console.log(`[Import] Job ${jobId} finished final batch and is now COMPLETED.`);
    }
}

if (connection) {
    const worker = new Worker('user-index', async (job: Job<IndexJobData>) => {
        if (job.data.type === 'HISTORY_IMPORT') {
            await handleHistoryImport(job);
        } else {
            await handleIndexing(job);
        }
    }, { connection, concurrency: 1 });

    worker.on('failed', (job, err) => {
        LoggerService.error(`Job failed for ${job?.data?.discordId || job?.data?.jobId}`, err, 'Queue');
    });
}
