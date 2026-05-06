import axios from 'axios';
import { ArtistMetadataService } from '../external/ArtistMetadataService';
import { CacheService } from '../bot/CacheService';
import { LoggerService } from '../bot/LoggerService';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;

let accessToken = '';
let tokenExpires = 0;
let disabledUntil = 0; // Circuit breaker: skip Spotify if API is rejecting us

export class Spotify {
    /** Helper to normalize names for strict comparison */
    private static clean(name: string): string {
        return name.toLowerCase()
            .replace(/&/g, 'and')
            .replace(/[^\p{L}\p{N}]/gu, '');
    }

    /** 
     * Validates if a result is a reasonably close match. 
     */
    private static validateArtist(expected: string, actual: string): boolean {
        const e = this.clean(expected);
        const a = this.clean(actual);
        if (e === a) return true;
        
        // Handle Kanye West / Ye rebrand specifically as it's a common fail point
        const isKanye = (s: string) => s === 'kanyewest' || s === 'ye';
        if (isKanye(e) && isKanye(a)) return true;

        // Check if one is a subset of the other (for collabs/features)
        if (e.length > 3 && (a.includes(e) || e.includes(a))) return true;
        return false;
    }

    /**
     * Ensures the track/album title actually matches what we asked for.
     * Prevents "ye" from matching "Yeezus".
     */
    private static validateTitle(expected: string, actual: string): boolean {
        const e = this.clean(expected);
        const a = this.clean(actual);
        if (e === a) return true;
        
        // Much more permissive for Spotify search results
        if (a.includes(e) || e.includes(a)) return true;
        
        return false;
    }

    private static tokenPromise: Promise<string> | null = null;

    private static async getToken(): Promise<string> {
        // 1. Check in-memory sync cache
        if (Date.now() < tokenExpires && accessToken) return accessToken;

        // 2. Check Redis for a shared token (cross-restart/cross-process)
        const cached = await CacheService.get<string>('sp:token');
        if (cached) {
            accessToken = cached;
            tokenExpires = Date.now() + 3000 * 1000; // Assume valid if in Redis
            return accessToken;
        }

        // 3. If already fetching, wait for that same promise (lock)
        if (this.tokenPromise) return this.tokenPromise;

        this.tokenPromise = (async () => {
            try {
                console.log('🔑 Fetching new Spotify access token...');
                const { data } = await axios.post(
                    'https://accounts.spotify.com/api/token',
                    new URLSearchParams({ grant_type: 'client_credentials' }),
                    {
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
                        },
                    }
                );

                accessToken = data.access_token;
                tokenExpires = Date.now() + (data.expires_in - 60) * 1000;
                
                // Persist to Redis (expires 1 minute before Spotify does)
                await CacheService.set('sp:token', accessToken, data.expires_in - 120);
                
                console.log('✅ Spotify token obtained');
                return accessToken;
            } finally {
                this.tokenPromise = null;
            }
        })();

        return this.tokenPromise;
    }

    /** Check if Spotify API is currently disabled (circuit breaker) */
    static isDisabled(): boolean {
        return Date.now() < disabledUntil;
    }

    private static handleApiError(err: any): void {
        const status = err?.response?.status;
        if (status === 401) {
            // Token expired. Invalidate it so the next request immediately fetches a new one.
            tokenExpires = 0;
            console.warn('⚠️ Spotify token expired (401). Will refresh on next request.');
        } else if (status === 429) {
            // Rate limited. Pause for the Retry-After duration or a default of 10 seconds.
            const retryAfter = err?.response?.headers?.['retry-after'];
            const delay = retryAfter ? parseInt(retryAfter) * 1000 : 10000;
            disabledUntil = Date.now() + delay;
            console.warn(`⚠️ Spotify rate limited (429). Pausing for ${delay / 1000} seconds.`);
        } else if (status === 403) {
            // Forbidden API access. Pause for 1 minute instead of 10.
            disabledUntil = Date.now() + 60 * 1000;
            console.warn('⚠️ Spotify API returned 403. Pausing for 1 minute.');
        }
    }

    /** Search for an album by generic text query (smart fallback) */
    static async searchAlbum(query: string): Promise<{ artist: string, album: string } | null> {
        if (this.isDisabled()) return null;
        try {
            const token = await this.getToken();
            
            // Search for both album and track to catch cases where user searches for a song name
            const { data } = await axios.get('https://api.spotify.com/v1/search', {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                    q: query,
                    type: 'album,track',
                    limit: 1,
                },
            });

            // If an album matched directly, use it
            const matchedAlbum = data.albums?.items?.[0];
            if (matchedAlbum) {
                return { artist: matchedAlbum.artists[0].name, album: matchedAlbum.name };
            }

            // If a track matched, return the album it belongs to
            const matchedTrack = data.tracks?.items?.[0];
            if (matchedTrack) {
                return { artist: matchedTrack.album.artists[0].name, album: matchedTrack.album.name };
            }

            return null;
        } catch (e) {
            this.handleApiError(e);
            return null;
        }
    }

    /** Get best cover with caching */
    static async getTrackCover(trackName: string, artistName: string): Promise<string | null> {
        if (this.isDisabled()) return null;

        const cacheKey = `sp:art:tr:${artistName.toLowerCase()}:${trackName.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 604800, async () => {
            try {
                const token = await this.getToken();

                const { data } = await axios.get('https://api.spotify.com/v1/search', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        q: `artist:${artistName} track:${trackName}`,
                        type: 'track',
                        limit: 3,
                    },
                });

                const tracks = data.tracks?.items || [];
                const overrideId = ArtistMetadataService.getSpotifyId(artistName);

                const bestTrack = tracks.find((t: any) => {
                    const titleMatch = this.validateTitle(trackName, t.name);
                    const artistMatch = t.artists?.some((a: any) => {
                        if (overrideId) return a.id === overrideId;
                        return this.validateArtist(artistName, a.name);
                    });
                    return titleMatch && artistMatch;
                });

                return bestTrack?.album?.images?.[0]?.url || null;
            } catch (err: any) {
                this.handleApiError(err);
                return null;
            }
        });
    }

    /** Get best ALBUM cover from Spotify (used by chart fallback) */
    static async getAlbumCover(albumName: string, artistName: string): Promise<string | null> {
        if (this.isDisabled()) return null;

        const cacheKey = `sp:art:al:${artistName.toLowerCase()}:${albumName.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 604800, async () => {
            try {
                const token = await this.getToken();

                const { data } = await axios.get('https://api.spotify.com/v1/search', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        q: `"${albumName}" "${artistName}"`,
                        type: 'album',
                        limit: 3,
                    },
                });

                const albums = data.albums?.items || [];
                const bestAlbum = albums.find((a: any) =>
                    this.validateTitle(albumName, a.name) &&
                    a.artists?.some((artist: any) => this.validateArtist(artistName, artist.name))
                );

                return bestAlbum?.images?.[0]?.url || null;
            } catch (err: any) {
                this.handleApiError(err);
                return null;
            }
        });
    }

    /** Get best ARTIST cover from Spotify */
    static async getArtistCover(artistName: string): Promise<string | null> {
        if (this.isDisabled()) return null;

        const cacheKey = `sp:art:artist:${artistName.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 604800, async () => {
            try {
                const token = await this.getToken();

                // Check for hardcoded override
                const overrideId = ArtistMetadataService.getSpotifyId(artistName);
                if (overrideId) {
                    const { data } = await axios.get(`https://api.spotify.com/v1/artists/${overrideId}`, {
                        headers: { Authorization: `Bearer ${token}` }
                    });
                    if (data.images?.[0]?.url) return data.images[0].url;
                }

                const { data } = await axios.get('https://api.spotify.com/v1/search', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        q: `"${artistName}"`,
                        type: 'artist',
                        limit: 3,
                    },
                });

                const artistItem = data.artists?.items?.find((a: any) => this.validateArtist(artistName, a.name)) || data.artists?.items?.[0];

                if (artistItem && !this.validateArtist(artistName, artistItem.name)) return null;

                return artistItem?.images?.[0]?.url || null;
            } catch (err: any) {
                this.handleApiError(err);
                return null;
            }
        });
    }

    /** Get track metadata (cover, Spotify URL, duration, names) */
    static async getTrackInfo(trackName: string, artistName: string): Promise<{ 
        coverUrl: string | null; 
        trackUrl: string | null; 
        previewUrl: string | null;
        durationMs: number;
        resolvedArtist: string | null;
        resolvedTrack: string | null;
        albumName: string | null;
    }> {
        if (this.isDisabled()) return { coverUrl: null, trackUrl: null, previewUrl: null, durationMs: 0, resolvedArtist: null, resolvedTrack: null, albumName: null };

        const cacheKey = `sp:info:tr:${artistName.toLowerCase()}:${trackName.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 604800, async () => {
            try {
                const token = await this.getToken();
                const cleanQuery = `${artistName} ${trackName}`.replace(/[^\w\s]/g, '');

                // Try Raw search first (more reliable for bands with spaces)
                const { data } = await axios.get('https://api.spotify.com/v1/search', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        q: cleanQuery,
                        type: 'track',
                        limit: 5,
                    },
                });

                const tracks = data.tracks?.items || [];
                const overrideId = ArtistMetadataService.getSpotifyId(artistName);

                const track = tracks.find((t: any) => {
                    const titleMatch = this.validateTitle(trackName, t.name);
                    const artistMatch = t.artists?.some((a: any) => {
                        if (overrideId) return a.id === overrideId;
                        return this.validateArtist(artistName, a.name);
                    });
                    return titleMatch && artistMatch;
                });

                // Fallback to raw search if strict search failed
                if (!track) {
                    const { data: rawData } = await axios.get('https://api.spotify.com/v1/search', {
                        headers: { Authorization: `Bearer ${token}` },
                        params: {
                            q: `${artistName} ${trackName}`,
                            type: 'track',
                            limit: 1,
                        },
                    });
                    const rawTrack = rawData.tracks?.items?.[0];
                    if (rawTrack && this.validateArtist(artistName, rawTrack.artists[0].name)) {
                        return {
                            coverUrl: rawTrack.album?.images?.[0]?.url || null,
                            trackUrl: rawTrack.external_urls?.spotify || null,
                            previewUrl: rawTrack.preview_url || null,
                            durationMs: rawTrack.duration_ms || 0,
                            resolvedArtist: rawTrack.artists[0].name,
                            resolvedTrack: rawTrack.name,
                            albumName: rawTrack.album?.name || null,
                        };
                    }
                }

                if (!track) return { coverUrl: null, trackUrl: null, previewUrl: null, durationMs: 0, resolvedArtist: null, resolvedTrack: null, albumName: null };

                return {
                    coverUrl: track?.album?.images?.[0]?.url || null,
                    trackUrl: track?.external_urls?.spotify || null,
                    previewUrl: track?.preview_url || null,
                    durationMs: track?.duration_ms || 0,
                    resolvedArtist: track?.artists?.[0]?.name || null,
                    resolvedTrack: track?.name || null,
                    albumName: track?.album?.name || null,
                };
            } catch (err: any) {
                this.handleApiError(err);
                return { coverUrl: null, trackUrl: null, previewUrl: null, durationMs: 0, resolvedArtist: null, resolvedTrack: null, albumName: null };
            }
        });
    }

    /** Find a track using a loose raw text search query (like "cry by cigs after sex") and return exact metadata */
    static async searchRaw(query: string): Promise<{ name: string; artist: string } | null> {
        if (this.isDisabled()) return null;

        const cacheKey = `sp:raw:${query.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 604800, async () => {
            try {
                const token = await this.getToken();
                const { data } = await axios.get('https://api.spotify.com/v1/search', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        q: query,
                        type: 'track',
                        limit: 1,
                    },
                });

                const track = data.tracks?.items?.[0];
                if (track && track.name && track.artists?.[0]?.name) {
                    return { name: track.name, artist: track.artists[0].name };
                }
                return null;
            } catch (err: any) {
                this.handleApiError(err);
                return null;
            }
        });
    }

    /** Get album metadata (cover, Spotify URL) */
    static async getAlbumInfo(albumName: string, artistName: string): Promise<{ coverUrl: string | null; albumUrl: string | null }> {
        if (this.isDisabled()) return { coverUrl: null, albumUrl: null };

        const cacheKey = `sp:info:al:${artistName.toLowerCase()}:${albumName.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 604800, async () => {
            try {
                const token = await this.getToken();

                const { data } = await axios.get('https://api.spotify.com/v1/search', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        q: `"${albumName}" "${artistName}"`,
                        type: 'album',
                        limit: 1,
                    },
                });

                const albums = data.albums?.items || [];
                const album = albums.find((a: any) =>
                    this.validateTitle(albumName, a.name) &&
                    a.artists?.some((artist: any) => this.validateArtist(artistName, artist.name))
                );

                return {
                    coverUrl: album?.images?.[0]?.url || null,
                    albumUrl: album?.external_urls?.spotify || null,
                };
            } catch (err: any) {
                this.handleApiError(err);
                return { coverUrl: null, albumUrl: null };
            }
        });
    }

    /** Get album metadata (type, release year) from Spotify — used for chart filtering */
    static async getAlbumMetadata(albumName: string, artistName: string): Promise<{
        coverUrl: string | null;
        albumType: string | null;
        releaseYear: number | null;
    }> {
        if (this.isDisabled()) return { coverUrl: null, albumType: null, releaseYear: null };

        const cacheKey = `sp:meta:al:v11:${artistName.toLowerCase()}:${albumName.toLowerCase()}`;
        return CacheService.wrap(cacheKey, 604800, async () => {
            try {
                const token = await this.getToken();

                // 1. Strict Search
                let res = await axios.get('https://api.spotify.com/v1/search', {
                    headers: { Authorization: `Bearer ${token}` },
                    params: {
                        q: `album:"${albumName}" artist:"${artistName}"`,
                        type: 'album',
                        limit: 5,
                    },
                });

                let albums = res.data.albums?.items || [];
                let album = albums.find((a: any) =>
                    this.validateTitle(albumName, a.name) &&
                    a.artists?.some((artist: any) => this.validateArtist(artistName, artist.name))
                );

                // 2. Looser Fallback Search
                if (!album) {
                    res = await axios.get('https://api.spotify.com/v1/search', {
                        headers: { Authorization: `Bearer ${token}` },
                        params: {
                            q: `"${albumName}" "${artistName}"`,
                            type: 'album',
                            limit: 5,
                        },
                    });
                    albums = res.data.albums?.items || [];
                    album = albums.find((a: any) =>
                        this.validateTitle(albumName, a.name) &&
                        a.artists?.some((artist: any) => this.validateArtist(artistName, artist.name))
                    );
                }

                return {
                    coverUrl: album?.images?.[0]?.url || null,
                    albumType: album?.album_type || null,
                    releaseYear: album?.release_date ? parseInt(album.release_date.substring(0, 4)) : null,
                };
            } catch (err: any) {
                this.handleApiError(err);
                return { coverUrl: null, albumType: null, releaseYear: null };
            }
        });
    }

    /** Get track metadata by Spotify ID */
    static async getTrackMetadataById(trackId: string): Promise<{ name: string; artist: string } | null> {
        if (this.isDisabled()) return null;

        try {
            const token = await this.getToken();

            const { data } = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (data.name && data.artists?.length > 0) {
                return {
                    name: data.name,
                    artist: data.artists[0].name
                };
            }
            return null;
        } catch (err: any) {
            this.handleApiError(err);
            return null;
        }
    }

    /** Get tracks from a Spotify album */
    static async getAlbumTracks(albumId: string): Promise<{ name: string; artist: string }[]> {
        if (this.isDisabled()) return [];

        try {
            const token = await this.getToken();
            const { data } = await axios.get(`https://api.spotify.com/v1/albums/${albumId}/tracks`, {
                headers: { Authorization: `Bearer ${token}` },
                params: { limit: 50 } // Fetch up to 50 tracks for now
            });

            return (data.items || []).map((t: any) => ({
                name: t.name,
                artist: t.artists?.[0]?.name || 'Unknown Artist'
            }));
        } catch (err: any) {
            this.handleApiError(err);
            return [];
        }
    }

    /** Get album metadata by Spotify ID */
    static async getAlbumMetadataById(albumId: string): Promise<{ name: string; artist: string } | null> {
        if (this.isDisabled()) return null;

        try {
            const token = await this.getToken();
            const { data } = await axios.get(`https://api.spotify.com/v1/albums/${albumId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (data.name && data.artists?.length > 0) {
                return {
                    name: data.name,
                    artist: data.artists[0].name
                };
            }
            return null;
        } catch (err: any) {
            this.handleApiError(err);
            return null;
        }
    }

    /** Get artist metadata by Spotify ID */
    static async getArtistMetadataById(artistId: string): Promise<{ name: string; artist: string } | null> {
        if (this.isDisabled()) return null;

        try {
            const token = await this.getToken();
            const { data } = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (data.name) {
                return {
                    name: '', // Artists don't have a track name
                    artist: data.name
                };
            }
            return null;
        } catch (err: any) {
            this.handleApiError(err);
            return null;
        }
    }

    /** Get tracks from a Spotify playlist */
    static async getPlaylistTracks(playlistId: string): Promise<{ name: string; artist: string }[]> {
        if (this.isDisabled()) return [];

        try {
            const token = await this.getToken();
            // Note: We're using fields to reduce the payload size
            const { data } = await axios.get(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
                headers: { Authorization: `Bearer ${token}` },
                params: { 
                    limit: 100,
                    fields: 'items(track(name,artists(name)))'
                }
            });

            return (data.items || [])
                .filter((i: any) => i.track)
                .map((i: any) => ({
                    name: i.track.name,
                    artist: i.track.artists?.[0]?.name || 'Unknown Artist'
                }));
        } catch (err: any) {
            this.handleApiError(err);
            return [];
        }
    }

    /**
     * Get radio recommendations powered by Spotify.
     * NOTE: Spotify's recommendation-capable endpoints (related-artists, recommendations, genre search)
     * all require Extended Quota Mode which our app doesn't have.
     * Only basic track/artist search works. This method is a no-op until we have extended access.
     * The radio command falls back to the library-based engine which handles niche artists correctly.
     */
    static async getRadioRecommendations(
        _trackName: string,
        _artistName: string
    ): Promise<{ name: string; artist: string }[]> {
        return [];
    }
}
