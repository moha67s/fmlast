import { prisma } from '../../database/client';
import { CacheService } from './CacheService';

/**
 * IdResolutionService — Normalizes raw strings into global Artist/Track/Album IDs.
 * 
 * Mirrors the original C# IdResolutionService.cs logic:
 * - Deduplicates "Rhcp", "RHCP", "Red Hot Chili Peppers" (via Citext/Alias support)
 * - Returns global UUIDs for unified statistical analysis
 * - Uses Redis caching to minimize database roundtrips
 */
export class IdResolutionService {
    private static pendingArtists = new Map<string, Promise<string>>();
    private static pendingTracks = new Map<string, Promise<string>>();
    private static pendingAlbums = new Map<string, Promise<string>>();

    /**
     * Get or create a global Artist ID by name.
     */
    static async getArtistId(name: string): Promise<string> {
        if (!name) return '';
        const cleanName = name.trim();
        const key = cleanName.toLowerCase();
        
        if (this.pendingArtists.has(key)) return this.pendingArtists.get(key)!;

        const promise = (async () => {
            const cacheKey = `idres:artist:${key}`;
            return CacheService.wrap(cacheKey, 86400, async () => {
                const artist = await prisma.artist.upsert({
                    where: { name: cleanName },
                    update: {},
                    create: { name: cleanName }
                });
                return artist.id;
            });
        })();

        this.pendingArtists.set(key, promise);
        try {
            return await promise;
        } finally {
            this.pendingArtists.delete(key);
        }
    }

    /**
     * Get or create a global Track ID by artist and track name.
     */
    static async getTrackId(artistId: string, trackName: string): Promise<string> {
        if (!artistId || !trackName) return '';
        const cleanTrack = trackName.trim();
        const key = `${artistId}:${cleanTrack.toLowerCase()}`;

        if (this.pendingTracks.has(key)) return this.pendingTracks.get(key)!;

        const promise = (async () => {
            const cacheKey = `idres:track:${key}`;
            return CacheService.wrap(cacheKey, 86400, async () => {
                const track = await prisma.track.upsert({
                    where: {
                        artistId_name: {
                            artistId,
                            name: cleanTrack
                        }
                    },
                    update: {},
                    create: {
                        name: cleanTrack,
                        artistId
                    }
                });
                return track.id;
            });
        })();

        this.pendingTracks.set(key, promise);
        try {
            return await promise;
        } finally {
            this.pendingTracks.delete(key);
        }
    }

    /**
     * Get or create a global Album ID by artist and album name.
     */
    static async getAlbumId(artistId: string, albumName: string): Promise<string> {
        if (!artistId || !albumName) return '';
        const cleanAlbum = albumName.trim();
        const key = `${artistId}:${cleanAlbum.toLowerCase()}`;

        if (this.pendingAlbums.has(key)) return this.pendingAlbums.get(key)!;

        const promise = (async () => {
            const cacheKey = `idres:album:${key}`;
            return CacheService.wrap(cacheKey, 86400, async () => {
                const album = await prisma.album.upsert({
                    where: {
                        artistId_name: {
                            artistId,
                            name: cleanAlbum
                        }
                    },
                    update: {},
                    create: {
                        name: cleanAlbum,
                        artistId
                    }
                });
                return album.id;
            });
        })();

        this.pendingAlbums.set(key, promise);
        try {
            return await promise;
        } finally {
            this.pendingAlbums.delete(key);
        }
    }

    /**
     * Resolve all IDs for a batch of scrobbles efficiently.
     * Reduces network roundtrips drastically (from N queries to ~6-10 queries).
     */
    static async resolveBatch(combos: string[], l1Cache?: { 
        artists: Map<string, string>, 
        tracks: Map<string, string>, 
        albums: Map<string, string> 
    }) {
        console.log(`[IdRes] resolveBatch START — ${combos.length} unique items`);
        const results = new Map<string, { artistId: string, trackId: string, albumId: string | null }>();
        const uniqueArtists = new Set<string>();
        const comboData = combos.map(c => {
            const [a, t, al] = c.split('|||');
            uniqueArtists.add(a);
            return { combo: c, artistName: a, trackName: t, albumName: al || null };
        });

        // ── 1. ARTISTS ────────────────────────────────────────────────────────
        const artistNames = Array.from(uniqueArtists);
        const artistMap = new Map<string, string>();
        
        const missingFromL1: string[] = [];
        for (const name of artistNames) {
            const cached = l1Cache?.artists.get(name);
            if (cached) artistMap.set(name, cached);
            else missingFromL1.push(name);
        }

        if (missingFromL1.length > 0) {
            const cacheKeys = missingFromL1.map(n => `idres:artist:${n.toLowerCase()}`);
            const cachedFromL2 = await CacheService.mget<string>(cacheKeys);
            const missingArtists: string[] = [];

            missingFromL1.forEach((name, i) => {
                const val = cachedFromL2.get(cacheKeys[i]);
                if (val) {
                    artistMap.set(name, val);
                    l1Cache?.artists.set(name, val);
                } else {
                    missingArtists.push(name);
                }
            });
            console.log(`[IdRes] Artists: ${artistMap.size} found (L1/L2), ${missingArtists.length} missing`);

            if (missingArtists.length > 0) {
                console.log(`[IdRes] Fetching ${missingArtists.length} artists from DB...`);
                // Use IN clause for artists - it's fast
                const dbArtists = await prisma.artist.findMany({ where: { name: { in: missingArtists } } });
                
                if (dbArtists.length > 0) {
                    dbArtists.forEach(a => {
                        artistMap.set(a.name, a.id);
                        l1Cache?.artists.set(a.name, a.id);
                    });
                    await CacheService.mset(dbArtists.map(a => ({
                        key: `idres:artist:${a.name.toLowerCase()}`,
                        value: a.id,
                        ttl: 86400
                    })));
                }

                const stillMissingArtists = missingArtists.filter(name => !artistMap.has(name));
                if (stillMissingArtists.length > 0) {
                    console.log(`[IdRes] Creating ${stillMissingArtists.length} new artists (bulk)...`);
                    await prisma.artist.createMany({
                        data: stillMissingArtists.map(name => ({ name })),
                        skipDuplicates: true
                    });

                    const created = await prisma.artist.findMany({
                        where: { name: { in: stillMissingArtists } }
                    });

                    created.forEach(a => {
                        artistMap.set(a.name, a.id);
                        l1Cache?.artists.set(a.name, a.id);
                    });
                    await CacheService.mset(created.map(a => ({
                        key: `idres:artist:${a.name.toLowerCase()}`,
                        value: a.id,
                        ttl: 86400
                    })));
                }
            }
        }

        // ── 2. TRACKS ─────────────────────────────────────────────────────────
        const tracksToResolve = comboData.map(d => ({ artistId: artistMap.get(d.artistName)!, name: d.trackName }));
        const trackMap = new Map<string, string>(); // key: artistId:name
        
        const missingFromL1Tracks: { artistId: string, name: string }[] = [];
        for (const t of tracksToResolve) {
            const l1Key = `${t.artistId}:${t.name.toLowerCase()}`;
            const cached = l1Cache?.tracks.get(l1Key);
            if (cached) trackMap.set(l1Key, cached);
            else missingFromL1Tracks.push(t);
        }

        if (missingFromL1Tracks.length > 0) {
            const cacheKeys = missingFromL1Tracks.map(t => `idres:track:${t.artistId}:${t.name.toLowerCase()}`);
            const cachedFromL2 = await CacheService.mget<string>(cacheKeys);
            const missingTracks: { artistId: string, name: string }[] = [];

            missingFromL1Tracks.forEach((t, i) => {
                const key = `${t.artistId}:${t.name.toLowerCase()}`;
                const val = cachedFromL2.get(cacheKeys[i]);
                if (val) {
                    trackMap.set(key, val);
                    l1Cache?.tracks.set(key, val);
                } else {
                    missingTracks.push(t);
                }
            });
            console.log(`[IdRes] Tracks: ${trackMap.size} found (L1/L2), ${missingTracks.length} missing`);

            if (missingTracks.length > 0) {
                console.log(`[IdRes] Fetching ${missingTracks.length} tracks from DB (parallel OR)...`);
                
                const trackChunks = [];
                for (let i = 0; i < missingTracks.length; i += 50) {
                    trackChunks.push(missingTracks.slice(i, i + 50));
                }
                
                const trackResults = await Promise.all(
                    trackChunks.map(chunk => prisma.track.findMany({
                        where: { OR: chunk.map(t => ({ artistId: t.artistId, name: t.name })) }
                    }))
                );
                
                const dbTracks = trackResults.flat();
                if (dbTracks.length > 0) {
                    dbTracks.forEach(t => {
                        const key = `${t.artistId}:${t.name.toLowerCase()}`;
                        trackMap.set(key, t.id);
                        l1Cache?.tracks.set(key, t.id);
                    });
                    await CacheService.mset(dbTracks.map(t => ({
                        key: `idres:track:${t.artistId}:${t.name.toLowerCase()}`,
                        value: t.id,
                        ttl: 86400
                    })));
                }

                const stillMissingTracks = missingTracks.filter(t => !trackMap.has(`${t.artistId}:${t.name.toLowerCase()}`));
                if (stillMissingTracks.length > 0) {
                    console.log(`[IdRes] Creating ${stillMissingTracks.length} new tracks (bulk)...`);
                    await prisma.track.createMany({
                        data: stillMissingTracks.map(t => ({ name: t.name, artistId: t.artistId })),
                        skipDuplicates: true
                    });

                    const createdResults = await Promise.all(
                        trackChunks.map(chunk => prisma.track.findMany({
                            where: { OR: chunk.map(t => ({ artistId: t.artistId, name: t.name })) }
                        }))
                    );
                    const created = createdResults.flat();
                    
                    created.forEach(t => {
                        const key = `${t.artistId}:${t.name.toLowerCase()}`;
                        trackMap.set(key, t.id);
                        l1Cache?.tracks.set(key, t.id);
                    });
                    await CacheService.mset(created.map(t => ({
                        key: `idres:track:${t.artistId}:${t.name.toLowerCase()}`,
                        value: t.id,
                        ttl: 86400
                    })));
                }
            }
        }

        // ── 3. ALBUMS ─────────────────────────────────────────────────────────
        const albumsToResolve = comboData.filter(d => d.albumName).map(d => ({ artistId: artistMap.get(d.artistName)!, name: d.albumName! }));
        const albumMap = new Map<string, string>(); // key: artistId:name
        
        const missingFromL1Albums: { artistId: string, name: string }[] = [];
        for (const al of albumsToResolve) {
            const l1Key = `${al.artistId}:${al.name.toLowerCase()}`;
            const cached = l1Cache?.albums.get(l1Key);
            if (cached) albumMap.set(l1Key, cached);
            else missingFromL1Albums.push(al);
        }

        if (missingFromL1Albums.length > 0) {
            const cacheKeys = missingFromL1Albums.map(al => `idres:album:${al.artistId}:${al.name.toLowerCase()}`);
            const cachedFromL2 = await CacheService.mget<string>(cacheKeys);
            const missingAlbums: { artistId: string, name: string }[] = [];

            missingFromL1Albums.forEach((al, i) => {
                const key = `${al.artistId}:${al.name.toLowerCase()}`;
                const val = cachedFromL2.get(cacheKeys[i]);
                if (val) {
                    albumMap.set(key, val);
                    l1Cache?.albums.set(key, val);
                } else {
                    missingAlbums.push(al);
                }
            });
            console.log(`[IdRes] Albums: ${albumMap.size} found (L1/L2), ${missingAlbums.length} missing`);

            if (missingAlbums.length > 0) {
                console.log(`[IdRes] Fetching ${missingAlbums.length} albums from DB (parallel OR)...`);
                
                const albumChunks = [];
                for (let i = 0; i < missingAlbums.length; i += 50) {
                    albumChunks.push(missingAlbums.slice(i, i + 50));
                }
                
                const albumResults = await Promise.all(
                    albumChunks.map(chunk => prisma.album.findMany({
                        where: { OR: chunk.map(al => ({ artistId: al.artistId, name: al.name })) }
                    }))
                );
                
                const dbAlbums = albumResults.flat();
                if (dbAlbums.length > 0) {
                    dbAlbums.forEach(al => {
                        const key = `${al.artistId}:${al.name.toLowerCase()}`;
                        albumMap.set(key, al.id);
                        l1Cache?.albums.set(key, al.id);
                    });
                    await CacheService.mset(dbAlbums.map(al => ({
                        key: `idres:album:${al.artistId}:${al.name.toLowerCase()}`,
                        value: al.id,
                        ttl: 86400
                    })));
                }

                const stillMissingAlbums = missingAlbums.filter(al => !albumMap.has(`${al.artistId}:${al.name.toLowerCase()}`));
                if (stillMissingAlbums.length > 0) {
                    console.log(`[IdRes] Creating ${stillMissingAlbums.length} new albums (bulk)...`);
                    await prisma.album.createMany({
                        data: stillMissingAlbums.map(al => ({ name: al.name, artistId: al.artistId })),
                        skipDuplicates: true
                    });

                    const createdResults = await Promise.all(
                        albumChunks.map(chunk => prisma.album.findMany({
                            where: { OR: chunk.map(al => ({ artistId: al.artistId, name: al.name })) }
                        }))
                    );
                    const created = createdResults.flat();
                    
                    created.forEach(al => {
                        const key = `${al.artistId}:${al.name.toLowerCase()}`;
                        albumMap.set(key, al.id);
                        l1Cache?.albums.set(key, al.id);
                    });
                    await CacheService.mset(created.map(al => ({
                        key: `idres:album:${al.artistId}:${al.name.toLowerCase()}`,
                        value: al.id,
                        ttl: 86400
                    })));
                }
            }
        }

        // ── 4. CONSTRUCT FINAL MAP ────────────────────────────────────────────
        comboData.forEach(d => {
            const artistId = artistMap.get(d.artistName);
            if (!artistId) return;

            const trackId = trackMap.get(`${artistId}:${d.trackName.toLowerCase()}`);
            if (!trackId) return;

            const albumId = d.albumName ? albumMap.get(`${artistId}:${d.albumName.toLowerCase()}`) : null;
            
            results.set(d.combo, {
                artistId,
                trackId,
                albumId: albumId || null
            });
        });

        return results;
    }

    /**
     * Resolve all IDs for a scrobble in one go (Parallelized).
     */
    static async resolveAll(artistName: string, trackName: string, albumName?: string | null) {
        const artistId = await this.getArtistId(artistName);
        
        // Track and Album can be resolved in parallel once we have artistId
        const [trackId, albumId] = await Promise.all([
            this.getTrackId(artistId, trackName),
            albumName ? this.getAlbumId(artistId, albumName) : Promise.resolve(null)
        ]);

        return { artistId, trackId, albumId };
    }
}
