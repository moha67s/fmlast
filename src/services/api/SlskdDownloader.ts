import axios from 'axios';
import fs from 'fs';
import path from 'path';
import NodeID3 from 'node-id3';
import { config } from '../../../config';

const SLSKD_URL = config.SLSKD_URL;
const SLSKD_API_KEY = config.SLSKD_API_KEY;
const SLSKD_DOWNLOADS_DIR = config.SLSKD_DOWNLOADS_DIR;

const PREFERRED_FORMATS = ['.flac', '.mp3', '.ogg', '.m4a'];
const MAX_WAIT_MS = 120_000;   // 2 min total
const POLL_INTERVAL_MS = 2_000;

const api = axios.create({
    baseURL: `${SLSKD_URL}/api/v0`,
    headers: { 'X-API-Key': SLSKD_API_KEY }
});

interface SlskFile {
    filename: string;
    size: number;
    bitRate?: number;
    username: string;
}

export class SlskdDownloader {

    /**
     * Search slskd and return ranked file candidates.
     */
    private static async search(query: string): Promise<SlskFile[]> {
        // 1. Start search
        const { data: search } = await api.post('/searches', {
            searchText: query,
            fileLimit: 100,
            filterResponses: true
        });

        const searchId: string = search.id;
        console.log(`🔍 slskd search started: ${searchId}`);

        // 2. Poll until complete (slskd searches run for ~5s by default)
        await this.sleep(6000);

        const { data: results } = await api.get(`/searches/${searchId}`);

        // 3. Flatten all files from all peers
        const files: SlskFile[] = [];
        for (const response of results.responses ?? []) {
            for (const file of response.files ?? []) {
                files.push({
                    filename: file.filename,
                    size: file.size,
                    bitRate: file.bitRate,
                    username: response.username
                });
            }
        }

        // 4. Clean up search
        await api.delete(`/searches/${searchId}`).catch(() => {});

        return files;
    }

    /**
     * Pick the best file: prefer MP3 320 > FLAC > MP3 > others.
     */
    private static pickBest(files: SlskFile[], artist: string, title: string): SlskFile | null {
        const query = `${artist} ${title}`.toLowerCase();

        const scored = files
            .filter(f => {
                const ext = path.extname(f.filename).toLowerCase();
                return PREFERRED_FORMATS.includes(ext);
            })
            .map(f => {
                const name = f.filename.toLowerCase();
                const ext = path.extname(name);
                let score = 0;

                // Filename relevance
                if (name.includes(artist.toLowerCase())) score += 10;
                if (name.includes(title.toLowerCase())) score += 10;

                // Format preference
                if (ext === '.mp3' && (f.bitRate ?? 0) >= 320) score += 8;
                else if (ext === '.flac') score += 7;
                else if (ext === '.mp3' && (f.bitRate ?? 0) >= 192) score += 5;
                else if (ext === '.mp3') score += 3;

                // Avoid very small files (likely corrupt/preview)
                if (f.size < 1_000_000) score -= 20;

                return { file: f, score };
            })
            .sort((a, b) => b.score - a.score);

        return scored[0]?.file ?? null;
    }

    /**
     * Queue a download on slskd and wait for it to finish.
     */
    private static async queueAndWait(file: SlskFile): Promise<string> {
        const encodedUsername = encodeURIComponent(file.username);

        // Queue download
        await api.post(`/transfers/downloads/${encodedUsername}`, {
            files: [{ filename: file.filename }]
        });

        console.log(`⬇️  Queued: ${file.filename} from ${file.username}`);

        // Poll until complete
        const deadline = Date.now() + MAX_WAIT_MS;

        while (Date.now() < deadline) {
            await this.sleep(POLL_INTERVAL_MS);

            const { data: transfers } = await api.get(
                `/transfers/downloads/${encodedUsername}`
            );

            const match = transfers
                ?.flatMap((d: any) => d.files ?? [])
                ?.find((f: any) => f.filename === file.filename);

            if (!match) continue;

            console.log(`📊 Status: ${match.state} | ${Math.round((match.bytesTransferred / match.size) * 100)}%`);

            if (match.state === 'Completed, Succeeded') {
                return match.filename; // Full path on disk
            }

            if (match.state?.startsWith('Completed,') && match.state !== 'Completed, Succeeded') {
                throw new Error(`Download failed with state: ${match.state}`);
            }
        }

        throw new Error('Download timed out after 2 minutes.');
    }

    /**
     * Main entry point
     */
    static async downloadTrack(
        outputPath: string,
        metadata: { name: string; artist: string; album: string; artworkUrl?: string }
    ): Promise<string> {
        const query = `${metadata.artist} ${metadata.name}`;

        // 1. Search
        const files = await this.search(query);
        if (files.length === 0) {
            throw new Error(`No results found on Soulseek for: ${query}`);
        }

        // 2. Pick best file
        const best = this.pickBest(files, metadata.artist, metadata.name);
        if (!best) {
            throw new Error(`No suitable audio file found for: ${query}`);
        }

        console.log(`✅ Best match: ${best.filename} (${best.bitRate ?? '?'}kbps, ${(best.size / 1_048_576).toFixed(1)}MB)`);

        // 3. Download via slskd
        const downloadedPath = await this.queueAndWait(best);

        // 4. Copy from slskd's download dir to our temp output path
        //    slskd saves to SLSKD_DOWNLOADS_DIR — we read and copy
        const slskdFilePath = path.join(
            SLSKD_DOWNLOADS_DIR,
            path.basename(downloadedPath)
        );

        // Wait a moment for file to be fully flushed
        await this.sleep(500);
        if (!fs.existsSync(slskdFilePath)) {
            // Fallback: search recursively if needed, but basename is usually enough
            console.error(`File not found at ${slskdFilePath}. Checking slskd downloads structure...`);
            throw new Error(`Could not find downloaded file at ${slskdFilePath}. Check shared volume mount.`);
        }
        
        fs.copyFileSync(slskdFilePath, outputPath);

        // 5. Write ID3 tags (MP3 only)
        const ext = path.extname(best.filename).toLowerCase();
        if (ext === '.mp3') {
            const tags: any = {
                title: metadata.name,
                artist: metadata.artist,
                album: metadata.album,
            };
            if (metadata.artworkUrl) {
                try {
                    const artData = await axios.get(metadata.artworkUrl, { responseType: 'arraybuffer' });
                    tags.image = {
                        mime: 'image/jpeg',
                        type: { id: 3, name: 'front cover' },
                        description: 'Front Cover',
                        imageBuffer: artData.data
                    };
                } catch (e) {
                    console.warn('Failed to fetch artwork for ID3 tagging.');
                }
            }
            NodeID3.write(tags, outputPath);
        }

        return outputPath;
    }

    private static sleep(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
