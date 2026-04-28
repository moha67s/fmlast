import { CacheService } from './CacheService';
import { LoggerService } from './LoggerService';

/**
 * LastfmHealthTracker — Redis-backed sliding window error rate tracker.
 *
 * Mirrors the original C# LastfmErrorRateTracker.cs:
 * - Tracks Last.fm API success/failure over a 5-minute sliding window
 * - Provides a sparkline visualization of error rate per bucket
 * - Exposes isHealthy() to gate commands during outages
 * - Exposes getStatusLine() for embedding health info in command responses
 */

const REDIS_PREFIX = 'lfm:health';
const BUCKET_SECONDS = 30;       // Each bucket covers 30 seconds
const WINDOW_BUCKETS = 10;       // 10 buckets = 5 minutes total
const ERROR_THRESHOLD = 0.15;    // 15% error rate = unhealthy

// Sparkline blocks from lowest to highest
const SPARKLINE_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export class LastfmHealthTracker {
    private static _issuesAtLastFm = false;

    /** Whether Last.fm is currently experiencing issues */
    static get issuesAtLastFm(): boolean {
        return this._issuesAtLastFm;
    }

    /**
     * Record a successful Last.fm API call.
     */
    static async recordSuccess(): Promise<void> {
        await this.incrementBucket('ok');
    }

    /**
     * Record a failed Last.fm API call (500, 503, Error 8, timeouts).
     */
    static async recordFailure(): Promise<void> {
        await this.incrementBucket('fail');
    }

    /**
     * Check the current health state. Call periodically or before critical operations.
     * Returns true if Last.fm is healthy (error rate < threshold).
     */
    static async isHealthy(): Promise<boolean> {
        const { errorRate } = await this.getWindowStats();
        this._issuesAtLastFm = errorRate >= ERROR_THRESHOLD;
        return !this._issuesAtLastFm;
    }

    /**
     * Get the current error rate as a percentage (0-100).
     */
    static async getErrorRate(): Promise<number> {
        const { errorRate } = await this.getWindowStats();
        return Math.round(errorRate * 100);
    }

    /**
     * Generate a sparkline string representing error rates per bucket across the window.
     * Example: "▁▁▂▃▅▇█▆▃▁"
     */
    static async getSparkline(): Promise<string> {
        const bucketRates = await this.getBucketErrorRates();
        if (bucketRates.length === 0) return '';

        return bucketRates.map(rate => {
            const idx = Math.min(
                Math.floor(rate * (SPARKLINE_CHARS.length - 1)),
                SPARKLINE_CHARS.length - 1
            );
            return SPARKLINE_CHARS[Math.max(0, idx)];
        }).join('');
    }

    /**
     * Get a full status line suitable for embedding in command responses.
     * Returns null if Last.fm is healthy (no need to show anything).
     * Returns a warning string with sparkline if degraded.
     */
    static async getStatusLine(): Promise<string | null> {
        const { errorRate, totalCalls } = await this.getWindowStats();
        
        // Don't show anything if we have too few data points or if healthy
        if (totalCalls < 5 || errorRate < ERROR_THRESHOLD) return null;

        const sparkline = await this.getSparkline();
        const pct = Math.round(errorRate * 100);

        return `⚠️ Last.fm is experiencing issues (${pct}% error rate) ${sparkline}`;
    }

    // ─── Internal Helpers ───────────────────────────────────────────

    /**
     * Get the current bucket key based on the current timestamp.
     */
    private static getBucketKey(offsetBuckets = 0): string {
        const now = Math.floor(Date.now() / 1000);
        const bucket = Math.floor(now / BUCKET_SECONDS) - offsetBuckets;
        return `${REDIS_PREFIX}:${bucket}`;
    }

    /**
     * Increment the ok or fail counter for the current time bucket.
     */
    private static async incrementBucket(type: 'ok' | 'fail'): Promise<void> {
        try {
            const key = this.getBucketKey();
            const data = await CacheService.get<{ ok: number; fail: number }>(key) || { ok: 0, fail: 0 };
            data[type]++;
            // TTL slightly longer than the window to ensure old buckets expire
            await CacheService.set(key, data, BUCKET_SECONDS * (WINDOW_BUCKETS + 2));
        } catch (err) {
            // Fail silently — tracking should never break the bot
        }
    }

    /**
     * Get aggregate stats across the entire sliding window.
     */
    private static async getWindowStats(): Promise<{ totalOk: number; totalFail: number; totalCalls: number; errorRate: number }> {
        let totalOk = 0;
        let totalFail = 0;

        for (let i = 0; i < WINDOW_BUCKETS; i++) {
            const key = this.getBucketKey(i);
            const data = await CacheService.get<{ ok: number; fail: number }>(key);
            if (data) {
                totalOk += data.ok;
                totalFail += data.fail;
            }
        }

        const totalCalls = totalOk + totalFail;
        const errorRate = totalCalls > 0 ? totalFail / totalCalls : 0;

        return { totalOk, totalFail, totalCalls, errorRate };
    }

    /**
     * Get per-bucket error rates for sparkline generation.
     */
    private static async getBucketErrorRates(): Promise<number[]> {
        const rates: number[] = [];

        // Oldest to newest for left-to-right sparkline
        for (let i = WINDOW_BUCKETS - 1; i >= 0; i--) {
            const key = this.getBucketKey(i);
            const data = await CacheService.get<{ ok: number; fail: number }>(key);
            if (data) {
                const total = data.ok + data.fail;
                rates.push(total > 0 ? data.fail / total : 0);
            } else {
                rates.push(0);
            }
        }

        return rates;
    }
}
