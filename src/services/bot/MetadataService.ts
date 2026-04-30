import { YoutubeResult } from '../api/Youtube';
import { TrackResolverService } from '../api/TrackResolverService';
import { LastFM } from '../api/LastFM';
import { GuildMember } from 'discord.js';

export class MetadataService {
    /**
     * Enriches a YoutubeResult with high-res artwork, cleaned names, and Last.fm stats.
     */
    static async enrich(track: YoutubeResult, member: GuildMember, dbUser?: any): Promise<void> {
        // Resolve High-Res Artwork and Cleaned Names
        let finalArtist = track.artistName || '';
        let finalTrack = track.trackTitle || '';

        const cleanStr = (s: string) => {
            return s
                .replace(/\(official.*?\)/gi, '')
                .replace(/\[official.*?\]/gi, '')
                .replace(/\(lyric.*?\)/gi, '')
                .replace(/\[lyric.*?\]/gi, '')
                .replace(/\(video.*?\)/gi, '')
                .replace(/\[video.*?\]/gi, '')
                .replace(/\(hd.*?\)/gi, '')
                .replace(/\[hd.*?\]/gi, '')
                .replace(/\(4k.*?\)/gi, '')
                .replace(/\[4k.*?\]/gi, '')
                .replace(/\(feat.*?\)/gi, '')
                .replace(/\[feat.*?\]/gi, '')
                .replace(/\(ft.*?\)/gi, '')
                .replace(/\[ft.*?\]/gi, '')
                .replace(/\(with.*?\)/gi, '')
                .replace(/\[with.*?\]/gi, '')
                .replace(/\(prod.*?\)/gi, '')
                .replace(/\[prod.*?\]/gi, '')
                .replace(/\(.*?\)/g, '')
                .replace(/\[.*?\]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        };

        if (!finalArtist || !finalTrack) {
            const separators = [' - ', ' – ', ' — ', ' | '];
            let found = false;
            const channelClean = track.channelTitle ? track.channelTitle.toLowerCase().replace(' - topic', '').replace(/\s+/g, '') : '';
            
            for (const sep of separators) {
                if (track.title.includes(sep)) {
                    const parts = track.title.split(sep);
                    const part0 = parts[0].trim();
                    const part1 = parts.slice(1).join(sep).trim();
                    
                    const p0Clean = part0.toLowerCase().replace(/\s+/g, '');
                    const p1Clean = part1.toLowerCase().replace(/\s+/g, '');

                    // Check if part1 matches the channel title, meaning format is "Track - Artist"
                    if (channelClean && (p1Clean.includes(channelClean) || channelClean.includes(p1Clean))) {
                        finalArtist = part1;
                        finalTrack = part0;
                    } else if (channelClean && (p0Clean.includes(channelClean) || channelClean.includes(p0Clean))) {
                        // "Artist - Track"
                        finalArtist = part0;
                        finalTrack = part1;
                    } else {
                        // Default to "Artist - Track" as fallback
                        finalArtist = part0;
                        finalTrack = part1;
                    }
                    found = true;
                    break;
                }
            }
            
            if (!found) {
                finalTrack = track.title;
                finalArtist = track.channelTitle.replace(' - Topic', '');
            }
        }

        // Apply aggressive cleaning to the final track name
        finalTrack = cleanStr(finalTrack);
        finalArtist = finalArtist.trim();

        // ── GLOBAL RESOLUTION (UTR) ──
        const resolved = await TrackResolverService.resolve(finalArtist, finalTrack);
        finalArtist = resolved.artist || finalArtist || '';
        finalTrack = resolved.title || finalTrack || '';
        
        track.artistName = finalArtist;
        track.trackTitle = finalTrack;
        
        // Priority 1: High-res track/album artwork from UTR
        // Priority 2: Artist profile picture (better than YouTube thumbnail)
        track.artworkUrl = resolved.artworkUrl || resolved.artistAvatarUrl || undefined;

        let finalDuration = track.duration;
        if (resolved.durationMs > 0) {
            const totalSeconds = Math.floor(resolved.durationMs / 1000);
            track.durationSeconds = totalSeconds;
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            finalDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
        }

        // Fetch extra stats from Last.fm
        let statsText = '';
        try {
            const lfmInfo = await LastFM.getTrackInfo(finalArtist, finalTrack, dbUser?.lastfmUsername, dbUser?.lastfmSessionKey);
            
            // Priority 3: Last.fm official album art (if UTR failed)
            if (!track.artworkUrl) {
                const lfmImage = lfmInfo?.album?.image?.find((i: any) => i.size === 'extralarge' || i.size === 'large')?.['#text'];
                if (lfmImage && !LastFM.isDefaultImage(lfmImage)) {
                    track.artworkUrl = lfmImage;
                }
            }

            const listeners = lfmInfo?.listeners ? parseInt(lfmInfo.listeners).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;
            const plays = lfmInfo?.playcount ? parseInt(lfmInfo.playcount).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;

            const parts = [];
            if (finalDuration) parts.push(finalDuration);
            if (listeners) parts.push(`${listeners} listeners`);
            if (plays) parts.push(`${plays} plays`);
            
            if (parts.length > 0) {
                statsText = `\n${parts.join(' • ')}`;
            }
        } catch (err) {
            if (finalDuration) statsText = `\n${finalDuration}`;
        }

        track.statsText = statsText;
        track.requesterName = member?.user?.displayName || track.requesterName || 'Unknown';
        if (finalDuration) track.duration = finalDuration;
    }
}
