import axios from 'axios';
import crypto from 'crypto';
import { prisma } from '../../database/client';
import { CacheService } from '../bot/CacheService';

const API_KEY = process.env.LASTFM_API_KEY!;
const API_SECRET = process.env.LASTFM_API_SECRET!;
const ROOT = 'https://ws.audioscrobbler.com/2.0/';

if (!API_KEY || !API_SECRET) {
    throw new Error('LASTFM_API_KEY and LASTFM_API_SECRET must be in .env');
}

export class LastFM {
    private static sign(params: Record<string, any>): string {
        const keys = Object.keys(params).filter(k => k !== 'format').sort();
        const string = keys.map(k => k + params[k]).join('');
        return crypto.createHash('md5').update(string + API_SECRET).digest('hex');
    }

    /** 
     * Unified Request Helper
     * Automatically attempts Public -> Authenticated (if priv/403) -> Public (if stab/500)
     */
    private static async request(method: string, username: string | null, params: Record<string, string> = {}, sessionKey?: string | null, forceAuth = false, isPost = false) {
        const baseParams: any = {
            ...params,
            method,
            api_key: API_KEY,
            format: 'json'
        };
        if (username) baseParams.user = username;

        // AUTHENTICATED WRITE METHODS (Always Signed & usually POST)
        if (isPost && sessionKey) {
            const authParams = { ...baseParams, sk: sessionKey };
            const sig = this.sign(authParams);
            const body = new URLSearchParams({ ...authParams, api_sig: sig });

            try {
                const { data } = await axios.post(ROOT, body.toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });
                if (data.error) throw data;
                return data;
            } catch (err: any) {
                const errorData = err.response?.data || err;
                throw new Error(errorData.message || `Last.fm write error (${errorData.error || 'unknown'})`);
            }
        }

        // 0. Check if we ALREADY know this user is private to skip the 403 trip
        const isPrivateCacheKey = username ? `lfm:priv:${username.toLowerCase()}` : null;
        let knownPrivate = false;
        if (isPrivateCacheKey) {
            knownPrivate = await CacheService.get<string>(isPrivateCacheKey) === '1';
        }

        // 1. Try Public Request first (Standard, no signing)
        if (!forceAuth && !isPost && !knownPrivate) {
            try {
                const { data } = await axios.get(ROOT, { params: baseParams });
                if (data.error && data.error === 17 && sessionKey) {
                    // FALLTHROUGH to authenticated if it's explicitly a session error
                } else if (data.error) {
                    throw data; // Let handle catch other errors
                } else {
                    return data;
                }
            } catch (err: any) {
                const error = err.response?.data?.error || err.error;
                // Error 17 = SessionRequired (User is likely private)
                if (error === 17 && sessionKey) {
                    if (isPrivateCacheKey) {
                        await CacheService.set(isPrivateCacheKey, '1', 86400 * 7); // Remember for 7 days
                        console.log(`🔐 User ${username} detected as Private. Retrying with authentication...`);
                    }
                } else {
                    throw new Error(err.response?.data?.message || err.message || 'Last.fm API unavailable');
                }
            }
        }

        // 2. Try Authenticated Request (Signed)
        if (sessionKey) {
            const authParams = { ...baseParams, sk: sessionKey };
            const sig = this.sign(authParams);
            try {
                const { data } = await axios.get(ROOT, { params: { ...authParams, api_sig: sig } });
                if (data.error) throw data;
                return data;
            } catch (err: any) {
                const error = err.response?.data?.error || err.error;
                // Error 8 = Operation Failed (Internal LFM error)
                if (error === 8) {
                    console.warn(`⚠️ Authenticated request for ${username || 'method ' + method} failed (500/Error 8). Giving public one last shot...`);
                    try {
                        const fallData = await axios.get(ROOT, { params: baseParams });
                        if (fallData.data?.error === 17) {
                            console.warn(`⚠️ ${username} has a private profile and Last.fm server is down. Returning empty.`);
                            return { __privateProfile: true };
                        }
                        return fallData.data;
                    } catch (fallErr: any) {
                        const fallErrCode = fallErr.response?.data?.error;
                        if (fallErrCode === 17) {
                            console.warn(`⚠️ ${username} private profile + server down. Returning empty.`);
                            return { __privateProfile: true };
                        }
                        throw new Error(fallErr.response?.data?.message || fallErr.message || 'Last.fm API unavailable');
                    }
                }
                throw new Error(err.response?.data?.message || err.message || 'Last.fm API unavailable');
            }
        }

        throw new Error('Request failed and no session key available for fallback');
    }

    /** Step 1: Get request token */
    static async getToken(): Promise<string> {
        const params = { method: 'auth.getToken', api_key: API_KEY, format: 'json' };
        const sig = this.sign(params);
        const { data } = await axios.get(ROOT, { params: { ...params, api_sig: sig } });
        return data.token;
    }

    /** Step 2: Exchange token for session key + username */
    static async getSession(token: string) {
        const params = { method: 'auth.getSession', api_key: API_KEY, token, format: 'json' };
        const sig = this.sign(params);
        const { data } = await axios.get(ROOT, { params: { ...params, api_sig: sig } });
        return data.session as { key: string; name: string };
    }

    /** Complete login flow */
    static async completeLogin(discordId: string) {
        const user = await prisma.user.findUnique({ where: { discordId } });
        if (!user?.lastfmRequestToken) throw new Error('No pending login found.');

        const session = await this.getSession(user.lastfmRequestToken);

        await prisma.user.update({
            where: { discordId },
            data: {
                lastfmUsername: session.name,
                lastfmSessionKey: session.key,
                lastfmRequestToken: null,
            },
        });

        return session.name;
    }

    // ===================== USER METHODS =====================

    /** Get current / last played track (Public with Private Fallback) */
    static async getRecentTracks(username: string, limit = 1, sessionKey?: string | null) {
        const data = await this.request('user.getRecentTracks', username, { limit: String(limit) }, sessionKey);
        return data.recenttracks?.track as any[] || [];
    }

    /** Get paginated recent tracks for background indexing */
    static async getRecentTracksPaginated(username: string, limit = 200, page = 1, sessionKey?: string | null, forceAuth = false, fromTimestamp?: number) {
        const payload: any = { limit: String(limit), page: String(page), extended: '0' };
        if (fromTimestamp) payload.from = String(fromTimestamp);

        const data = await this.request('user.getRecentTracks', username, payload, sessionKey, forceAuth);
        return {
            tracks: (Array.isArray(data.recenttracks?.track) ? data.recenttracks?.track : (data.recenttracks?.track ? [data.recenttracks?.track] : [])) as any[],
            meta: data.recenttracks?.['@attr'] as { page: string; total: string; user: string; perPage: string; totalPages: string; } | undefined
        };
    }

    /** Get user info (total scrobbles, etc.) */
    static async getUserInfo(username: string, sessionKey?: string | null) {
        const cacheKey = `lfm:userinfo:${username.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 3600, async () => {
            const data = await this.request('user.getInfo', username, {}, sessionKey);
            return data.user as any;
        });
    }

    /**
     * Get total scrobble count for a specific time window (from/to unix timestamps).
     * Uses limit=1 and reads the `@attr.total` field — very cheap API call.
     */
    static async getScrobbleCountForPeriod(username: string, from: number, to: number, sessionKey?: string | null): Promise<number> {
        const data = await this.request('user.getRecentTracks', username, {
            limit: '1',
            from:  String(from),
            to:    String(to),
            extended: '0',
        }, sessionKey);
        return parseInt(data.recenttracks?.['@attr']?.total || '0', 10);
    }

    /** Get top artists - with fallback to recent track counting if endpoint is down */
    static async getTopArtists(username: string, period: string, limit: number, sessionKey?: string | null): Promise<any[]> {
        try {
            const data = await this.request('user.getTopArtists', username, { period, limit: String(limit) }, sessionKey);
            const list = data.topartists?.artist as any[] || [];
            if (list.length > 0) return list;
        } catch { }

        // Fallback: derive top artists from recent track history by counting frequency
        console.warn(`⚠️ getTopArtists empty for ${username}, falling back to recent track counting...`);
        return this.getTopArtistsFallback(username, limit, sessionKey);
    }

    /** Derive top artists by counting occurrences in recent 200 tracks */
    static async getTopArtistsFallback(username: string, limit: number, sessionKey?: string | null): Promise<any[]> {
        try {
            const data = await this.request('user.getRecentTracks', username, { limit: '200', extended: '0' }, sessionKey);
            const tracks: any[] = data.recenttracks?.track || [];
            const counts = new Map<string, number>();
            for (const t of tracks) {
                const artistName = t.artist?.['#text'] || t.artist?.name;
                if (!artistName) continue;
                counts.set(artistName, (counts.get(artistName) || 0) + 1);
            }
            return Array.from(counts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, limit)
                .map(([name, playcount]) => ({ name, playcount: String(playcount) }));
        } catch {
            return [];
        }
    }

    /** Get top albums */
    static async getTopAlbums(username: string, period: string, limit: number, sessionKey?: string | null) {
        const cacheKey = `lfm:topal:${username.toLowerCase()}:${period}:${limit}`;
        return CacheService.wrap(cacheKey, 300, async () => {
            const data = await this.request('user.getTopAlbums', username, { period, limit: String(limit) }, sessionKey);
            return data.topalbums?.album as any[] || [];
        });
    }

    /** Get top tracks */
    static async getTopTracks(username: string, period: string, limit: number, sessionKey?: string | null) {
        const data = await this.request('user.getTopTracks', username, { period, limit: String(limit) }, sessionKey);
        return data.toptracks?.track as any[] || [];
    }

    /** Get album chart for a custom date range (from/to as unix timestamps) */
    static async getWeeklyAlbumChart(username: string, from?: number, to?: number, limit = 50, sessionKey?: string | null) {
        const cacheKey = `lfm:weekal:${username.toLowerCase()}:${from}:${to}:${limit}`;
        return CacheService.wrap(cacheKey, 300, async () => {
            const params: Record<string, string> = { limit: String(limit) };
            if (from) params.from = String(from);
            if (to) params.to = String(to);

            const data = await this.request('user.getWeeklyAlbumChart', username, params, sessionKey);
            const albums = data.weeklyalbumchart?.album as any[] || [];

            return albums.slice(0, limit).map((a: any) => ({
                name: a.name,
                artist: { name: a.artist?.['#text'] || a.artist?.name || 'Unknown', mbid: a.artist?.mbid },
                playcount: a.playcount,
                mbid: a.mbid,
                url: a.url,
                image: a.image || []
            }));
        });
    }

    /** Get artist chart for a custom date range (from/to as unix timestamps) */
    static async getWeeklyArtistChart(username: string, from?: number, to?: number, limit = 50, sessionKey?: string | null) {
        const params: Record<string, string> = { limit: String(limit) };
        if (from) params.from = String(from);
        if (to) params.to = String(to);

        const data = await this.request('user.getWeeklyArtistChart', username, params, sessionKey);
        const artists = data.weeklyartistchart?.artist as any[] || [];

        return artists.slice(0, limit).map((a: any) => ({
            name: a.name,
            playcount: a.playcount,
            mbid: a.mbid,
            url: a.url
        }));
    }

    // ===================== SEARCH METHODS =====================

    /** Search for a track by name */
    static async searchTracks(query: string, limit = 1, sessionKey?: string | null) {
        const data = await this.request('track.search', null, { track: query, limit: String(limit) }, sessionKey);
        const tracks = data.results?.trackmatches?.track;
        return Array.isArray(tracks) ? tracks : (tracks ? [tracks] : []);
    }

    /** Search for an album by name */
    static async searchAlbums(query: string, limit = 1, sessionKey?: string | null) {
        const data = await this.request('album.search', null, { album: query, limit: String(limit) }, sessionKey);
        const albums = data.results?.albummatches?.album;
        return Array.isArray(albums) ? albums : (albums ? [albums] : []);
    }

    // ===================== ARTIST / TRACK INFO METHODS =====================

    /** Get top tags for an artist */
    static async getArtistTopTags(artist: string, sessionKey?: string | null) {
        const data = await this.request('artist.getTopTags', null, { artist }, sessionKey);
        return data.toptags?.tag as any[] || [];
    }

    /** Get top tracks for a specific tag */
    static async getTagTopTracks(tag: string, limit = 50, sessionKey?: string | null) {
        const data = await this.request('tag.getTopTracks', null, { tag, limit: String(limit) }, sessionKey);
        return data.tracks?.track as any[] || [];
    }

    /** Get similar tracks for a specific track */
    static async getSimilarTracks(artist: string, track: string, limit = 5, sessionKey?: string | null) {
        const data = await this.request('track.getSimilar', null, { artist, track, limit: String(limit) }, sessionKey);
        return data.similartracks?.track as any[] || [];
    }

    /** Get similar artists for a specific artist */
    static async getSimilarArtists(artist: string, limit = 5, sessionKey?: string | null) {
        const data = await this.request('artist.getSimilar', null, { artist, limit: String(limit) }, sessionKey);
        return data.similarartists?.artist as any[] || [];
    }

    /** Get top tracks for an artist (Artist level) */
    static async getArtistTopTracks(artist: string, limit = 5, sessionKey?: string | null) {
        const data = await this.request('artist.getTopTracks', null, { artist, limit: String(limit) }, sessionKey);
        return data.toptracks?.track as any[] || [];
    }

    /** Get track metadata (Public with Private Fallback) */
    static async getTrackInfo(artist: string, track: string, username?: string | null, sessionKey?: string | null) {
        const params: Record<string, string> = { artist, track, autocorrect: '1' };
        const data = await this.request('track.getInfo', username || null, params, sessionKey);
        return data.track as any;
    }

    /** Get artist metadata (Public with Private Fallback) */
    static async getArtistInfo(artist: string, username?: string | null, sessionKey?: string | null) {
        const params: Record<string, string> = { artist, autocorrect: '1' };
        const data = await this.request('artist.getInfo', username || null, params, sessionKey);
        return data.artist as any;
    }

    /** Get album metadata including tracklist */
    static async getAlbumInfo(artist: string, album: string, username?: string | null, sessionKey?: string | null) {
        const params: Record<string, string> = { artist, album, autocorrect: '1' };
        const data = await this.request('album.getInfo', username || null, params, sessionKey);
        return data.album as any;
    }

    // ===================== WRITE METHODS =====================

    /** Update Now Playing status */
    static async updateNowPlaying(artist: string, track: string, sessionKey: string, extra: Record<string, string> = {}) {
        return this.request('track.updateNowPlaying', null, { artist, track, ...extra }, sessionKey, true, true);
    }

    /** Scrobble a track */
    static async scrobble(artist: string, track: string, timestamp: number, sessionKey: string, extra: Record<string, string> = {}) {
        return this.request('track.scrobble', null, { artist, track, timestamp: String(timestamp), ...extra }, sessionKey, true, true);
    }

    /** 
     * Batch Scrobble (up to 50 tracks) 
     * Logic: array inputs for artist, track, timestamp
     */
    static async scrobbleBatch(tracks: { artist: string; track: string; timestamp: number; album?: string }[], sessionKey: string) {
        const params: Record<string, string> = {};
        tracks.forEach((t, i) => {
            params[`artist[${i}]`] = t.artist;
            params[`track[${i}]`] = t.track;
            params[`timestamp[${i}]`] = String(t.timestamp);
            if (t.album) params[`album[${i}]`] = t.album;
        });

        return this.request('track.scrobble', null, params, sessionKey, true, true);
    }

    // ===================== UTILS =====================

    /** Check if Last.fm returned the default "no image" star */
    static isDefaultImage(url?: string): boolean {
        return !!url && url.includes('2a96cbd8b46e442fc41c2b86b821562f');
    }
}
