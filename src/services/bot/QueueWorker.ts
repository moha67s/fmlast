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
 * Safely trigger a delta sync for a user with a 10-minute debounce
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

// ─────────────────────── Parsed scrobble from API ───────────────────────
interface ParsedPlay {
    artistName: string;
    trackName: string;
    albumName: string | null;
    uts: number; // unix timestamp
}

function parseTracksFromAPI(tracks: any[]): ParsedPlay[] {
    const plays: ParsedPlay[] = [];
    for (const t of tracks) {
        if (t['@attr']?.nowplaying === 'true') continue;
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

// ─────────────────────── Main indexing handler ───────────────────────

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
            console.log(`[Queue] No lastSyncTimestamp found for ${username}, defaulting to 24-hours ago.`);
            fromTimestamp = Math.floor(Date.now() / 1000) - 86400;
        } else {
            fromTimestamp = settings.lastSyncTimestamp + 1;
        }
    }

    // ── Fetch all pages from Last.fm ──
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

    const allFetchedPlays: ParsedPlay[] = parseTracksFromAPI(firstPage.tracks);

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    for (let p = 2; p <= totalPages; p++) {
        try {
            if (p % 2 === 0) console.log(`[Queue] [${username}] Fetching page ${p} of ${totalPages}...`);
            const pageData = await LastFM.getRecentTracksPaginated(username, 200, p, sessionKey, !!sessionKey, fromTimestamp);
            allFetchedPlays.push(...parseTracksFromAPI(pageData.tracks));
            consecutiveFailures = 0;
            await new Promise(r => setTimeout(r, 200));
        } catch (e: any) {
            consecutiveFailures++;
            console.error(`[Queue] Error on page ${p} for ${username} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message}`);
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                console.error(`[Queue] ❌ Aborting ${_type} for ${username} after ${MAX_CONSECUTIVE_FAILURES} consecutive page failures.`);
                break;
            }
        }
    }

    console.log(`[Queue] Finished downloading ${allFetchedPlays.length} plays for ${username}.`);

    // ── Aggregate counts from fetched plays ──
    const artistCounts = new Map<string, {name: string, count: number}>();
    const albumCounts = new Map<string, {artistName: string, albumName: string, count: number}>();
    const trackCounts = new Map<string, {artistName: string, trackName: string, count: number}>();

    for (const p of allFetchedPlays) {
        const artistKey = p.artistName.toLowerCase();
        if (!artistCounts.has(artistKey)) artistCounts.set(artistKey, { name: p.artistName, count: 0 });
        artistCounts.get(artistKey)!.count += 1;
        const trackKey = `${artistKey}:::${p.trackName.toLowerCase()}`;
        if (!trackCounts.has(trackKey)) trackCounts.set(trackKey, { artistName: p.artistName, trackName: p.trackName, count: 0 });
        trackCounts.get(trackKey)!.count += 1;
        if (p.albumName) {
            const albumKey = `${artistKey}:::${p.albumName.toLowerCase()}`;
            if (!albumCounts.has(albumKey)) albumCounts.set(albumKey, { artistName: p.artistName, albumName: p.albumName, count: 0 });
            albumCounts.get(albumKey)!.count += 1;
        }
    }

    let maxUtsEncountered = fromTimestamp || 0;
    for (const p of allFetchedPlays) {
        if (p.uts > maxUtsEncountered) maxUtsEncountered = p.uts;
    }

    // ── Commit to database ──
    if (!isDelta) {
        await commitFullSync(user.id, allFetchedPlays, artistCounts, trackCounts, albumCounts);
    } else {
        await commitDeltaSync(user.id, allFetchedPlays, fromTimestamp || 0);
    }

    // ── Advance cursor ──
    if (maxUtsEncountered > (settings.lastSyncTimestamp || 0)) {
        settings.lastSyncTimestamp = maxUtsEncountered;
        await prisma.user.update({ where: { id: user.id }, data: { settings } });
        console.log(`[Queue] Successfully committed ${_type} for ${username}. Cursor → ${new Date(maxUtsEncountered * 1000).toISOString()}`);
    } else {
        console.log(`[Queue] Successfully committed ${_type} for ${username}. No cursor advancement needed.`);
    }

    CrownService.reconcileUser(user.id).catch(err => console.error(`[Queue] Crown re-sync failed:`, err));

    // Fire-and-forget: drift detection + backfill
    detectDrift(user.id, username, sessionKey, discordId).catch(() => {});
    backfillTrackDurations(user.id, username, sessionKey).catch(() => {});
}

// ─────────────────────── FULL_SYNC commit ───────────────────────

async function commitFullSync(
    userId: string,
    plays: ParsedPlay[],
    artistCounts: Map<string, {name: string, count: number}>,
    trackCounts: Map<string, {artistName: string, trackName: string, count: number}>,
    albumCounts: Map<string, {artistName: string, albumName: string, count: number}>
) {
    console.log(`[Queue] Starting FULL_SYNC DB commit...`);
    const maxBatch = 10000;

    await prisma.$transaction(async (tx) => {
        // Wipe aggregates
        await tx.userArtist.deleteMany({ where: { userId } });
        await tx.userTrack.deleteMany({ where: { userId } });
        await tx.userAlbum.deleteMany({ where: { userId } });
        await tx.userPlay.deleteMany({ where: { userId } });

        // Insert aggregates
        const aBatch = Array.from(artistCounts.values()).map(d => ({ userId, artistName: d.name, playcount: d.count }));
        for (let i = 0; i < aBatch.length; i += maxBatch) await tx.userArtist.createMany({ data: aBatch.slice(i, i + maxBatch), skipDuplicates: true });

        const tBatch = Array.from(trackCounts.values()).map(d => ({ userId, artistName: d.artistName, trackName: d.trackName, playcount: d.count }));
        for (let i = 0; i < tBatch.length; i += maxBatch) await tx.userTrack.createMany({ data: tBatch.slice(i, i + maxBatch), skipDuplicates: true });

        const alBatch = Array.from(albumCounts.values()).map(d => ({ userId, artistName: d.artistName, albumName: d.albumName, playcount: d.count }));
        for (let i = 0; i < alBatch.length; i += maxBatch) await tx.userAlbum.createMany({ data: alBatch.slice(i, i + maxBatch), skipDuplicates: true });

        // Insert individual plays
        const playBatch = plays.map(p => ({
            userId,
            artistName: p.artistName,
            trackName: p.trackName,
            albumName: p.albumName,
            timePlayed: new Date(p.uts * 1000)
        }));
        for (let i = 0; i < playBatch.length; i += maxBatch) {
            await tx.userPlay.createMany({ data: playBatch.slice(i, i + maxBatch), skipDuplicates: true });
        }
    }, { maxWait: 100000, timeout: 600000 });

    console.log(`[Queue] FULL_SYNC committed: ${plays.length} plays.`);
}

// ─────────────────────── DELTA_SYNC commit (diff-based) ───────────────────────

async function commitDeltaSync(userId: string, fetchedPlays: ParsedPlay[], fromTimestamp: number) {
    // 1. Get existing plays in the same time window from DB
    const fromDate = new Date(fromTimestamp * 1000);
    const existingPlays = await prisma.userPlay.findMany({
        where: { userId, timePlayed: { gte: fromDate } },
        select: { id: true, timePlayed: true, artistName: true, trackName: true, albumName: true }
    });

    // 2. Build lookup sets keyed by unix timestamp (seconds)
    const existingByUts = new Map<number, typeof existingPlays[0]>();
    for (const ep of existingPlays) {
        existingByUts.set(Math.floor(ep.timePlayed.getTime() / 1000), ep);
    }

    const fetchedUtsSet = new Set<number>();
    for (const fp of fetchedPlays) {
        fetchedUtsSet.add(fp.uts);
    }

    // 3. Diff: find NEW and REMOVED plays
    const newPlays = fetchedPlays.filter(fp => !existingByUts.has(fp.uts));
    const removedPlays = existingPlays.filter(ep => !fetchedUtsSet.has(Math.floor(ep.timePlayed.getTime() / 1000)));

    console.log(`[Queue] Delta diff: +${newPlays.length} new, -${removedPlays.length} removed`);

    // 4. Insert new plays into UserPlay
    if (newPlays.length > 0) {
        const batch = newPlays.map(p => ({
            userId,
            artistName: p.artistName,
            trackName: p.trackName,
            albumName: p.albumName,
            timePlayed: new Date(p.uts * 1000)
        }));
        for (let i = 0; i < batch.length; i += 5000) {
            await prisma.userPlay.createMany({ data: batch.slice(i, i + 5000), skipDuplicates: true });
        }
    }

    // 5. Delete removed plays from UserPlay
    if (removedPlays.length > 0) {
        const removeIds = removedPlays.map(rp => rp.id);
        await prisma.userPlay.deleteMany({ where: { id: { in: removeIds } } });
    }

    // 6. Update aggregates: INCREMENT for new plays
    const addArtists = new Map<string, { name: string, count: number }>();
    const addTracks = new Map<string, { artistName: string, trackName: string, count: number }>();
    const addAlbums = new Map<string, { artistName: string, albumName: string, count: number }>();

    for (const p of newPlays) {
        const ak = p.artistName.toLowerCase();
        if (!addArtists.has(ak)) addArtists.set(ak, { name: p.artistName, count: 0 });
        addArtists.get(ak)!.count += 1;

        const tk = `${ak}:::${p.trackName.toLowerCase()}`;
        if (!addTracks.has(tk)) addTracks.set(tk, { artistName: p.artistName, trackName: p.trackName, count: 0 });
        addTracks.get(tk)!.count += 1;

        if (p.albumName) {
            const alk = `${ak}:::${p.albumName.toLowerCase()}`;
            if (!addAlbums.has(alk)) addAlbums.set(alk, { artistName: p.artistName, albumName: p.albumName, count: 0 });
            addAlbums.get(alk)!.count += 1;
        }
    }

    // 7. Update aggregates: DECREMENT for removed plays
    const subArtists = new Map<string, { name: string, count: number }>();
    const subTracks = new Map<string, { artistName: string, trackName: string, count: number }>();
    const subAlbums = new Map<string, { artistName: string, albumName: string, count: number }>();

    for (const p of removedPlays) {
        const ak = p.artistName.toLowerCase();
        if (!subArtists.has(ak)) subArtists.set(ak, { name: p.artistName, count: 0 });
        subArtists.get(ak)!.count += 1;

        const tk = `${ak}:::${p.trackName.toLowerCase()}`;
        if (!subTracks.has(tk)) subTracks.set(tk, { artistName: p.artistName, trackName: p.trackName, count: 0 });
        subTracks.get(tk)!.count += 1;

        if (p.albumName) {
            const alk = `${ak}:::${p.albumName.toLowerCase()}`;
            if (!subAlbums.has(alk)) subAlbums.set(alk, { artistName: p.artistName, albumName: p.albumName, count: 0 });
            subAlbums.get(alk)!.count += 1;
        }
    }

    // 8. Apply increments (parameterized — no SQL injection)
    const UPSERT_BATCH = 500;

    for (const [, d] of addArtists) {
        await prisma.$executeRaw`
            INSERT INTO user_artists (id, user_id, artist_name, playcount)
            VALUES (${'ar_' + Math.random().toString(36).substring(2)}, ${userId}, ${d.name}, ${d.count})
            ON CONFLICT (user_id, artist_name)
            DO UPDATE SET playcount = user_artists.playcount + ${d.count}`;
    }
    for (const [, d] of addTracks) {
        await prisma.$executeRaw`
            INSERT INTO user_tracks (id, user_id, artist_name, track_name, playcount)
            VALUES (${'tr_' + Math.random().toString(36).substring(2)}, ${userId}, ${d.artistName}, ${d.trackName}, ${d.count})
            ON CONFLICT (user_id, artist_name, track_name)
            DO UPDATE SET playcount = user_tracks.playcount + ${d.count}`;
    }
    for (const [, d] of addAlbums) {
        await prisma.$executeRaw`
            INSERT INTO user_albums (id, user_id, artist_name, album_name, playcount)
            VALUES (${'al_' + Math.random().toString(36).substring(2)}, ${userId}, ${d.artistName}, ${d.albumName}, ${d.count})
            ON CONFLICT (user_id, artist_name, album_name)
            DO UPDATE SET playcount = user_albums.playcount + ${d.count}`;
    }

    // 9. Apply decrements
    for (const [, d] of subArtists) {
        await prisma.$executeRaw`
            UPDATE user_artists SET playcount = GREATEST(playcount - ${d.count}, 0)
            WHERE user_id = ${userId} AND artist_name = ${d.name}`;
    }
    for (const [, d] of subTracks) {
        await prisma.$executeRaw`
            UPDATE user_tracks SET playcount = GREATEST(playcount - ${d.count}, 0)
            WHERE user_id = ${userId} AND artist_name = ${d.artistName} AND track_name = ${d.trackName}`;
    }
    for (const [, d] of subAlbums) {
        await prisma.$executeRaw`
            UPDATE user_albums SET playcount = GREATEST(playcount - ${d.count}, 0)
            WHERE user_id = ${userId} AND artist_name = ${d.artistName} AND album_name = ${d.albumName}`;
    }
}

// ─────────────────────── Backfill track durations ───────────────────────

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

// ─────────────────────── Drift Detection (Phase 4) ───────────────────────

/**
 * Compare local aggregate playcounts against Last.fm's reported total.
 * Auto-triggers FULL_SYNC when drift exceeds 20%.
 */
async function detectDrift(userId: string, username: string, sessionKey: string | null, discordId: string) {
    try {
        const lfmInfo = await LastFM.getUserInfo(username, sessionKey);
        const lfmTotal = parseInt(lfmInfo?.playcount || '0', 10);
        if (lfmTotal === 0) return;

        const dbTotal = await prisma.userArtist.aggregate({
            where: { userId },
            _sum: { playcount: true }
        });
        const localTotal = dbTotal._sum.playcount || 0;
        const drift = Math.abs(lfmTotal - localTotal);
        const driftPct = (drift / lfmTotal) * 100;

        if (driftPct > 20) {
            console.error(`[Queue] 🔴 CRITICAL DRIFT for ${username}: ${driftPct.toFixed(1)}% (LFM: ${lfmTotal.toLocaleString()}, DB: ${localTotal.toLocaleString()}). Auto-triggering FULL_SYNC...`);
            // Auto-trigger FULL_SYNC to self-heal
            if (indexQueue) {
                await indexQueue.add(`auto-full-${discordId}`, { discordId, type: 'FULL_SYNC' }, {
                    jobId: `auto-full-${discordId}`,
                    removeOnComplete: true,
                    removeOnFail: true,
                    delay: 5000 // Small delay to avoid hammering
                });
            }
        } else if (driftPct > 5) {
            console.warn(`[Queue] ⚠️ Drift detected for ${username}: ${driftPct.toFixed(1)}% (LFM: ${lfmTotal.toLocaleString()}, DB: ${localTotal.toLocaleString()}).`);
        } else {
            console.log(`[Queue] ✅ ${username} drift OK: ${driftPct.toFixed(1)}% (LFM: ${lfmTotal.toLocaleString()}, DB: ${localTotal.toLocaleString()})`);
        }
    } catch (err) {
        // Non-critical — don't let drift check break the sync pipeline
    }
}

// ─────────────────────── History Import (unchanged) ───────────────────────

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

// ─────────────────────── Worker Bootstrap ───────────────────────

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
