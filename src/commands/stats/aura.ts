import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { AppleMusic } from '../../services/api/AppleMusic';
import { Deezer } from '../../services/api/Deezer';
import { Spotify } from '../../services/api/Spotify';
import { prisma } from '../../database/client';
import { AttachmentBuilder, SlashCommandBuilder, TextChannel, ComponentType, ButtonStyle } from 'discord.js';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import axios from 'axios';
import { parseArgs } from '../../utils/prefixParser';
import { createAuraVideo, tempDir } from '../../utils/downloader';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import fsp from 'fs/promises';
import path from 'path';
import { resolveTargetUser } from '../../utils/userResolver';
import { StatsService } from '../../services/bot/StatsService';


// Per-user cover history: userId → Set of cover URLs already shown
const coverHistory = new Map<string, Set<string>>();

export default class AuraCommand extends BaseCommand {
    name = 'aura';
    description = 'Visualize your musical personality based on your listening history.';
    aliases = ['mood', 'vibe'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('aura')
        .setDescription('Visualize your musical personality based on your listening history.')
        .addStringOption((opt: any) =>
            opt.setName('period').setDescription('Time period for the aura').setRequired(false)
                .addChoices(
                    { name: 'Daily', value: 'daily' },
                    { name: 'Weekly', value: 'weekly' },
                    { name: 'Monthly', value: 'monthly' },
                    { name: 'Yearly', value: 'yearly' },
                    { name: 'All Time', value: 'alltime' }
                )
        )
        .addStringOption((opt: any) =>
            opt.setName('cover').setDescription('Custom album or track name for the background (e.g. "who really cares by tv girl")').setRequired(false)
        )
        .addUserOption((opt: any) =>
            opt.setName('user').setDescription('View another user\'s musical aura').setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        if (!dbUser?.lastfmUsername) {
            const isSelf = userId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
            const msg = isSelf 
                ? '❌ You are not linked to Last.fm yet.\nRun `/login` or `+login` first!'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            
            if (isSlash) {
                await interactionOrMessage.reply({ content: msg, ephemeral: true });
            } else {
                await interactionOrMessage.channel.send(msg);
            }
            return;
        }

        // Get optional custom cover query
        let periodRequested = 'weekly';
        let customQuery = '';

        if (isSlash) {
            periodRequested = interactionOrMessage.options?.getString('period') || 'weekly';
            customQuery = interactionOrMessage.options?.getString('cover') || '';
        } else if (args) {
            const { unnamed } = parseArgs(args);
            const definedPeriods: Record<string, string> = {
                'daily': 'daily', 'day': 'daily',
                'weekly': 'weekly', 'week': 'weekly',
                'monthly': 'monthly', 'month': 'monthly',
                'yearly': 'yearly', 'year': 'yearly',
                'alltime': 'alltime', 'all': 'alltime'
            };
            if (unnamed.length > 0 && definedPeriods[unnamed[0].toLowerCase()]) {
                periodRequested = definedPeriods[unnamed[0].toLowerCase()];
                unnamed.shift();
            }
            customQuery = unnamed.join(' ');
        }

        if (isSlash) await interactionOrMessage.deferReply();

        try {
            let artists: any[] = [];
            let genreCounts: Record<string, number> = {};
            let displayFreqText = 'WEEKLY FREQUENCY';
            let displayPeriodLabel = 'LAST 7 DAYS';

            // ── NEW INDEXED LOGIC ──
            const now = new Date();
            let fromDate = new Date(now.getTime() - 7 * 86400 * 1000);
            
            if (periodRequested === 'daily') {
                fromDate = new Date(now.getTime() - 86400 * 1000);
                displayFreqText = 'DAILY FREQUENCY';
                displayPeriodLabel = 'LAST 24 HOURS';
            } else if (periodRequested === 'monthly') {
                fromDate = new Date(now.getTime() - 30 * 86400 * 1000);
                displayFreqText = 'MONTHLY FREQUENCY';
                displayPeriodLabel = 'LAST 30 DAYS';
            } else if (periodRequested === 'yearly') {
                fromDate = new Date(now.getTime() - 365 * 86400 * 1000);
                displayFreqText = 'YEARLY FREQUENCY';
                displayPeriodLabel = 'LAST YEAR';
            } else if (periodRequested === 'alltime') {
                fromDate = new Date(0);
                displayFreqText = 'OVERALL FREQUENCY';
                displayPeriodLabel = 'ALL TIME';
            }

            // Fetch Top Artists from DB
            artists = await StatsService.getTopArtists(dbUser.id, fromDate, now, 10);
            
            if (artists.length > 0) {
                // Fetch Genres from DB (much faster)
                const topGenres = await StatsService.getTopGenres(dbUser.id, fromDate, now, 20);
                topGenres.forEach(g => {
                    genreCounts[g.name.toLowerCase()] = g.count;
                });
            } else {
                // FALLBACK: Last.fm API
                if (periodRequested === 'daily') {
                    const recentTracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 200);
                    const oneDayAgo = Date.now() / 1000 - 86400;
                    const artistCounts: Record<string, number> = {};
                    for (const track of recentTracks) {
                        const ts = parseInt(track.date?.uts || '0');
                        if (ts > 0 && ts < oneDayAgo) break;
                        const artName = track.artist?.['#text'] || track.artist?.name;
                        if (artName) artistCounts[artName] = (artistCounts[artName] || 0) + 1;
                    }
                    artists = Object.entries(artistCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name]) => ({ name }));
                } else {
                    let lfmPeriod: '7day' | '1month' | '3month' | '6month' | '12month' | 'overall' = '7day';
                    if (periodRequested === 'monthly') lfmPeriod = '1month';
                    if (periodRequested === 'yearly') lfmPeriod = '12month';
                    if (periodRequested === 'alltime') lfmPeriod = 'overall';
                    artists = await LastFM.getTopArtists(dbUser.lastfmUsername, lfmPeriod, 5, dbUser.lastfmSessionKey);
                }
                
                // Fetch Genres for API fallback
                for (const artist of artists) {
                    try {
                        const tags = await LastFM.getArtistTopTags(artist.name);
                        tags.slice(0, 3).forEach((t: any) => {
                            const tag = t.name.toLowerCase();
                            genreCounts[tag] = (genreCounts[tag] || 0) + 1;
                        });
                    } catch { }
                }
            }

            if (!artists?.length) {
                const msg = '😢 Not enough data to generate an aura. Listen to some music first!';
                isSlash ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.channel.send(msg);
                return;
            }

            const knownGenres = ['electronic', 'rock', 'hip-hop', 'rap', 'pop', 'chill', 'jazz', 'metal', 'r&b', 'soul', 'indie', 'alternative', 'trap', 'country', 'classical', 'punk', 'reggae', 'lo-fi'];
            let dominant = 'default';
            let maxCount = 0;
            for (const [tag, count] of Object.entries(genreCounts)) {
                if (knownGenres.includes(tag) && count > maxCount) {
                    maxCount = count;
                    dominant = tag;
                }
            }

            const auraName = dominant === 'default' ? 'ECLECTIC' : dominant.toUpperCase();
            const topArtist = artists[0].name;

            // 3. Get cover image & track its source for the video
            let coverImage: any = null;
            let sourceMetadata: {
                artist: string;
                name: string;
                albumId: string | null;
                url?: string;
                service: 'apple' | 'deezer';
                type: 'album' | 'single' | 'track';
                previewUrl?: string | null;
            } | null = null;

            if (customQuery) {
                let searchName = customQuery;
                let searchArtist = '';
                const expectedType: 'track' | 'album' = 'track';

                const byIndex = customQuery.toLowerCase().lastIndexOf(' by ');
                if (byIndex > 0) {
                    searchName = customQuery.substring(0, byIndex).trim();
                    searchArtist = customQuery.substring(byIndex + 4).trim();
                }

                // ── CUSTOM COVER MODE (Universal Track Resolver) ──
                const resolved = await TrackResolverService.resolve(searchArtist, searchName);
                
                sourceMetadata = {
                    artist: resolved.artist,
                    name: resolved.title,
                    albumId: (resolved.links.apple || resolved.links.deezer)?.split('/').pop() || null,
                    url: resolved.artworkUrl || '',
                    service: resolved.links.apple ? 'apple' : 'deezer',
                    type: expectedType,
                    previewUrl: resolved.previewUrl
                };

                console.log(`\n[aura] ✅ Custom Source: ${resolved.source}`);
                console.log(`[aura]    Track/Album: ${resolved.title} — ${resolved.artist}\n`);
            } else {
                // ── DEFAULT MODE: Random cover from top artist (with no-repeat history) ──
                const artistTracks = await LastFM.getArtistTopTracks(topArtist, 20);

                const coverPool: {
                    url: string;
                    artist: string;
                    name: string;
                    albumId: string | null;
                    service: 'apple' | 'deezer';
                    type: string;
                    previewUrl?: string | null;
                    sourceLabel?: string;
                }[] = [];
                const seenAlbums = new Set<string>();

                for (const track of artistTracks) {
                    const trackName = track.name || '';
                    if (seenAlbums.has(trackName.toLowerCase())) continue;
                    seenAlbums.add(trackName.toLowerCase());

                    try {
                        // 1. Spotify
                        const spCover = await Spotify.getTrackCover(trackName, topArtist);
                        if (spCover) {
                            coverPool.push({
                                url: spCover,
                                artist: topArtist,
                                name: trackName,
                                albumId: null,
                                service: 'deezer', // placeholder for logic
                                type: 'track',
                                sourceLabel: 'Spotify'
                            });
                            // Fetch metadata from AM/DZ for preview URL later
                            const amRes = await AppleMusic.searchTrack(topArtist, trackName);
                            if (amRes) {
                                const last = coverPool[coverPool.length - 1];
                                last.albumId = amRes.albumId;
                                last.previewUrl = amRes.previewUrl;
                                last.service = 'apple';
                            }
                            if (coverPool.length >= 20) break;
                            continue;
                        }

                        // 2. Apple Music
                        const amRes = await AppleMusic.searchTrack(topArtist, trackName);
                        if (amRes?.artworkUrl) {
                            coverPool.push({
                                url: amRes.artworkUrl,
                                artist: amRes.artistName,
                                name: amRes.albumName || amRes.trackName,
                                albumId: amRes.albumId,
                                service: 'apple',
                                type: amRes.albumType || 'track',
                                previewUrl: amRes.previewUrl,
                                sourceLabel: 'Apple Music'
                            });
                            if (coverPool.length >= 20) break;
                            continue;
                        }

                        // 3. Deezer
                        const dzResult = await Deezer.searchTrack(topArtist, trackName);
                        if (dzResult?.artworkUrl) {
                            coverPool.push({
                                url: dzResult.artworkUrl,
                                artist: dzResult.artist,
                                name: dzResult.album || dzResult.name,
                                albumId: dzResult.albumId,
                                service: 'deezer',
                                type: dzResult.albumType || 'track',
                                previewUrl: dzResult.previewUrl,
                                sourceLabel: 'Deezer'
                            });
                            if (coverPool.length >= 20) break;
                        }
                    } catch { }
                }

                // Pick unseen cover
                if (!coverHistory.has(userId)) {
                    coverHistory.set(userId, new Set());
                }
                const seen = coverHistory.get(userId)!;
                let unseen = coverPool.filter(c => !seen.has(c.url));
                if (unseen.length === 0) {
                    seen.clear();
                    unseen = coverPool;
                }

                if (unseen.length > 0) {
                    const poolIdx = Math.floor(Math.random() * unseen.length);
                    const pick = unseen[poolIdx];

                    seen.add(pick.url);
                    sourceMetadata = {
                        artist: pick.artist,
                        name: pick.name,
                        albumId: pick.albumId,
                        url: pick.url,
                        service: pick.service as any,
                        type: pick.type as any,
                        previewUrl: pick.previewUrl
                    };

                    console.log(`\n[aura] ✅ Random Source: ${(pick as any).sourceLabel || 'unknown'}`);
                    console.log(`[aura]    Track/Album: ${pick.name} — ${pick.artist}\n`);
                }
            }

            // 4.5 Prepare display labels and sorted genres
            const sortedGenres = Object.entries(genreCounts)
                .filter(([tag]) => knownGenres.includes(tag))
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([tag]) => tag.toUpperCase());

            // 5. Render via Puppeteer
            const userObj = targetUser;
            const avatarUrl = userObj.displayAvatarURL({ extension: 'png', size: 256 });

            const templateData = {
                coverUrl: sourceMetadata?.url || '', // sourceMetadata.url was resolved earlier
                avatarUrl: avatarUrl,
                displayFreqText: displayFreqText,
                displayName: (userObj.globalName || userObj.displayName || userObj.username).toUpperCase(),
                auraName: auraName,
                genres: sortedGenres,
                topArtist: topArtist.toUpperCase(),
                displayPeriodLabel: displayPeriodLabel
            };


            const buffer = await PuppeteerService.render('aura', templateData, { width: 1080, height: 1080 });

            // --- 7. SEND RESULT ---
            let sent = false;
            const displayNameText = (userObj.globalName || userObj.displayName || userObj.username);

            try {
                let previewUrl: string | null = null;

                // (Rest of the preview resolution logic...)
                if (sourceMetadata) {
                    if (sourceMetadata.type === 'album' && sourceMetadata.albumId) {
                        const tracks = sourceMetadata.service === 'apple'
                            ? await AppleMusic.getAlbumTracks(sourceMetadata.albumId)
                            : await Deezer.getAlbumTracks(sourceMetadata.albumId);
                        const pool = tracks.filter(t => t.previewUrl);
                        if (pool.length > 0) {
                            previewUrl = pool[Math.floor(Math.random() * pool.length)].previewUrl;
                        }
                    }
                    if (!previewUrl && sourceMetadata.previewUrl) previewUrl = sourceMetadata.previewUrl;
                }

                if (!previewUrl) {
                    const artistTracks = await LastFM.getArtistTopTracks(topArtist, 30);
                    if (artistTracks.length > 0) {
                        const shuffled = artistTracks.sort(() => 0.5 - Math.random()).slice(0, 10);
                        for (const track of shuffled) {
                            const amRes = await AppleMusic.searchTrack(topArtist, track.name);
                            if (amRes?.previewUrl) previewUrl = amRes.previewUrl;
                            else {
                                const dzRes = await Deezer.searchTrack(topArtist, track.name);
                                if (dzRes?.previewUrl) previewUrl = dzRes.previewUrl;
                            }
                            if (previewUrl) break;
                        }
                    }
                }

                console.log(`[aura] Preview URL resolved: ${previewUrl ? previewUrl.substring(0, 80) + '...' : 'NONE'}`);

                if (previewUrl) {
                    const imagePath = path.join(tempDir, `aura_${interactionOrMessage.id}.webp`);
                    const videoId = `aura_vid_${interactionOrMessage.id}`;
                    await fsp.writeFile(imagePath, buffer);
                    console.log(`[aura] Image written to ${imagePath} (${buffer.length} bytes)`);

                    console.log(`[aura] Starting FFmpeg video creation...`);
                    const videoPath = await createAuraVideo(imagePath, previewUrl, videoId);
                    
                    const videoStat = await fsp.stat(videoPath);
                    console.log(`[aura] ✅ Video created: ${videoPath} (${videoStat.size} bytes)`);

                    const attachment = new AttachmentBuilder(videoPath, { name: 'aura.mp4' });

                    const content = `### ✨ ${auraName} Phase — ${displayNameText}`;

                    if (isSlash) {
                        await interactionOrMessage.editReply({ content, files: [attachment] });
                    } else {
                        await interactionOrMessage.channel.send({ content, files: [attachment] });
                    }

                    await fsp.unlink(imagePath).catch(() => { });
                    await fsp.unlink(videoPath).catch(() => { });
                    sent = true;
                } else {
                    console.warn('[aura] ⚠️ No preview URL found — will send static image only');
                }
            } catch (err) {
                console.error('[aura] ❌ video generation failed:', err);
            }

            if (!sent) {
                const attachment = new AttachmentBuilder(buffer, { name: 'aura.webp' });
                const content = `### ✨ ${auraName} Phase — ${displayNameText}`;

                if (isSlash) {
                    await interactionOrMessage.editReply({ content, files: [attachment] });
                } else {
                    await interactionOrMessage.channel.send({ content, files: [attachment] });
                }
            }


        } catch (err) {
            console.error('Aura command error:', err);
            const msg = '⚠️ Failed to generate your musical aura.';
            if (isSlash) {
                if (interactionOrMessage.deferred || interactionOrMessage.replied) {
                    await interactionOrMessage.editReply(msg);
                } else {
                    await interactionOrMessage.reply({ content: msg, ephemeral: true });
                }
            } else {
                await interactionOrMessage.channel.send(msg);
            }
        }
    }
}
