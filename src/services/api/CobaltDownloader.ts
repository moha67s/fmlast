import axios from 'axios';
import fs from 'fs';
import NodeID3 from 'node-id3';
import { config } from '../../../config';

export class CobaltDownloader {

    static async downloadTrack(
        outputPath: string,
        metadata: { name: string; artist: string; album: string; artworkUrl?: string; youtubeUrl: string }
    ): Promise<string> {
        if (!config.COBALT_URL) {
            throw new Error("COBALT_URL is not set in environment variables.");
        }

        const baseUrl = config.COBALT_URL.endsWith('/') ? config.COBALT_URL : `${config.COBALT_URL}/`;
        console.log(`📥 Cobalt v10: Requesting ${metadata.name}`);

        // 1. Get stream URL
        const { data: cobaltRes } = await axios.post(baseUrl, {
            url: metadata.youtubeUrl,
            videoQuality: '1080',
            audioFormat: 'mp3',
            downloadMode: 'audio'
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            }
        });

        if (cobaltRes.status === 'error' || !cobaltRes.url) {
            throw new Error(`Cobalt Error: ${cobaltRes.text || 'No URL returned'}`);
        }

        console.log(`🔗 Stream URL obtained. Downloading binary...`);

        // 2. Download the binary with redirect support
        const response = await axios.get(cobaltRes.url, {
            responseType: 'arraybuffer',
            timeout: 90_000,
            maxRedirects: 10,
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const buffer = Buffer.from(response.data);
        const sizeMb = (buffer.length / (1024 * 1024)).toFixed(2);
        console.log(`📦 Downloaded size: ${sizeMb} MB`);

        if (buffer.length < 500000) { // Less than 500KB is likely an error page
            throw new Error(`Downloaded file is suspiciously small (${sizeMb}MB). It might be an error page instead of audio.`);
        }

        fs.writeFileSync(outputPath, buffer);

        // 3. Write ID3 tags
        const tags: any = {
            title: metadata.name,
            artist: metadata.artist,
            album: metadata.album
        };

        if (metadata.artworkUrl) {
            try {
                const art = await axios.get(metadata.artworkUrl, { responseType: 'arraybuffer', timeout: 10000 });
                tags.image = {
                    mime: 'image/jpeg',
                    type: { id: 3, name: 'front cover' },
                    description: 'Front Cover',
                    imageBuffer: Buffer.from(art.data)
                };
            } catch (_) {}
        }

        const success = NodeID3.write(tags, outputPath);
        if (success) {
            console.log(`✅ ID3 Tags written for: ${metadata.name}`);
        } else {
            console.warn(`⚠️ Failed to write ID3 tags for: ${metadata.name}`);
        }

        return outputPath;
    }
}
