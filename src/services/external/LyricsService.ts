import axios from 'axios';
import { Client as GeniusClient } from 'genius-lyrics';
import { config } from '../../../config';
import { ArtistMetadataService } from './ArtistMetadataService';

const genius = new GeniusClient(config.GENIUS_ACCESS_TOKEN);
export { genius };

export interface LyricResult {
    lines: string[];
    source: string;
}

export const lyricCache = new Map<string, { 
    lines: string[], 
    source: string, 
    timestamp: number 
}>();

export class LyricsService {
    /** Check if text contains Arabic characters */
    static isArabic(text: string): boolean {
        const arabicPattern = /[\u0600-\u06FF]/;
        return arabicPattern.test(text);
    }

    /** 
     * Helper for scraping with browser-like headers
     */
    private static async stealthGet(url: string) {
        return axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0'
            },
            timeout: 8000
        });
    }

    /** Fetch lyrics lines from multiple sources (Lrclib, Genius, regional mirrors) */
    static async fetchLyrics(artist: string, track: string, originalArtist?: string, originalTrack?: string, geniusId?: number): Promise<LyricResult> {
        const cacheKey = `${artist.toLowerCase()}|${track.toLowerCase()}`;
        const cached = lyricCache.get(cacheKey);
        if (cached && cached.lines.length > 0 && Date.now() - cached.timestamp < 1000 * 60 * 60) {
            return { lines: cached.lines, source: cached.source };
        }

        let plainLyrics = '';
        let source = '';

        let geniusSongId: number | undefined = undefined;
        let geniusArtistId: number | undefined = undefined;

        // Check track-specific override first
        geniusSongId = ArtistMetadataService.getGeniusTrackId(artist, track) || undefined;
        
        // If no track override, check for artist override
        if (!geniusSongId) {
            const overrideArtistId = ArtistMetadataService.getGeniusArtistId(artist);
            if (overrideArtistId) {
                geniusArtistId = overrideArtistId;
            }
        }

        // 0.1 Try Exact Song ID (Most accurate)
        if (geniusSongId) {
            try {
                const song = await genius.songs.get(geniusSongId);
                plainLyrics = await song.lyrics();
                if (plainLyrics) source = 'Genius (Exact)';
            } catch { }
        }

        // 0.2 Try Artist ID (Fetch artist's songs and find the track)
        if (!plainLyrics && geniusArtistId) {
            try {
                const gArtist = await genius.artists.get(geniusArtistId);
                const songs = await gArtist.songs({ perPage: 50 });
                
                const cleanTrack = (track || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/gi, '');
                
                // Try exact match first
                let targetSong = songs.find(s => s.title.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/gi, '') === cleanTrack);
                
                // Fallback to partial match
                if (!targetSong) {
                    targetSong = songs.find(s => {
                        const title = s.title.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/gi, '');
                        return title.includes(cleanTrack) || cleanTrack.includes(title);
                    });
                }

                if (targetSong) {
                    plainLyrics = await targetSong.lyrics();
                    if (plainLyrics) source = 'Genius (Artist Profile)';
                }
            } catch { }
        }

        const cleanText = (t: string) => (t || '').toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]/gi, '');

        // 1. Try LRCLIB (Direct Get)
        if (!plainLyrics) {
            try {
                const r = await axios.get('https://lrclib.net/api/get', {
                    params: { artist_name: artist, track_name: track },
                    timeout: 4000
                });
                if (r.data?.plainLyrics) {
                    plainLyrics = r.data.plainLyrics;
                    source = 'LRCLIB';
                }
            } catch { }
        }

        // 2. Try Genius
        if (!plainLyrics) {
            try {
                const searches = await genius.songs.search(`${track} ${artist}`);
                if (searches.length > 0) {
                    const song = searches[0];
                    plainLyrics = await song.lyrics() || '';
                    if (plainLyrics) source = 'Genius';
                }
            } catch { }
        }

        // 3. Fallback to regional mirrors (L-Hit)
        if (!plainLyrics) {
            try {
                const searchUrl = `https://l-hit.com/en/search.php?q=${encodeURIComponent(`${artist} ${track}`)}`;
                const searchResp = await this.stealthGet(searchUrl);
                const linkMatch = searchResp.data.match(/<a href="(https:\/\/l-hit\.com\/[a-z]{2}\/\d+)">/i);
                if (linkMatch && linkMatch[1]) {
                    const lyricsResp = await this.stealthGet(linkMatch[1]);
                    const lyricsMatch = lyricsResp.data.match(/<div class="lyrics">([\s\S]*?)<\/div>/i);
                    if (lyricsMatch && lyricsMatch[1]) {
                        plainLyrics = lyricsMatch[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
                        if (plainLyrics) source = 'L-Hit';
                    }
                }
            } catch { }
        }

        // 4. ULTIMATE FALLBACK: DuckDuckGo Scraper
        if (!plainLyrics) {
            try {
                const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${artist} ${track} lyrics كلمات`)}`;
                const ddgResp = await this.stealthGet(ddgUrl);
                const snippets = ddgResp.data.match(/<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/gi);
                if (snippets) {
                    for (const snip of snippets) {
                        const text = snip.replace(/<[^>]+>/g, '').trim();
                        if ((this.isArabic(text) || text.length > 50) && !text.includes('DuckDuckGo')) {
                            plainLyrics = text;
                            source = 'DuckDuckGo';
                            break;
                        }
                    }
                }
            } catch { }
        }

        if (!plainLyrics) return { lines: [], source: '' };

        // Clean and filter lines
        const lines = plainLyrics.split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 1 && !l.startsWith('[') && !l.endsWith(']') && !l.startsWith('(') && !l.endsWith(')'));

        lyricCache.set(cacheKey, { lines, source, timestamp: Date.now() });
        
        // Caching cleanup
        if (lyricCache.size > 500) {
            const oldestKey = Array.from(lyricCache.keys())[0];
            lyricCache.delete(oldestKey);
        }

        return { lines, source };
    }

    /**
     * Pick a good snippet for a game.
     * Tries to find segments that aren't too short or just repeated lines.
     */
    static getGameSnippet(lines: string[], length = 3): string[] {
        if (lines.length < length) return lines;

        // Try to pick a snippet from the middle of the song (avoid intro/outro)
        const startOffset = Math.floor(lines.length * 0.2);
        const endOffset = Math.floor(lines.length * 0.8) - length;
        
        const safeStart = Math.max(0, startOffset);
        const safeEnd = Math.max(safeStart, endOffset);
        
        const randomIndex = Math.floor(Math.random() * (safeEnd - safeStart + 1)) + safeStart;
        return lines.slice(randomIndex, randomIndex + length);
    }

    /**
     * Fetch full lyrics by Genius Song ID
     */
    static async fetchFullLyricsById(geniusId: string): Promise<string | null> {
        try {
            const song = await genius.songs.get(parseInt(geniusId));
            return await song.lyrics();
        } catch {
            return null;
        }
    }
}
