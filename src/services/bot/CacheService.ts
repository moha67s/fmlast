import IORedis from 'ioredis';
import { LoggerService } from './LoggerService';

const REDIS_URL = process.env.REDIS_URL?.replace(/^["']|["']$/g, '') || '';

export class CacheService {
    private static redis: IORedis | null = REDIS_URL ? new IORedis(REDIS_URL) : null;

    /**
     * Get a value from cache
     */
    static async get<T>(key: string): Promise<T | null> {
        if (!this.redis) return null;
        try {
            const data = await this.redis.get(key);
            if (!data) return null;
            return JSON.parse(data) as T;
        } catch (err) {
            LoggerService.error(`Cache Get Failed [${key}]`, err, 'Cache');
            return null;
        }
    }

    /**
     * Set a value in cache with expiration (default 1 hour)
     */
    static async set(key: string, value: any, ttlSeconds: number = 3600): Promise<void> {
        if (!this.redis) return;
        try {
            const data = JSON.stringify(value);
            await this.redis.set(key, data, 'EX', ttlSeconds);
        } catch (err) {
            LoggerService.error(`Cache Set Failed [${key}]`, err, 'Cache');
        }
    }

    /**
     * Delete a value from cache
     */
    static async del(key: string): Promise<void> {
        if (!this.redis) return;
        await this.redis.del(key);
    }

    /**
     * Helper to wrap a function with caching
     */
    static async wrap<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
        const cached = await this.get<T>(key);
        if (cached !== null) return cached;

        const fresh = await fn();
        if (fresh !== null && fresh !== undefined) {
            await this.set(key, fresh, ttl);
        }
        return fresh;
    }
}
