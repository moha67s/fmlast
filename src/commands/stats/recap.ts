import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { AppleMusic } from '../../services/api/AppleMusic';
import { Deezer } from '../../services/api/Deezer';
import { prisma } from '../../database/client';
import { AttachmentBuilder, TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { createRecapVideo } from '../../utils/downloader';
import { resolveTargetUser } from '../../utils/userResolver';
import { OpenAiService } from '../../services/external/OpenAiService';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { StatsService } from '../../services/bot/StatsService';

export default class RecapCommand extends BaseCommand {
    name = 'recap';
    description = 'Generate a personalized 30-second video recap of your listening history.';
    aliases = ['wrapped', 'summary'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('recap')
        .setDescription('Generate a personalized 30-second video recap of your listening history.')
        .addStringOption((opt: any) =>
            opt.setName('period').setDescription('Time period for the recap').setRequired(false)
                .addChoices(
                    { name: 'Weekly', value: '7day' },
                    { name: 'Monthly', value: '1month' },
                    { name: '6 Months', value: '6month' },
                    { name: 'Yearly', value: '12month' },
                    { name: 'All Time', value: 'overall' }
                )
        )
        .addUserOption((opt: any) =>
            opt.setName('user').setDescription('View another user\'s recap').setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        if (!isSlash) {
            try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch (err) { }
        }

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        if (!dbUser?.lastfmUsername) {
            const isSelf = userId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
            const msg = isSelf 
                ? '❌ You are not linked to Last.fm yet. Run `/login` first!'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            
            if (isSlash) await interactionOrMessage.reply({ content: msg, ephemeral: true });
            else await interactionOrMessage.channel.send(msg);
            return;
        }

        let periodRequested = '7day';
        if (isSlash) {
            periodRequested = interactionOrMessage.options?.getString('period') || '7day';
        } else if (args && args.length > 0) {
            const p = args[0].toLowerCase();
            if (['weekly', 'week', '7day'].includes(p)) periodRequested = '7day';
            else if (['monthly', 'month', '1month'].includes(p)) periodRequested = '1month';
            else if (['6months', 'halfyear', '6month'].includes(p)) periodRequested = '6month';
            else if (['yearly', 'year', '12month'].includes(p)) periodRequested = '12month';
            else if (['alltime', 'overall', 'all'].includes(p)) periodRequested = 'overall';
        }

        if (isSlash) await interactionOrMessage.deferReply();

        const statusMsg = isSlash ? interactionOrMessage : await interactionOrMessage.reply('🎥 Gathering your musical data... (This takes about 30 seconds)');
        const editStatus = async (msg: string) => {
            if (isSlash) await interactionOrMessage.editReply(`🎥 ${msg}`);
            else await statusMsg.edit(`🎥 ${msg}`).catch(() => {});
        };

        try {
            await editStatus('Gathering indexed statistics...');
            
            const now = new Date();
            let fromDate = new Date(now.getTime() - 7 * 86400 * 1000);
            if (periodRequested === '1month') fromDate = new Date(now.getTime() - 30 * 86400 * 1000);
            if (periodRequested === '6month') fromDate = new Date(now.getTime() - 180 * 86400 * 1000);
            if (periodRequested === '12month') fromDate = new Date(now.getTime() - 365 * 86400 * 1000);
            if (periodRequested === 'overall') fromDate = new Date(0);

            let topArtists: any[] = [];
            let topTracks: any[] = [];
            let topAlbums: any[] = [];
            let topGenres: any[] = [];

            if (periodRequested === 'overall') {
                // FAST PATH: Read directly from aggregated tables for All-Time
                const [dbArtists, dbTracks, dbAlbums, dbGenres] = await Promise.all([
                    prisma.userArtist.findMany({ where: { userId: dbUser.id, playcount: { gt: 0 } }, orderBy: { playcount: 'desc' }, take: 10 }),
                    prisma.userTrack.findMany({ where: { userId: dbUser.id, playcount: { gt: 0 } }, orderBy: { playcount: 'desc' }, take: 10 }),
                    prisma.userAlbum.findMany({ where: { userId: dbUser.id, playcount: { gt: 0 } }, orderBy: { playcount: 'desc' }, take: 10 }),
                    StatsService.getTopGenres(dbUser.id, fromDate, now, 10) // Keep genres from StatsService or compute natively later
                ]);

                topArtists = dbArtists.map(a => ({ name: a.artistName, playcount: a.playcount }));
                topTracks = dbTracks.map(t => ({ name: t.trackName, artistName: t.artistName, playcount: t.playcount }));
                topAlbums = dbAlbums.map(a => ({ name: a.albumName, artistName: a.artistName, playcount: a.playcount }));
                topGenres = dbGenres;
            } else {
                // TIME-FILTERED: Group over raw UserPlay
                const [dbArtists, dbTracks, dbAlbums, dbGenres] = await Promise.all([
                    StatsService.getTopArtists(dbUser.id, fromDate, now, 10),
                    StatsService.getTopTracks(dbUser.id, fromDate, now, 10),
                    StatsService.getTopAlbums(dbUser.id, fromDate, now, 10),
                    StatsService.getTopGenres(dbUser.id, fromDate, now, 10)
                ]);
                topArtists = dbArtists;
                topTracks = dbTracks;
                topAlbums = dbAlbums;
                topGenres = dbGenres;
            }

            if (!topArtists.length || !topTracks.length) {
                // FALLBACK: Last.fm API if DB is empty
                const [lfmArtists, lfmTracks, lfmAlbums] = await Promise.all([
                    LastFM.getTopArtists(dbUser.lastfmUsername, periodRequested, 10, dbUser.lastfmSessionKey),
                    LastFM.getTopTracks(dbUser.lastfmUsername, periodRequested, 10, dbUser.lastfmSessionKey),
                    LastFM.getTopAlbums(dbUser.lastfmUsername, periodRequested, 10, dbUser.lastfmSessionKey)
                ]);
                
                if (!lfmArtists.length) {
                    const msg = '😢 Not enough data to generate a recap for this period. Listen to more music!';
                    isSlash ? await interactionOrMessage.editReply(msg) : await statusMsg.edit(msg);
                    return;
                }
                
                // Use API data
                topArtists.push(...lfmArtists.map(a => ({ name: a.name, playcount: parseInt(a.playcount) })));
                topTracks.push(...lfmTracks.map(t => ({ name: t.name, artistName: t.artist.name, playcount: parseInt(t.playcount) })));
                topAlbums.push(...lfmAlbums.map(a => ({ name: a.name, artistName: a.artist.name, playcount: parseInt(a.playcount) })));
            }

            // --- DATA ANALYSIS ---
            const periodLabels: Record<string, string> = { '7day': 'LAST WEEK', '1month': 'LAST MONTH', '6month': 'LAST 6 MONTHS', '12month': 'LAST YEAR', 'overall': 'ALL TIME' };
            const periodLabel = periodLabels[periodRequested];
            
            // Accurate playcount from DB or API
            const totalScrobbles = topArtists.reduce((acc, a) => acc + (a.playcount || 0), 0);
            const totalMinutes = Math.floor(totalScrobbles * 3.5);

            // Fetch Genres (Already fetched from DB if available)
            const sortedGenres = topGenres.length > 0 
                ? topGenres.map(g => g.name.toUpperCase()) 
                : [];
            
            if (sortedGenres.length === 0) {
                // Fallback genres logic...
                for (const artist of topArtists.slice(0, 3)) {
                    try {
                        const tags = await LastFM.getArtistTopTags(artist.name);
                        tags.slice(0, 3).forEach((t: any) => sortedGenres.push(t.name.toUpperCase()));
                    } catch { }
                    if (sortedGenres.length >= 5) break;
                }
            }

            const vibeText = await OpenAiService.getInstance().generateAuraSummary(topArtists.map(a => a.name), sortedGenres);

            // --- MEDIA RESOLUTION ---
            await editStatus('Resolving audio previews and cover art...');
            
            const topArtistName = topArtists[0].name;
            const topArtistImage = await Spotify.getArtistCover(topArtistName) || 'https://i.imgur.com/Gis9d79.png';

            // Resolve a single random Audio URL
            let audioUrl: string | null = null;
            const shuffledTracks = [...topTracks].sort(() => 0.5 - Math.random());
            
            for (const track of shuffledTracks) {
                const amRes = await AppleMusic.searchTrack(track.artistName || topArtistName, track.name);
                if (amRes?.previewUrl) { audioUrl = amRes.previewUrl; break; }
                const dzRes = await Deezer.searchTrack(track.artistName || topArtistName, track.name);
                if (dzRes?.previewUrl) { audioUrl = dzRes.previewUrl; break; }
            }

            // Generate Cover Grids (MUCH FASTER with indexing)
            const getCoverGrid = async (artist: string) => {
                const grid: string[] = [];
                // 1. Check local DB for tracks with covers
                const dbTracks = await prisma.userTrack.findMany({
                    where: { artistName: { equals: artist, mode: 'insensitive' }, userId: dbUser.id },
                    take: 20
                });
                
                for (const t of dbTracks) {
                    const cover = await Spotify.getTrackCover(t.trackName, artist);
                    if (cover && !grid.includes(cover)) grid.push(cover);
                }
                
                if (grid.length < 5) {
                    // Fallback to API if DB search was poor
                    const tracks = await LastFM.getArtistTopTracks(artist, 10);
                    for (const t of tracks) {
                        const cover = await Spotify.getTrackCover(t.name, artist);
                        if (cover && !grid.includes(cover)) grid.push(cover);
                        if (grid.length >= 20) break;
                    }
                }

                while (grid.length < 20 && grid.length > 0) grid.push(grid[Math.floor(Math.random() * grid.length)]);
                return grid.length >= 20 ? grid : Array(20).fill('https://i.imgur.com/Gis9d79.png');
            };

            const grid1 = await getCoverGrid(topArtistName);
            const grid2 = topArtists.length > 1 ? await getCoverGrid(topArtists[1].name) : grid1;

            // --- RENDER SCENES (Puppeteer) ---
            await editStatus('Rendering visual scenes...');
            
            const totalDays = Math.floor(totalMinutes / 1440);
            
            const top5Artists = topArtists.slice(0, 5).map((a, i) => ({ rank: i + 1, name: a.name }));
            const top5Tracks = topTracks.slice(0, 5).map((t, i) => ({ rank: i + 1, name: t.name }));
            const topGenre = sortedGenres.length > 0 ? sortedGenres[0] : 'UNKNOWN';

            const scene1Variant = Math.floor(Math.random() * 3) + 1;
            const scene2Variant = Math.floor(Math.random() * 3) + 1;
            const scene3Variant = Math.floor(Math.random() * 3) + 1;

            // Scene 1 is now always a summary layout
            const scene1LayoutType = Math.random() > 0.5 ? 'summary2' : 'summary1';
            
            // Scene 2 is now always Top Albums
            await editStatus('Fetching top album covers...');
            const top5AlbumsData = topAlbums.slice(0, 5).map((a, i) => ({ rank: i + 1, name: a.name, artist: a.artistName || topArtistName, cover: '' }));
            for (let i = 0; i < top5AlbumsData.length; i++) {
                top5AlbumsData[i].cover = await Spotify.getAlbumCover(top5AlbumsData[i].name, top5AlbumsData[i].artist) || 'https://i.imgur.com/Gis9d79.png';
            }
            await editStatus('Rendering visual scenes...');

            const scene1Data = {
                variant: scene1Variant,
                artistImage: topArtistImage,
                topArtists: top5Artists,
                topTracks: top5Tracks,
                minutes: totalMinutes.toLocaleString(),
                topGenre: topGenre
            };

            const scene2Data = {
                variant: scene2Variant,
                topAlbums: top5AlbumsData
            };

            const scene3Data = {
                variant: scene3Variant,
                genres: sortedGenres.slice(0, 5).map((name, i) => ({ rank: i + 1, name }))
            };

            let scene1Template = scene1LayoutType === 'summary2' ? 'recap_scene1_v2' : 'recap_scene1';

            const buf1 = await PuppeteerService.render(scene1Template, scene1Data, { width: 1080, height: 1920 });
            const buf2 = await PuppeteerService.render('recap_scene1_albums', scene2Data, { width: 1080, height: 1920 });
            const buf3 = await PuppeteerService.render('recap_scene3', scene3Data, { width: 1080, height: 1920 });

            // Save images to temp dir
            const tempDir = os.tmpdir();
            const id = `recap_${interactionOrMessage.id}`;
            const p1 = path.join(tempDir, `${id}_1.webp`);
            const p2 = path.join(tempDir, `${id}_2.webp`);
            const p3 = path.join(tempDir, `${id}_3.webp`);

            await Promise.all([
                fsp.writeFile(p1, buf1),
                fsp.writeFile(p2, buf2),
                fsp.writeFile(p3, buf3)
            ]);

            // --- FFMPEG STITCHING ---
            await editStatus('Stitching video and syncing audio... (Almost done!)');
            
            const videoPath = await createRecapVideo([p1, p2, p3], audioUrl, id);

            // --- SEND ---
            const attachment = new AttachmentBuilder(videoPath, { name: 'recap.mp4' });
            const content = `### 🎬 Your ${periodLabel} Recap — ${targetUser.username}`;

            if (isSlash) await interactionOrMessage.editReply({ content, files: [attachment] });
            else await statusMsg.edit({ content, files: [attachment] });

            // Cleanup remaining files (downloader.ts handles its own)
            await Promise.all([
                fsp.unlink(p1).catch(() => {}),
                fsp.unlink(p2).catch(() => {}),
                fsp.unlink(p3).catch(() => {}),
                fsp.unlink(videoPath).catch(() => {})
            ]);

        } catch (err: any) {
            console.error('[RecapCommand] Error:', err);
            const msg = `⚠️ Failed to generate recap: ${err.message || 'Unknown error'}`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await statusMsg.edit(msg);
        }
    }
}
