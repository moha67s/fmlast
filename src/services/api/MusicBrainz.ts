import axios from 'axios';

/**
 * MusicBrainz API Service — Enhanced version.
 *
 * Mirrors the original C# MusicBrainzService.cs:
 * - Searches for artist by name with exact case-insensitive match
 * - Fetches full metadata: origin, country code, type, gender, disambiguation
 * - Looks up URL relationships to find Spotify, Twitter, Instagram, etc. links
 * - Respects MusicBrainz rate limits (1 req/sec with proper User-Agent)
 */

export interface ArtistMetadata {
    mbid: string;
    origin: string;
    countryCode: string | null;
    activeSince: string | null;
    endDate: string | null;
    type: string;
    gender: string | null;
    disambiguation: string | null;
}

export interface ArtistLink {
    type: string;       // e.g. "spotify", "twitter", "instagram", "youtube"
    url: string;
    username?: string;  // extracted handle/slug from URL
}

export interface ArtistFullInfo {
    metadata: ArtistMetadata;
    links: ArtistLink[];
}

export class MusicBrainz {
    private static ROOT = 'https://musicbrainz.org/ws/2/';
    private static USER_AGENT = 'FMBot-TS/1.0.0 ( https://github.com/fmbot )';
    private static lastRequestTime = 0;

    /**
     * Rate-limit to 1 request per second as required by MusicBrainz.
     */
    private static async rateLimit(): Promise<void> {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < 1100) {
            await new Promise(r => setTimeout(r, 1100 - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * Get basic artist info (backward-compatible with existing callers).
     */
    static async getArtistInfo(artistName: string): Promise<{ origin: string; activeSince: string; type: string } | null> {
        try {
            const full = await this.getArtistFullInfo(artistName);
            if (!full) return null;
            return {
                origin: full.metadata.origin,
                activeSince: full.metadata.activeSince || 'Unknown',
                type: full.metadata.type,
            };
        } catch (err) {
            console.error('[MusicBrainz] Error fetching artist info:', err);
            return null;
        }
    }

    /**
     * Get full artist metadata + external links.
     * Mirrors C# AddMusicBrainzDataToArtistAsync — two API calls:
     *   1. Search for artist by name
     *   2. Lookup the matched artist with URL relationships
     */
    static async getArtistFullInfo(artistName: string): Promise<ArtistFullInfo | null> {
        try {
            // Step 1: Search for the artist
            await this.rateLimit();
            const searchRes = await axios.get(`${this.ROOT}artist/`, {
                params: { query: `artist:"${artistName}"`, fmt: 'json', limit: '5' },
                headers: { 'User-Agent': this.USER_AGENT },
            });

            const artists = searchRes.data.artists || [];
            // Find exact case-insensitive match (like the C# version)
            const match = artists.find((a: any) =>
                a.name && a.name.toLowerCase() === artistName.toLowerCase()
            ) || artists[0];

            if (!match) return null;

            // Step 2: Lookup with URL relationships
            await this.rateLimit();
            const lookupRes = await axios.get(`${this.ROOT}artist/${match.id}`, {
                params: { fmt: 'json', inc: 'url-rels' },
                headers: { 'User-Agent': this.USER_AGENT },
            });

            const artist = lookupRes.data;

            // Parse country code (mirrors C# GetArtistCountryCode)
            let countryCode = artist.country || null;
            if (!countryCode) {
                const isoCode = artist.area?.['iso-3166-2-codes']?.[0]
                    || artist.area?.['iso-3166-1-codes']?.[0]
                    || artist['begin-area']?.['iso-3166-2-codes']?.[0]
                    || artist['begin-area']?.['iso-3166-1-codes']?.[0];
                if (isoCode) {
                    countryCode = isoCode.includes('-') ? isoCode.split('-')[0] : isoCode;
                }
            }

            // Parse dates with safety
            let startDate = artist['life-span']?.begin || null;
            let endDate = artist['life-span']?.end || null;

            // Filter ancient dates like the C# version
            if (startDate && new Date(startDate).getFullYear() <= 1800) startDate = null;
            if (endDate && new Date(endDate).getFullYear() <= 1900) endDate = null;

            const metadata: ArtistMetadata = {
                mbid: artist.id,
                origin: artist.area?.name || artist['begin-area']?.name || 'Unknown',
                countryCode,
                activeSince: startDate,
                endDate,
                type: artist.type || 'Unknown',
                gender: artist.gender || null,
                disambiguation: artist.disambiguation || null,
            };

            // Parse URL relationships (mirrors C# RelationshipToLinkTypeAndUsername)
            const links: ArtistLink[] = [];
            const relations = artist.relations || [];

            for (const rel of relations) {
                const url = rel.url?.resource;
                if (!url) continue;

                const parsed = this.parseRelationship(rel.type, url);
                if (parsed) links.push(parsed);
            }

            return { metadata, links };
        } catch (err) {
            console.error('[MusicBrainz] Error in getArtistFullInfo:', err);
            return null;
        }
    }

    /**
     * Parse a MusicBrainz relationship into a typed ArtistLink.
     * Mirrors the C# RelationshipToLinkTypeAndUsername switch statement.
     */
    private static parseRelationship(relType: string, url: string): ArtistLink | null {
        const cleanUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const lastSlash = cleanUrl.lastIndexOf('/');
        const username = lastSlash !== -1 ? cleanUrl.slice(lastSlash + 1) : undefined;
        const lowerUrl = url.toLowerCase();

        switch (relType) {
            case 'free streaming':
                if (lowerUrl.includes('spotify'))   return { type: 'spotify', url, username };
                if (lowerUrl.includes('deezer'))    return { type: 'deezer', url, username };
                break;
            case 'streaming':
                if (lowerUrl.includes('tidal'))           return { type: 'tidal', url, username };
                if (lowerUrl.includes('music.apple.com')) return { type: 'apple_music', url, username };
                break;
            case 'social network':
                if (lowerUrl.includes('facebook.com'))  return { type: 'facebook', url, username };
                if (lowerUrl.includes('twitter.com') || lowerUrl.includes('x.com'))
                                                        return { type: 'twitter', url, username };
                if (lowerUrl.includes('tiktok.com'))    return { type: 'tiktok', url, username };
                if (lowerUrl.includes('instagram.com')) return { type: 'instagram', url, username };
                break;
            case 'bandcamp':    return { type: 'bandcamp', url };
            case 'soundcloud':  return { type: 'soundcloud', url, username };
            case 'youtube':     return { type: 'youtube', url, username };
            case 'official homepage': return { type: 'website', url };
            case 'last.fm':     return { type: 'lastfm', url, username };
            case 'discogs':     return { type: 'discogs', url, username };
            case 'wikidata':    return { type: 'wikidata', url, username };
            case 'other databases':
                if (lowerUrl.includes('rateyourmusic')) return { type: 'rateyourmusic', url, username };
                break;
        }

        return null;
    }
}
