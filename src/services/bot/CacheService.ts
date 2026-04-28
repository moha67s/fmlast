import IORedis from 'ioredis';
import { LoggerService } from './LoggerService';

const REDIS_URL = process.env.REDIS_URL?.replace(/^["']|["']$/g, '') || '';

export class CacheService {
    private static redis: IORedis | null = REDIS_URL ? new IORedis(REDIS_URL, {
        connectTimeout: 10000,
        commandTimeout: 10000,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        enableOfflineQueue: true, // Allow small buffer during blips
    }) : null;

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
     * Set a value in cache
     */
    static async set(key: string, value: any, ttl: number): Promise<void> {
        if (!this.redis) return;
        try {
            await this.redis.set(key, JSON.stringify(value), 'EX', ttl);
        } catch (err) {
            LoggerService.error(`Cache Set Failed [${key}]`, err, 'Cache');
        }
    }

    /**
     * Get multiple values in one command
     */
    static async mget<T>(keys: string[]): Promise<Map<string, T>> {
        const result = new Map<string, T>();
        if (!this.redis || keys.length === 0) return result;
        try {
            const values = await this.redis.mget(...keys);
            keys.forEach((key, i) => {
                const val = values[i];
                if (val) {
                    try { result.set(key, JSON.parse(val)); } catch { }
                }
            });
        } catch (err) {
            LoggerService.error('Cache MGET Failed', err, 'Cache');
        }
        return result;
    }

    /**
     * Set multiple values using a pipeline
     */
    static async mset(entries: { key: string, value: any, ttl: number }[]): Promise<void> {
        if (!this.redis || entries.length === 0) return;
        try {
            const pipeline = this.redis.pipeline();
            for (const { key, value, ttl } of entries) {
                pipeline.set(key, JSON.stringify(value), 'EX', ttl);
            }
            await pipeline.exec();
        } catch (err) {
            LoggerService.error('Cache MSET Failed', err, 'Cache');
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
