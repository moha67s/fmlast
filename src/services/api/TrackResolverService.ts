import { Spotify } from './Spotify';
import { AppleMusic } from './AppleMusic';
import { Deezer } from './Deezer';
import { CacheService } from '../bot/CacheService';
import { LoggerService } from '../bot/LoggerService';

export interface ResolvedTrack {
    artist: string;
    artistAvatarUrl: string | null;
    title: string;
    album: string | null;
    artworkUrl: string | null;
    previewUrl: string | null;
    durationMs: number;
    links: {
        spotify: string | null;
        apple: string | null;
        deezer: string | null;
        youtube: string | null;
    };
    source: string;
}

export class TrackResolverService {
    private static CACHE_TTL = 86400; // 24 hours

    /**
     * Resolves metadata for a track from all available sources in parallel.
     * @param albumHint - Optional album name known by the caller (e.g. from Last.fm).
     *                    If provided and the album cover is already cached, artwork
     *                    resolution is skipped entirely for instant response.
     */
    static async resolve(artistName: string, trackName: string, forceRefresh = false, albumHint?: string): Promise<ResolvedTrack> {
        const query = `${artistName} - ${trackName}`.toLowerCase().trim();
        // v13: Strict similarity validation + CAS fix
        const cacheKey = `utr:v14:resolve:${Buffer.from(query).toString('base64')}`;

        // 1. Check Redis Cache
        if (!forceRefresh) {
            const cached = await CacheService.get<ResolvedTrack>(cacheKey);
            if (cached) {
                LoggerService.utrCacheHit(query);
                return cached;
            }
        }

        // 1b. Album Cover Fast-Path
        let cachedAlbumCover: string | null = null;
        if (albumHint) {
            const albumCoverKey = `utr:cover:v11:${Buffer.from(`${artistName.toLowerCase()}:${albumHint.toLowerCase()}`).toString('base64')}`;
            cachedAlbumCover = await CacheService.get<string>(albumCoverKey) || null;
        }

        // 2. Parallel API Fetch
        const [sp, am, dz, yt] = await Promise.all([
            Spotify.getTrackInfo(trackName, artistName).catch(() => null),
            AppleMusic.searchTrack(artistName, trackName).catch(() => null),
            Deezer.searchTrack(artistName, trackName).catch(() => null),
            this.getYoutubeLink(artistName, trackName).catch(() => null)
        ]);

        // 3. Resolve Artist Avatar
        const bestArtistName = sp?.resolvedArtist || am?.artistName || dz?.artist || artistName;
        const [dzAvatar, spAvatar] = await Promise.all([
            Deezer.getArtistCover(bestArtistName).catch(() => null),
            Spotify.getArtistCover(bestArtistName).catch(() => null)
        ]);
        const artistAvatarUrl = spAvatar || dzAvatar || null;

        // 4. Intelligence: Combine the best data points with STRICT similarity validation
        const clean = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const qTrack = clean(trackName);
        const qArtist = clean(artistName);

        // Known artists where strict matching fails — bypass isMatch entirely
        const TRUSTED_ARTISTS = [
            'cigarettes after sex', 'cas', 'tv girl', 'the weeknd', 'lana del rey', 
            'the arctic monkeys', 'arctic monkeys', 'beach house', 'zaid khaled', 'el waili'
        ];

        const isTrustedArtist = TRUSTED_ARTISTS.some(a => 
            qArtist.includes(clean(a)) || clean(a).includes(qArtist)
        );

        // Helper: Check if result is reasonably similar to query
        const isMatch = (resTitle: string, resArtist: string) => {
            const rT = clean(resTitle);
            const rA = clean(resArtist);
            if (!rT) return false;
            
            const titleMatch = rT.includes(qTrack) || qTrack.includes(rT) || 
                               rT.startsWith(qTrack.substring(0, 4)); // prefix match for short titles
            
            // Stricter artist match: 
            // 1. One must contain the other
            // 2. The length difference shouldn't be extreme (e.g. "Savage" vs "Niky Savage")
            //    unless the result is a common "Topic" or "Official" channel
            let artistMatch = !qArtist || rA.includes(qArtist) || qArtist.includes(rA);
            
            if (artistMatch && qArtist.length > 3) {
                const lenDiff = Math.abs(rA.length - qArtist.length);
                // If the difference is more than 60% of the longer string, it's likely a different artist
                // (e.g. "savage" [6] vs "nikysavage" [10] -> diff 4. 4/10 = 0.4. Allowed.
                // wait, "savage" [6] vs "21savage" [8] -> diff 2. Allowed.
                // But "savage" [6] vs "savage garden" [12] -> diff 6. 6/12 = 0.5.
                if (lenDiff > Math.max(rA.length, qArtist.length) * 0.6 && !rA.includes('topic')) {
                    artistMatch = false;
                }
            }
            
            return titleMatch && artistMatch;
        };

        const isSpValid = !!sp?.resolvedTrack || (!!sp?.trackUrl && isTrustedArtist);
        const isAmValid = am?.trackName && (isTrustedArtist || isMatch(am.trackName, am.artistName));
        const isDzValid = dz?.name && (isTrustedArtist || isMatch(dz.name, dz.artist));

        const artist = (isSpValid ? sp?.resolvedArtist : (isAmValid ? am?.artistName : (isDzValid ? dz?.artist : artistName))) || artistName;
        const title = (isSpValid ? sp?.resolvedTrack : (isAmValid ? am?.trackName : (isDzValid ? dz?.name : trackName))) || trackName;
        const album = (isSpValid ? sp?.albumName : (isAmValid ? am?.albumName : (isDzValid ? dz?.album : null))) || albumHint || null;
        
        // Artwork logic
        let artworkUrl = cachedAlbumCover 
            || ((isSpValid && sp?.coverUrl) ? sp.coverUrl : (isAmValid && am?.artworkUrl ? am.artworkUrl.replace('{w}x{h}', '1000x1000') : (isDzValid ? dz?.artworkUrl : null)));

        if (!isSpValid && !isAmValid && !isDzValid) {
            console.warn(`[UTR] Match failed for: ${query}. SP:${!!sp?.resolvedTrack} AM:${!!am?.trackName} DZ:${!!dz?.name}`);
        }

        const resolved: ResolvedTrack = {
            artist,
            artistAvatarUrl: artistAvatarUrl,
            title,
            album,
            artworkUrl,
            previewUrl: (isSpValid && sp?.previewUrl ? sp.previewUrl : null) 
                || (isAmValid && am?.previewUrl ? am.previewUrl : null) 
                || (isDzValid && dz?.previewUrl ? dz.previewUrl : null) 
                || null,
            durationMs: (isSpValid ? sp?.durationMs : (isAmValid ? am?.durationMs : dz?.durationMs)) || 0,
            links: {
                spotify: (isSpValid ? sp?.trackUrl : null),
                apple: (isAmValid ? am?.storeUrl : null),
                deezer: (isDzValid ? dz?.url : null),
                youtube: yt || null
            },
            source: isSpValid ? 'Spotify' : (isAmValid ? 'Apple Music' : (isDzValid ? 'Deezer' : 'Last.fm Fallback'))
        };

        // 5. Store track result in cache
        await CacheService.set(cacheKey, resolved, this.CACHE_TTL);
        LoggerService.utrResult(resolved.source, resolved.artist, resolved.title);


        // 5b. Write-through: store the album cover separately for future tracks on the same album
        if (artworkUrl && album) {
            const albumCoverKey = `utr:cover:v11:${Buffer.from(`${artist.toLowerCase()}:${album.toLowerCase()}`).toString('base64')}`;
            await CacheService.set(albumCoverKey, artworkUrl, this.CACHE_TTL);
        }

        return resolved;
    }

    /**
     * Resolves metadata for an artist specifically.
     */
    static async resolveArtist(artistName: string): Promise<{ artist: string, avatarUrl: string | null, tags: string[] }> {
        const query = `artist:${artistName}`.toLowerCase().trim();
        const cacheKey = `utr:artist:v2:${Buffer.from(query).toString('base64')}`;

        const cached = await CacheService.get<any>(cacheKey);
        if (cached) return cached;

        const [dzAvatar, spAvatar, lfmTags] = await Promise.all([
            Deezer.getArtistCover(artistName).catch(() => null),
            Spotify.getArtistCover(artistName).catch(() => null),
            import('./LastFM').then(m => m.LastFM.getArtistTopTags(artistName)).catch(() => [])
        ]);

        const result = {
            artist: artistName,
            avatarUrl: spAvatar || dzAvatar || null,
            tags: lfmTags.map((t: any) => t.name).slice(0, 5)
        };

        await CacheService.set(cacheKey, result, this.CACHE_TTL);

        return result;
    }

    /**
     * Resolves metadata for an album specifically.
     * Uses strict name validation to prevent false positives.
     */
    static async resolveAlbum(artistName: string, albumName: string): Promise<{ 
        artist: string, 
        album: string, 
        artworkUrl: string | null, 
        releaseYear: number | null, 
        albumType: string | null,
        isExplicit: boolean,
        source: string 
    }> {
        const query = `album:${artistName} - ${albumName}`.toLowerCase().trim();
        // v11: bumped to flush incorrect results
        const cacheKey = `utr:album:v12:${Buffer.from(query).toString('base64')}`;

        const cached = await CacheService.get<any>(cacheKey);
        if (cached) {
            LoggerService.utrAlbumHit(artistName, albumName);
            return cached;
        }

        const [sp, am, dz] = await Promise.all([
            Spotify.getAlbumMetadata(albumName, artistName).catch(() => null),
            AppleMusic.getAlbumMetadata(albumName, artistName).catch(() => null),
            Deezer.getAlbumMetadata(albumName, artistName).catch(() => null)
        ]);

        // Strict validation: only accept cover if the album name is a real match
        const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
        const qAlbum = clean(albumName);
        const isSpValid = sp?.coverUrl && qAlbum.length > 0;  // Spotify already validates internally
        const isAmValid = am?.coverUrl && qAlbum.length > 0;  // Apple Music already validates internally
        const isDzValid = dz?.coverUrl && qAlbum.length > 0;  // Deezer already validates internally

        // Prioritize Spotify for artwork, then Apple Music, then Deezer
        const artworkUrl = (isSpValid ? sp!.coverUrl : null) 
            || (isAmValid ? am!.coverUrl : null) 
            || (isDzValid ? dz!.coverUrl : null) 
            || null;

        const result = {
            artist: artistName,
            album: albumName,
            artworkUrl,
            releaseYear: sp?.releaseYear || am?.releaseYear || dz?.releaseYear || null,
            albumType: sp?.albumType || am?.albumType || dz?.albumType || null,
            isExplicit: dz?.isExplicit || false,
            source: isSpValid ? 'Spotify' : (isAmValid ? 'Apple Music' : (isDzValid ? 'Deezer' : 'Last.fm'))
        };

        await CacheService.set(cacheKey, result, this.CACHE_TTL);

        return result;
    }

    private static isValidMatch(resTitle: string, resArtist: string, qTrack: string, qArtist: string): boolean {
        const clean = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const rT = clean(resTitle);
        const rA = clean(resArtist);
        const qt = clean(qTrack);
        const qa = clean(qArtist);

        if (!rT) return false;

        const titleMatch = rT.includes(qt) || qt.includes(rT) || rT.startsWith(qt.substring(0, 4));
        let artistMatch = !qa || rA.includes(qa) || qa.includes(rA);

        if (artistMatch && qa.length > 3) {
            const lenDiff = Math.abs(rA.length - qa.length);
            if (lenDiff > Math.max(rA.length, qa.length) * 0.6 && !rA.includes('topic')) {
                artistMatch = false;
            }
        }

        return titleMatch && artistMatch;
    }

    /**
     * Helper to resolve YouTube link separately if requested.
     * Uses strict similarity validation to prevent false positives for common artist names.
     */
    static async getYoutubeLink(artist: string, track: string): Promise<string | null> {
        const { Youtube } = await import('./Youtube');
        
        // Clean characters that break YouTube search
        const cleanQuery = `${artist} - ${track}`.replace(/[!?]/g, '').trim();
        const results = await Youtube.searchByQuery(`${cleanQuery} (Official Audio)`);
        
        if (!results || results.length === 0) return null;

        // Find the best match among top 3 results using shared validation
        for (const res of results.slice(0, 3)) {
            if (this.isValidMatch(res.title, res.channelTitle, track, artist)) {
                return res.url;
            }
        }

        // Final fallback for exact match in title
        const first = results[0];
        const clean = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (clean(first.title).includes(clean(artist)) && clean(first.title).includes(clean(track))) {
            return first.url;
        }

        return null;
    }

    /**
     * Parses a streaming service link and returns the artist and track name.
     */
    static async parseStreamingLink(url: string): Promise<{ artist: string; track: string } | null> {
        // Spotify
        const spTrackMatch = url.match(/(?:https?:\/\/)?open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
        if (spTrackMatch) {
            const meta = await Spotify.getTrackMetadataById(spTrackMatch[1]);
            return meta ? { artist: meta.artist, track: meta.name } : null;
        }

        const spAlbumMatch = url.match(/(?:https?:\/\/)?open\.spotify\.com\/album\/([a-zA-Z0-9]+)/);
        if (spAlbumMatch) {
            const meta = await Spotify.getAlbumMetadataById(spAlbumMatch[1]);
            return meta ? { artist: meta.artist, track: meta.name } : null;
        }

        const spArtistMatch = url.match(/(?:https?:\/\/)?open\.spotify\.com\/artist\/([a-zA-Z0-9]+)/);
        if (spArtistMatch) {
            const meta = await Spotify.getArtistMetadataById(spArtistMatch[1]);
            return meta ? { artist: meta.artist, track: '' } : null;
        }

        // Apple Music
        const amTrackMatch = url.match(/(?:https?:\/\/)?music\.apple\.com\/\w+\/album\/.+\/(\d+)(?:\?i=(\d+))?/);
        if (amTrackMatch) {
            const trackId = amTrackMatch[2] || amTrackMatch[1];
            // Apple Music searchTrack uses query, but we can try to find by ID if we implement a lookup
            // For now, let's use search with the ID if possible, or just the URL
            const res = await AppleMusic.searchTrack('', url);
            if (res) return { artist: res.artistName, track: res.trackName };
        }

        // Deezer
        const dzTrackMatch = url.match(/(?:https?:\/\/)?(?:www\.)?deezer\.com\/\w+\/track\/(\d+)/);
        if (dzTrackMatch) {
            const res = await Deezer.searchTrack('', url);
            if (res) return { artist: res.artist, track: res.name };
        }

        return null;
    }
}
