import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { prisma } from '../../database/client';
import { LastFM } from '../api/LastFM';
import { LastfmHealthTracker } from './LastfmHealthTracker';
import { LoggerService } from './LoggerService';
import { triggerDeltaSync } from './QueueWorker';

/**
 * CronManager — BullMQ-based repeatable job scheduler.
 *
 * Mirrors the original C# TimerService.cs / Hangfire architecture:
 * - Stale user sync (every 4 hours — like AddUsersToUpdateQueue)
 * - Track duration backfill (every 20 minutes — like EnrichMissingMetadata)
 * - Last.fm health check (every 30 seconds — like UpdateHealthCheck)
 * - Drift detection sweep (every 12 hours)
 *
 * All jobs are durable via Redis and survive bot restarts.
 */

const REDIS_URL = process.env.REDIS_URL?.replace(/^["']|["']$/g, '') || '';

let cronQueue: Queue | null = null;
let cronWorker: Worker | null = null;

type CronJobName = 
    | 'sync-stale-users'
    | 'backfill-track-durations'
    | 'lastfm-health-check'
    | 'drift-detection-sweep'
    | 'enrich-global-metadata';

interface CronJobData {
    name: CronJobName;
}

export class CronManager {
    /**
     * Initialize and start all repeatable cron jobs.
     * Call once during bootstrap after Redis is confirmed available.
     */
    static async start(): Promise<void> {
        if (!REDIS_URL) {
            LoggerService.warn('REDIS_URL missing — CronManager will not start.', 'CronManager');
            return;
        }

        const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

        cronQueue = new Queue('cron-jobs', { connection });

        // Remove any stale repeatable jobs from previous deploys
        const existing = await cronQueue.getRepeatableJobs();
        for (const job of existing) {
            await cronQueue.removeRepeatableByKey(job.key);
        }

        // ── Register Repeatable Jobs ────────────────────────────────────

        // 1. Stale user sync — every 12 hours (mirrors AddUsersToUpdateQueue: "0 */12 * * *")
        await cronQueue.add('sync-stale-users', { name: 'sync-stale-users' }, {
            repeat: { pattern: '0 */12 * * *' },
            removeOnComplete: true,
            removeOnFail: true,
        });

        // 2. Track duration backfill — every 20 minutes (mirrors EnrichMissingMetadata: "*/20 * * * *")
        await cronQueue.add('backfill-track-durations', { name: 'backfill-track-durations' }, {
            repeat: { pattern: '*/20 * * * *' },
            removeOnComplete: true,
            removeOnFail: true,
        });

        // 3. Last.fm health check — every 30 seconds (mirrors UpdateHealthCheck: "*/20 * * * * *")
        await cronQueue.add('lastfm-health-check', { name: 'lastfm-health-check' }, {
            repeat: { every: 30_000 },
            removeOnComplete: true,
            removeOnFail: true,
        });

        // 4. Drift detection sweep is DISABLED. 
        // We now use FMBot's SmallIndex system probabilistically inside Delta Syncs.
        // No need to spam the API for all users every 12 hours.

        // 5. Enrich global metadata — every 1 hour (MB enrichment)
        await cronQueue.add('enrich-global-metadata', { name: 'enrich-global-metadata' }, {
            repeat: { pattern: '0 * * * *' },
            removeOnComplete: true,
            removeOnFail: true,
        });

        // ── Worker to Process Cron Jobs ─────────────────────────────────

        cronWorker = new Worker('cron-jobs', async (job: Job<CronJobData>) => {
            switch (job.data.name) {
                case 'sync-stale-users':
                    await handleSyncStaleUsers();
                    break;
                case 'backfill-track-durations':
                    await handleBackfillDurations();
                    break;
                case 'lastfm-health-check':
                    await handleHealthCheck();
                    break;
                case 'drift-detection-sweep':
                    // Disabled. Left empty just in case there are lingering jobs in Redis.
                    break;
                case 'enrich-global-metadata':
                    await handleGlobalMetadataEnrichment();
                    break;
            }
        }, { connection, concurrency: 1 });

        cronWorker.on('failed', (job, err) => {
            LoggerService.error(`Cron job ${job?.data?.name} failed`, err, 'CronManager');
        });

        LoggerService.info('CronManager started — 4 repeatable jobs registered.', 'CronManager');
    }

    /**
     * Gracefully stop the cron manager.
     */
    static async stop(): Promise<void> {
        await cronWorker?.close();
        await cronQueue?.close();
    }
}

// ─── Job Handlers ───────────────────────────────────────────────────────

/**
 * Find users whose lastSyncTimestamp is > 4 hours old and enqueue delta syncs.
 * Mirrors TimerService.AddUsersToUpdateQueue — max 10 users per tick.
 */
async function handleSyncStaleUsers(): Promise<void> {
    // Skip if Last.fm is currently having issues
    const healthy = await LastfmHealthTracker.isHealthy();
    if (!healthy) {
        LoggerService.warn('Skipping stale user sync — Last.fm unhealthy', 'CronManager');
        return;
    }

    // Sync all users who haven't updated in over 12 hours (FMBot parity)
    const staleThreshold = Math.floor(Date.now() / 1000) - (12 * 3600);

    const allLinkedUsers = await prisma.user.findMany({
        where: { lastfmUsername: { not: null } },
        select: { discordId: true, lastfmUsername: true, settings: true }
    });

    const staleUsers = allLinkedUsers.filter(u => {
        const settings = (u.settings as any) || {};
        const lastSync = settings.lastSyncTimestamp || 0;
        return lastSync < staleThreshold;
    });

    if (staleUsers.length === 0) return;

    LoggerService.info(`Syncing ${staleUsers.length} stale user(s)...`, 'CronManager');

    for (const user of staleUsers) {
        try {
            await triggerDeltaSync(user.discordId, true);
        } catch (err) {
            LoggerService.error(`Failed to queue sync for ${user.lastfmUsername}`, err, 'CronManager');
        }
        await new Promise(r => setTimeout(r, 300));
    }
}

/**
 * Backfill missing track durations from Last.fm for the most-played tracks.
 * Mirrors TimerService.EnrichMissingMetadata.
 */
async function handleBackfillDurations(): Promise<void> {
    const healthy = await LastfmHealthTracker.isHealthy();
    if (!healthy) return;

    // Get users who have tracks without durations
    const usersWithMissing = await prisma.userTrack.groupBy({
        by: ['userId'],
        where: { duration: null },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
        take: 3, // Process 3 users per tick
    });

    for (const entry of usersWithMissing) {
        const user = await prisma.user.findUnique({ where: { id: entry.userId } });
        if (!user?.lastfmUsername) continue;

        const tracks = await prisma.userTrack.findMany({
            where: { userId: user.id, duration: null },
            orderBy: { playcount: 'desc' },
            take: 15,
        });

        for (const track of tracks) {
            try {
                const info = await LastFM.getTrackInfo(track.artistName, track.trackName, user.lastfmUsername, user.lastfmSessionKey);
                let dur = parseInt(info?.duration || '0', 10);
                if (dur > 0) dur = Math.floor(dur / 1000);
                if (dur > 30) {
                    await prisma.userTrack.update({
                        where: { id: track.id },
                        data: { duration: dur },
                    });
                }
            } catch { }
            await new Promise(r => setTimeout(r, 200));
        }
    }
}

/**
 * Check Last.fm health and log state transitions.
 * Mirrors TimerService.UpdateHealthCheck.
 */
async function handleHealthCheck(): Promise<void> {
    const healthy = await LastfmHealthTracker.isHealthy();
    const errorRate = await LastfmHealthTracker.getErrorRate();

    if (!healthy) {
        const sparkline = await LastfmHealthTracker.getSparkline();
        LoggerService.warn(`Last.fm degraded — ${errorRate}% error rate ${sparkline}`, 'HealthCheck');
    }
}

/**
 * (Disabled) Sweep active users and detect significant drift between Last.fm total and local DB.
 * Replaced by the SmallIndex feature.
 */
async function handleDriftDetection(): Promise<void> {
    return; // Disabled
}

/**
 * Proactively enrich Artists with MusicBrainz metadata (country, gender, type).
 */
async function handleGlobalMetadataEnrichment(): Promise<void> {
    const { MusicBrainz } = await import('../api/MusicBrainz');

    // Get 20 artists without country data
    const staleArtists = await prisma.artist.findMany({
        where: { countryCode: null },
        take: 20
    });

    if (staleArtists.length === 0) return;

    LoggerService.info(`Enriching metadata for ${staleArtists.length} artists...`, 'CronManager');

    for (const artist of staleArtists) {
        try {
            // 1. MusicBrainz Enrichment (Country, Gender, Type)
            const mbInfo = await MusicBrainz.getArtistFullInfo(artist.name);
            if (mbInfo) {
                await prisma.artist.update({
                    where: { id: artist.id },
                    data: {
                        countryCode: mbInfo.metadata.countryCode || null,
                        gender: mbInfo.metadata.gender || null,
                        type: mbInfo.metadata.type || null,
                        updatedAt: new Date()
                    }
                });

                if (mbInfo.links && mbInfo.links.length > 0) {
                    const links = mbInfo.links.map(l => ({
                        artistId: artist.id,
                        type: l.type,
                        url: l.url
                    }));
                    await prisma.artistLink.createMany({ data: links, skipDuplicates: true });
                }
            }

            // 2. Last.fm Tag Enrichment (Genre)
            const tags = await LastFM.getArtistTopTags(artist.name);
            if (tags && tags.length > 0) {
                for (const t of tags.slice(0, 5)) { // Top 5 tags
                    const tagName = t.name.toLowerCase().trim();
                    if (!tagName) continue;

                    const tag = await prisma.tag.upsert({
                        where: { name: tagName },
                        update: {},
                        create: { name: tagName }
                    });

                    await prisma.artistTag.upsert({
                        where: { artistId_tagId: { artistId: artist.id, tagId: tag.id } },
                        update: { count: parseInt(t.count || '0', 10) },
                        create: { artistId: artist.id, tagId: tag.id, count: parseInt(t.count || '0', 10) }
                    });
                }
            }
        } catch (err) {
            // Skip and continue
        }
        await new Promise(r => setTimeout(r, 1100));
    }
}
