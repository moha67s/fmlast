import { prisma } from '../../database/client';
import { triggerDeltaSync } from './QueueWorker';
import { LoggerService } from './LoggerService';

/**
 * SyncScheduler — Proactive background sync for stale users.
 * 
 * Runs on a configurable interval (default: 4 hours).
 * Finds users whose lastSyncTimestamp is older than the stale threshold
 * and enqueues them for a DELTA_SYNC via BullMQ.
 * 
 * Rate-limits to max 5 users per tick to avoid API bursts.
 */
export class SyncScheduler {
    private static interval: NodeJS.Timeout | null = null;
    private static isRunning = false;

    /**
     * Start the scheduler.
     * @param intervalMinutes How often to check for stale users (default: 240 = 4 hours)
     */
    static start(intervalMinutes = 240) {
        if (this.interval) return; // Already started

        // Run first tick after 2 minutes (let the bot fully boot)
        setTimeout(() => this.tick(), 2 * 60 * 1000);

        this.interval = setInterval(() => this.tick(), intervalMinutes * 60 * 1000);
        LoggerService.info(`Scheduler started — checking every ${intervalMinutes} minutes for stale users.`, 'SyncScheduler');
    }

    /**
     * Single tick: find stale users and enqueue delta syncs.
     */
    private static async tick() {
        if (this.isRunning) return; // Prevent overlapping ticks
        this.isRunning = true;

        try {
            const staleThresholdUnix = Math.floor(Date.now() / 1000) - (4 * 3600); // 4 hours

            // Find users with a lastfm username whose lastSyncTimestamp is old
            // We store lastSyncTimestamp inside the JSON `settings` field,
            // so we need to fetch and filter in JS.
            const allLinkedUsers = await prisma.user.findMany({
                where: {
                    lastfmUsername: { not: null }
                },
                select: {
                    discordId: true,
                    lastfmUsername: true,
                    settings: true
                },
                orderBy: { updatedAt: 'asc' },
                take: 50 // Pre-filter to reasonable set
            });

            const staleUsers = allLinkedUsers.filter(u => {
                const settings = (u.settings as any) || {};
                const lastSync = settings.lastSyncTimestamp || 0;
                return lastSync < staleThresholdUnix;
            }).slice(0, 5); // Max 5 per tick

            if (staleUsers.length === 0) {
                return; // Nothing to do
            }

            console.log(`[SyncScheduler] Found ${staleUsers.length} stale user(s). Enqueuing delta syncs...`);

            for (const user of staleUsers) {
                try {
                    await triggerDeltaSync(user.discordId, true); // Force bypass cooldown
                    console.log(`[SyncScheduler] Queued: ${user.lastfmUsername}`);
                } catch (err) {
                    console.error(`[SyncScheduler] Failed to queue ${user.lastfmUsername}:`, err);
                }
                // Small delay between enqueues
                await new Promise(r => setTimeout(r, 500));
            }
        } catch (err) {
            console.error('[SyncScheduler] Tick error:', err);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * Stop the scheduler.
     */
    static stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}
