import { Spotify } from '../api/Spotify';
import { Youtube } from '../api/Youtube';
import { LastFM } from '../api/LastFM';

export interface ParsedInputResult {
    tracks: { name: string; artist: string; url?: string }[];
    collectionName: string;
}

export class InputParser {
    /**
     * Parses a raw user query string into a list of tracks to be played.
     * Handles Spotify Links, YouTube links, empty queries (Last.fm fallback), and raw text search.
     */
    static async parse(query: string, lastfmUsername?: string | null, lastfmSessionKey?: string | null): Promise<ParsedInputResult> {
        let tracks: { name: string; artist: string; url?: string }[] = [];
        let collectionName = '';

        const spotifyTrackRegex = /(?:https?:\/\/)?open\.spotify\.com\/track\/([a-zA-Z0-9]+)(?:\?.*)?/;
        const spotifyAlbumRegex = /(?:https?:\/\/)?open\.spotify\.com\/album\/([a-zA-Z0-9]+)(?:\?.*)?/;
        const spotifyPlaylistRegex = /(?:https?:\/\/)?open\.spotify\.com\/playlist\/([a-zA-Z0-9]+)(?:\?.*)?/;
        const youtubePlaylistRegex = /(?:https?:\/\/)?(?:www\.)?youtube\.com\/playlist\?list=([a-zA-Z0-9_-]+)/;

        const trackMatch = query.match(spotifyTrackRegex);
        const albumMatch = query.match(spotifyAlbumRegex);
        const playlistMatch = query.match(spotifyPlaylistRegex);
        const ytPlaylistMatch = query.match(youtubePlaylistRegex);

        if (trackMatch) {
            const meta = await Spotify.getTrackMetadataById(trackMatch[1]);
            if (meta) tracks.push(meta);
        } else if (albumMatch) {
            tracks = await Spotify.getAlbumTracks(albumMatch[1]);
            collectionName = 'Album';
        } else if (playlistMatch) {
            tracks = await Spotify.getPlaylistTracks(playlistMatch[1]);
            collectionName = 'Playlist';
        } else if (ytPlaylistMatch) {
            const playlist = await Youtube.getPlaylistInfo(query);
            tracks = playlist.songs.map((s: any) => ({ name: s.title, artist: s.channelTitle, url: s.url }));
            collectionName = `YouTube Playlist (${playlist.title})`;
        } else if (!query || query.trim() === '') {
            // Last.fm fallback for empty queries
            if (lastfmUsername) {
                const recent = await LastFM.getRecentTracks(lastfmUsername, 1, lastfmSessionKey);
                if (recent && recent.length > 0) {
                    tracks.push({
                        name: recent[0].name,
                        artist: recent[0].artist['#text'] || recent[0].artist?.name
                    });
                }
            }
        } else if (!query.startsWith('http')) {
            // Raw text query (e.g. "Song by Artist")
            let trackPart = query;
            let artistPart = '';

            if (query.includes(' by ')) {
                const parts = query.split(' by ');
                trackPart = parts[0].trim();
                artistPart = parts[1].trim();
                
                if (artistPart.toLowerCase() === 'cas') artistPart = 'Cigarettes After Sex';
            }

            const meta = await Spotify.searchRaw(artistPart ? `${trackPart} ${artistPart}` : query);
            if (meta) {
                tracks.push(meta);
            } else {
                tracks.push({ name: trackPart, artist: artistPart });
            }
        } else {
            // Generic fallback for any other link (YouTube video, etc.)
            tracks.push({ name: query, artist: '' });
        }

        return { tracks, collectionName };
    }
}
