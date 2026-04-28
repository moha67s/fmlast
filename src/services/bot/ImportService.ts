import { prisma } from '../../database/client';
import StreamZip from 'node-stream-zip';
import csv from 'csv-parser';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { PuppeteerService } from '../external/PuppeteerService';

export interface ScrobbleImportTrack {
    artist: string;
    track: string;
    album?: string;
    timestamp: number;
}

export class ImportService {
    /**
     * Resolve a direct download link from common hosts like Mediafire or Google Drive
     */
    static async resolveDirectUrl(url: string): Promise<string> {
        console.log(`[Import] Resolving direct URL for: ${url}`);
        
        // Google Drive
        if (url.includes('drive.google.com')) {
            const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
            const fileId = match ? match[1] : null;
            
            if (fileId) {
                const browser = await PuppeteerService.getBrowser();
                const page = await browser.newPage();
                try {
                    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                    
                    // Direct UC link is usually better for starting
                    const ucUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
                    await page.goto(ucUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    
                    // Check if we are on a "Virus Scan" warning page or if it redirected to a download
                    const finalUrl = await page.evaluate(() => {
                        // 1. Check for "Download anyway" button (id="confirm-button")
                        const confirmBtn = document.querySelector('#confirm-button') as HTMLAnchorElement;
                        if (confirmBtn && confirmBtn.href) return confirmBtn.href;
                        
                        // 2. Check for form-based "Download anyway"
                        const form = document.querySelector('form#download-form') as HTMLFormElement;
                        if (form) {
                            const action = form.action;
                            const params = new URLSearchParams();
                            Array.from(form.querySelectorAll('input[type="hidden"]')).forEach((input: any) => {
                                params.append(input.name, input.value);
                            });
                            return `${action}?${params.toString()}`;
                        }
                        
                        return null;
                    });

                    if (finalUrl) {
                        console.log(`[Import] Resolved Google Drive link: ${finalUrl.substring(0, 50)}...`);
                        await page.close();
                        return finalUrl;
                    }
                    
                    // If no confirmation page, it might have already started a download or stayed on a page
                    // In some cases, the current page URL might have the 'confirm' token
                    const currentUrl = page.url();
                    if (currentUrl.includes('confirm=')) {
                        await page.close();
                        return currentUrl;
                    }
                } catch (e) {
                    console.error("[Import] Google Drive Puppeteer resolution failed:", e);
                } finally {
                    await page.close();
                }
                
                // Fallback to the direct UC link if Puppeteer failed
                return `https://drive.google.com/uc?export=download&id=${fileId}`;
            }
        }
        
        // Mediafire
        if (url.includes('mediafire.com')) {
            try {
                const browser = await PuppeteerService.getBrowser();
                const page = await browser.newPage();
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
                
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                
                const downloadUrl = await page.evaluate(() => {
                    const btn = document.querySelector('#downloadButton') as HTMLAnchorElement;
                    return btn ? btn.href : null;
                });

                await page.close();
                if (downloadUrl && downloadUrl.startsWith('http')) {
                    console.log(`[Import] Resolved Mediafire link: ${downloadUrl.substring(0, 50)}...`);
                    return downloadUrl;
                }
            } catch (e) {
                console.error("[Import] Mediafire resolution failed:", e);
            }
        }
        
        return url;
    }
    /**
     * Process a Spotify History ZIP or JSON (Recursive)
     */
    static async parseSpotify(buffer: Buffer): Promise<ScrobbleImportTrack[]> {
        const tracks: ScrobbleImportTrack[] = [];
        
        const processBuffer = async (buf: Buffer) => {
            // Check if it's a JSON file directly
            try {
                const content = buf.toString('utf8');
                if (content.trim().startsWith('[') || content.trim().startsWith('{')) {
                    const data = JSON.parse(content);
                    const results = this.parseSpotifyJson(data);
                    tracks.push(...results);
                    return;
                }
            } catch {}

            // Otherwise treat as ZIP
            const tmpPath = path.join(os.tmpdir(), `spotify_import_${Date.now()}_${Math.random().toString(36).substring(7)}.zip`);
            fs.writeFileSync(tmpPath, buf);
            
            try {
                const zip = new StreamZip.async({ file: tmpPath });
                const entries = await zip.entries();
                
                for (const entry of Object.values(entries)) {
                    if (entry.isDirectory) continue;
                    
                    const name = entry.name.toLowerCase();
                    if (name.endsWith('.json') && (name.includes('endsong') || name.includes('streaminghistory') || name.includes('streaming_history'))) {
                        const content = await zip.entryData(entry.name);
                        const data = JSON.parse(content.toString('utf8'));
                        const results = this.parseSpotifyJson(data);
                        tracks.push(...results);
                    } else if (name.endsWith('.zip')) {
                        // Recurse into nested ZIP
                        const nestedBuf = await zip.entryData(entry.name);
                        await processBuffer(nestedBuf);
                    }
                }
                await zip.close();
            } catch (err) {
                // If it's not a ZIP and not JSON, just skip
            } finally {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            }
        };

        await processBuffer(buffer);
        return tracks;
    }

    /**
     * The "50% Scrobble Rule" — ported from C# FMBot ImportService.IsValidScrobble.
     * - < 30 seconds played → always rejected
     * - > 240 seconds (4 minutes) played → always accepted
     * - Otherwise → only valid if msPlayed > mediaDuration / 2
     */
    private static isValidScrobble(msPlayed: number, mediaDurationMs: number): boolean {
        if (msPlayed < 30000) return false;
        if (msPlayed > 240000) return true;
        // If we don't know the track length, accept it (conservative)
        if (!mediaDurationMs || mediaDurationMs <= 0) return true;
        return msPlayed > mediaDurationMs / 2;
    }

    private static parseSpotifyJson(data: any[]): ScrobbleImportTrack[] {
        if (!Array.isArray(data)) return [];
        
        return data
            .filter(item => 
                (item.master_metadata_track_name && item.master_metadata_album_artist_name) || 
                (item.trackName && item.artistName)
            )
            .filter(item => {
                const msPlayed = item.ms_played || item.msPlayed || 0;
                // Extended history has ms_played_reason_end and duration, basic has msPlayed
                const mediaDuration = item.duration_ms || 0;
                return this.isValidScrobble(msPlayed, mediaDuration);
            })
            .map(item => {
                const artist = item.master_metadata_album_artist_name || item.artistName;
                const track = item.master_metadata_track_name || item.trackName;
                const album = item.master_metadata_album_album_name || item.albumName;
                const dateStr = item.ts || item.endTime;
                
                return {
                    artist,
                    track,
                    album: album || undefined,
                    timestamp: Math.floor(new Date(dateStr).getTime() / 1000)
                };
            });
    }

    /**
     * Process an Apple Music Activity ZIP (Recursive)
     */
    static async parseApple(buffer: Buffer): Promise<ScrobbleImportTrack[]> {
        const tracks: ScrobbleImportTrack[] = [];
        
        const processBuffer = async (buf: Buffer) => {
            const tmpPath = path.join(os.tmpdir(), `apple_import_${Date.now()}_${Math.random().toString(36).substring(7)}.zip`);
            fs.writeFileSync(tmpPath, buf);
            
            try {
                const zip = new StreamZip.async({ file: tmpPath });
                const entries = await zip.entries();
                
                // Process CSVs
                for (const entry of Object.values(entries)) {
                    if (entry.isDirectory) continue;
                    
                    const name = entry.name.toLowerCase();
                    if (name.endsWith('.csv') && (
                        name.includes('play history') ||
                        name.includes('play activity') ||
                        name.includes('recently played') ||
                        name.includes('track play history')
                    )) {
                        const content = await zip.entryData(entry.name);
                        const results = await this.parseAppleCsv(content);
                        tracks.push(...results);
                    } else if (name.endsWith('.zip')) {
                        // Recurse into nested ZIP
                        const nestedBuf = await zip.entryData(entry.name);
                        await processBuffer(nestedBuf);
                    }
                }

                await zip.close();
            } finally {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            }
        };

        await processBuffer(buffer);
        
        if (tracks.length === 0) {
            throw new Error("Could not find any play history CSV files (like 'Apple Music Play Activity.csv') inside the ZIP or nested ZIPs.");
        }
        
        return tracks;
    }

    private static async parseAppleCsv(content: Buffer): Promise<ScrobbleImportTrack[]> {
        return new Promise((resolve, reject) => {
            const results: ScrobbleImportTrack[] = [];
            const stream = Readable.from(content);
            
            stream.pipe(csv())
                .on('data', (row) => {
                    let artist = row['Artist Name'] || row['Artist'] || row['Container Artist Name'];
                    let track = row['Song Name'] || row['Track Name'] || row['Title'];
                    const album = row['Album Name'] || row['Album'] || row['Container Album Name'];
                    const dateStr = row['Play Date'] || row['Date'] || row['Event Start Timestamp'] || row['Date Played'] || row['Last Event Start Timestamp'] || row['Last Played Date'];

                    // Support "Artist - Track" format (very common in summary CSVs)
                    const description = row['Track Description'] || row['Track Name'] || row['Description'];
                    if ((!artist || artist === 'Unknown' || artist === '') && description && description.includes(' - ')) {
                        const parts = description.split(' - ');
                        artist = parts[0].trim();
                        track = parts[1].trim();
                    }

                    if (artist && track && dateStr) {
                        // Apply the 50% scrobble rule if duration data is available
                        const msPlayed = parseInt(row['Play Duration Milliseconds'] || row['Play Duration'] || '0', 10);
                        const mediaDuration = parseInt(row['Media Duration In Milliseconds'] || row['Media Duration'] || '0', 10);
                        
                        // If we have play duration data, validate the scrobble
                        if (msPlayed > 0 && !ImportService.isValidScrobble(msPlayed, mediaDuration)) {
                            return; // Skip invalid scrobbles
                        }

                        let timestamp: number;
                        if (/^\d{8}$/.test(dateStr)) {
                            // Format: YYYYMMDD
                            const year = parseInt(dateStr.substring(0, 4));
                            const month = parseInt(dateStr.substring(4, 6)) - 1;
                            const day = parseInt(dateStr.substring(6, 8));
                            timestamp = Math.floor(new Date(year, month, day).getTime() / 1000);
                        } else if (/^\d{13}$/.test(dateStr)) {
                            // Format: 1707618634541 (Milliseconds)
                            timestamp = Math.floor(parseInt(dateStr) / 1000);
                        } else {
                            // Format: ISO String
                            timestamp = Math.floor(new Date(dateStr).getTime() / 1000);
                        }

                        if (!isNaN(timestamp) && artist !== 'Unknown' && track !== 'Unknown') {
                            results.push({
                                artist,
                                track,
                                album: (album && album !== artist) ? album : undefined,
                                timestamp: timestamp
                            });
                        }
                    }
                })
                .on('end', () => resolve(results))
                .on('error', (err) => reject(err));
        });
    }

    /**
     * Create the import job and queue tracks in the database
     */
    static async createJob(userId: string, source: 'SPOTIFY' | 'APPLE', tracks: ScrobbleImportTrack[], isLegacy = false, initialStatus = 'PENDING') {
        const job = await prisma.importJob.create({
            data: {
                userId,
                source,
                totalTracks: tracks.length,
                status: initialStatus,
                isLegacy
            }
        });

        const CHUNK_SIZE = 5000;
        for (let i = 0; i < tracks.length; i += CHUNK_SIZE) {
            const chunk = tracks.slice(i, i + CHUNK_SIZE).map(t => ({
                jobId: job.id,
                artist: t.artist,
                track: t.track,
                album: t.album,
                timestamp: t.timestamp
            }));

            await prisma.importTrack.createMany({
                data: chunk,
                skipDuplicates: true
            });
        }

        return job;
    }
}
