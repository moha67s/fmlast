// src/commands/lastfm/chart.ts
import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { config } from '../../../config';
import {
    AttachmentBuilder,
    ChannelType,
    TextChannel,
    ButtonStyle
} from 'discord.js';
import axios from 'axios';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { TrackResolverService } from '../../services/api/TrackResolverService';

// ==================== OPTIONS INTERFACE ====================
export interface ChartOptions {
    skipNoImage: boolean;
    sfwOnly: boolean;
    hideSingles: boolean;
    releaseFilter: string; // e.g. "2024", "1990s", "" for none
}

export const DEFAULT_OPTIONS: ChartOptions = {
    skipNoImage: false,
    sfwOnly: false,
    hideSingles: false,
    releaseFilter: '',
};

// ==================== PERIOD HELPERS ====================

/** Get the unix timestamp range for a custom period like "month-2026-03" or "year-2025" */
function getCustomPeriodRange(periodInput: string): { from: number; to: number } | null {
    const monthMatch = periodInput.match(/^month-(\d{4})-(\d{2})$/);
    if (monthMatch) {
        const year = parseInt(monthMatch[1]);
        const month = parseInt(monthMatch[2]) - 1;
        const from = new Date(year, month, 1).getTime() / 1000;
        const to = new Date(year, month + 1, 0, 23, 59, 59).getTime() / 1000;
        return { from: Math.floor(from), to: Math.floor(to) };
    }

    const yearMatch = periodInput.match(/^year-(\d{4})$/);
    if (yearMatch) {
        const year = parseInt(yearMatch[1]);
        const from = new Date(year, 0, 1).getTime() / 1000;
        const to = new Date(year, 11, 31, 23, 59, 59).getTime() / 1000;
        return { from: Math.floor(from), to: Math.floor(to) };
    }

    return null;
}

function matchesReleaseFilter(releaseYear: number | null, filter: string): boolean {
    if (!filter || !releaseYear) return true;
    const exactYear = parseInt(filter);
    if (!isNaN(exactYear) && filter.length === 4) return releaseYear === exactYear;

    const decadeMatch = filter.match(/^(\d{2,4})s$/i);
    if (decadeMatch) {
        let decade = parseInt(decadeMatch[1]);
        if (decade < 100) decade += decade < 30 ? 2000 : 1900;
        return releaseYear >= decade && releaseYear < decade + 10;
    }

    const rangeMatch = filter.match(/^(\d{4})-(\d{4})$/);
    if (rangeMatch) {
        const start = parseInt(rangeMatch[1]);
        const end = parseInt(rangeMatch[2]);
        return releaseYear >= start && releaseYear <= end;
    }
    return true;
}

export default class ChartCommand extends BaseCommand {
    name = 'chart';
    description = 'Generate a grid chart of your top albums for a time period (exactly like .fmbot)';
    aliases = ['ch', 'grid'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('chart')
        .setDescription('Generate a grid chart of your top albums')
        .addStringOption((opt: any) =>
            opt.setName('period')
                .setDescription('Time period')
                .setRequired(true)
                .addChoices(
                    { name: 'Day', value: 'daily' },
                    { name: 'Week', value: 'weekly' },
                    { name: 'Month', value: 'monthly' },
                    { name: 'Year', value: 'yearly' },
                    { name: 'Overall', value: 'overall' }
                )
        )
        .addIntegerOption((opt: any) =>
            opt.setName('size')
                .setDescription('Grid size (1x1 → 9x9)')
                .setMinValue(1)
                .setMaxValue(9)
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        if (!isSlash) {
            try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch (err) { }
        }

        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        let periodInput = 'weekly';
        let gridSize = 3;

        if (isSlash) {
            periodInput = interactionOrMessage.options.getString('period') || 'weekly';
            gridSize = interactionOrMessage.options.getInteger('size') || 3;
        } else {
            const content = interactionOrMessage.content.toLowerCase();
            const cmdArgs = content.split(/\s+/).slice(1);
            for (const arg of cmdArgs) {
                const numMatch = arg.match(/(\d+)/);
                if (numMatch) {
                    const num = parseInt(numMatch[1]);
                    if (num >= 1 && num <= 9) gridSize = num;
                }
                const periodMap: Record<string, string> = {
                    day: 'daily', daily: 'daily',
                    week: 'weekly', weekly: 'weekly',
                    month: 'monthly', monthly: 'monthly',
                    year: 'yearly', yearly: 'yearly',
                    overall: 'overall', all: 'overall', alltime: 'overall'
                };
                if (periodMap[arg]) periodInput = periodMap[arg];
            }
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser?.lastfmSessionKey || !dbUser.lastfmUsername) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ You are not linked to Last.fm yet.\nRun `/login` or `!login` first!').build();
            if (isSlash) await interactionOrMessage.reply({ ...payload, ephemeral: true });
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        try {
            const payload = await ChartCommand.createChartPayload(userId, dbUser.lastfmUsername, dbUser.lastfmSessionKey, gridSize, periodInput, interactionOrMessage.client, DEFAULT_OPTIONS);
            isSlash ? await interactionOrMessage.reply(payload) : await interactionOrMessage.channel.send(payload);
        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ ${err.message || 'Could not generate chart.'}`).build();
            if (isSlash) await interactionOrMessage.reply({ ...payload, ephemeral: true });
            else await interactionOrMessage.channel.send(payload);
        }
    }

    static async createChartPayload(discordId: string, username: string, sessionKey: string, gridSize: number, periodInput: string, client: any, options: ChartOptions = DEFAULT_OPTIONS): Promise<any> {
        const needed = gridSize * gridSize;
        const periodInfo = this.getPeriodInfoStatic(periodInput);
        const { display: displayName, preset: datePreset } = periodInfo;

        const filtersActive = options.skipNoImage || options.sfwOnly || options.hideSingles || options.releaseFilter;
        const fetchLimit = filtersActive ? needed * 4 : needed;

        let rawAlbums: any[] = [];
        const customRange = getCustomPeriodRange(periodInput);
        if (customRange) {
            rawAlbums = await LastFM.getWeeklyAlbumChart(username, customRange.from, customRange.to, fetchLimit, sessionKey);
        } else {
            const apiPeriod = periodInfo.api;
            if (apiPeriod === 'daily') {
                const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
                const recentTracks = await LastFM.getRecentTracksPaginated(username, 200, 1, sessionKey, false, oneDayAgo);
                const albumCounts = new Map<string, any>();
                for (const track of recentTracks.tracks) {
                    const albumName = track.album?.['#text'];
                    const artistName = track.artist?.name || track.artist?.['#text'];
                    if (!albumName || !artistName) continue;
                    const key = `${albumName}|${artistName}`;
                    if (!albumCounts.has(key)) {
                        albumCounts.set(key, { name: albumName, artist: { name: artistName }, playcount: 0, image: track.image });
                    }
                    albumCounts.get(key).playcount++;
                }
                rawAlbums = Array.from(albumCounts.values()).sort((a, b) => b.playcount - a.playcount);
            } else {
                rawAlbums = await LastFM.getTopAlbums(username, apiPeriod as any, fetchLimit, sessionKey);
            }
        }

        if (!rawAlbums?.length) throw new Error('No albums found for this period.');
        let albums = rawAlbums;
        if (options.hideSingles || options.sfwOnly || options.releaseFilter) albums = await this.filterAlbums(rawAlbums, options);
        if (albums.length === 0) throw new Error('No albums left after applying filters.');

        let actualGridSize = gridSize;
        while (actualGridSize > 1 && albums.length < actualGridSize * actualGridSize) actualGridSize--;
        gridSize = actualGridSize;
        const actualNeeded = gridSize * gridSize;

        const chartBuffer = await this.generateChartImageStatic(albums, gridSize, options.skipNoImage);
        let cdnUrl: string | null = null;
        const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;

        if (stagingChannelId && client) {
            try {
                const stagingChannel = await client.channels.fetch(stagingChannelId) as TextChannel | null;
                if (stagingChannel?.type === ChannelType.GuildText) {
                    const attachment = new AttachmentBuilder(chartBuffer, { name: `album-chart-${gridSize}x${gridSize}-${displayName}-${username}.webp` });
                    const stagingMessage = await stagingChannel.send({ files: [attachment] });
                    cdnUrl = stagingMessage.attachments.first()?.url || null;
                    // Deleting after 24 hours to keep the CDN link alive for a while
                    setTimeout(() => stagingMessage.delete().catch(() => { }), 86400000);
                }
            } catch (e) { console.warn('⚠️ Staging failed:', e); }
        }

        if (!cdnUrl) throw new Error('Could not upload chart to Discord CDN.');
        const userInfo = await LastFM.getUserInfo(username, sessionKey);

        let albumDescriptions = albums.slice(0, actualNeeded).map((a: any, i: number) => `#${i + 1} ${a.name} by ${a.artist?.name || a.artist?.['#text'] || 'Unknown'}`).join(', ');
        if (albumDescriptions.length > 1024) albumDescriptions = albumDescriptions.substring(0, 1021) + '...';

        const si = options.skipNoImage ? '1' : '0';
        const sfw = options.sfwOnly ? '1' : '0';
        const hs = options.hideSingles ? '1' : '0';
        const rf = options.releaseFilter || '_';

        const editButton = {
            type: 2,
            custom_id: `chart-edit:${discordId}:${gridSize}:${periodInput}:${si}:${sfw}:${hs}:${rf}:${username}`,
            style: ButtonStyle.Secondary,
            label: 'Edit'
        };

        return new ComponentsV2()
            .setAccent(0xff0000)
            .addMedia(cdnUrl, albumDescriptions)
            .addText(`**[${gridSize}x${gridSize} ${displayName} Chart](https://www.last.fm/user/${username}/library/albums?date_preset=${datePreset}) for ${username}**`)
            .addSeparator()
            .addAction(`-# ${username} has ${userInfo.playcount?.toLocaleString() || '0'} scrobbles`, editButton)
            .build();
    }

    private static async filterAlbums(albums: any[], options: ChartOptions): Promise<any[]> {
        const metadataPromises = albums.map(async (album: any) => {
            const artistName = album?.artist?.name || album?.artist?.['#text'] || '';
            try {
                const res = await TrackResolverService.resolveAlbum(artistName, album.name);
                // Note: resolveAlbum needs to be updated to return albumType and isExplicit if we want full parity.
                // For now, it returns releaseYear.
                return { 
                    album, 
                    albumType: (res as any).albumType || null, 
                    isExplicit: (res as any).isExplicit || false, 
                    releaseYear: res.releaseYear 
                };
            } catch { return { album, albumType: null, isExplicit: false, releaseYear: null }; }
        });
        const albumsWithMeta = await Promise.all(metadataPromises);
        return albumsWithMeta.filter(({ albumType, isExplicit, releaseYear }) => {
            if (options.hideSingles && albumType === 'single') return false;
            if (options.sfwOnly && isExplicit) return false;
            if (options.releaseFilter && !matchesReleaseFilter(releaseYear, options.releaseFilter)) return false;
            return true;
        }).map(({ album }) => album);
    }

    static getPeriodInfoStatic(periodInput: string): { display: string; api: string; preset: string } {
        const map: Record<string, { display: string; api: string; preset: string }> = {
            daily: { display: 'Daily', api: 'daily', preset: 'LAST_7_DAYS' },
            weekly: { display: 'Weekly', api: '7day', preset: 'LAST_7_DAYS' },
            monthly: { display: 'Monthly', api: '1month', preset: 'LAST_30_DAYS' },
            yearly: { display: 'Yearly', api: '12month', preset: 'LAST_365_DAYS' },
            overall: { display: 'All-Time', api: 'overall', preset: 'ALL' }
        };
        if (map[periodInput]) return map[periodInput];

        const monthMatch = periodInput.match(/^month-(\d{4})-(\d{2})$/);
        if (monthMatch) {
            const year = parseInt(monthMatch[1]);
            const month = parseInt(monthMatch[2]);
            const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            return { display: `${monthNames[month]} ${year}`, api: 'custom', preset: 'ALL' };
        }

        const yearMatch = periodInput.match(/^year-(\d{4})$/);
        if (yearMatch) {
            return { display: yearMatch[1], api: 'custom', preset: 'ALL' };
        }
        return map.weekly;
    }

    private static async generateChartImageStatic(albums: any[], gridSize: number, skipNoImage = false): Promise<Buffer> {
        const cellSize = 300;
        const padding = 15;
        const needed = gridSize * gridSize;
        const width = gridSize * cellSize + padding * (gridSize + 1);
        const height = gridSize * cellSize + padding * (gridSize + 1);

        const templateData: any = { width, height, gridSize, albums: [] };
        
        // process in batches of 3 to avoid slamming APIs and hitting 429s
        const resolvedAlbums: any[] = [];
        const CHUNK_SIZE = 3;
        const albumSlice = albums.slice(0, needed);
        
        for (let i = 0; i < albumSlice.length; i += CHUNK_SIZE) {
            const chunk = albumSlice.slice(i, i + CHUNK_SIZE);
            const chunkResults = await Promise.all(chunk.map(async (album, index) => {
                const globalIndex = i + index;
                const artistName = album?.artist?.name || album?.artist?.['#text'] || '';
                
                // 1. Try resolving via external APIs (Album Search)
                let res = await TrackResolverService.resolveAlbum(artistName, album.name).catch(() => null);
                
                // 2. If album search failed, try a loose track search as a last-resort fallback
                // (Often albums on LFM are actually singles, and track search is more robust)
                if (!res?.artworkUrl) {
                    const trackRes = await TrackResolverService.resolve(artistName, album.name).catch(() => null);
                    if (trackRes?.artworkUrl) {
                        res = { ...res, artworkUrl: trackRes.artworkUrl } as any;
                    }
                }

                const fallbackUrl = album?.image?.find((img: any) => img.size === 'extralarge' || img.size === 'mega')?.['#text'] || album?.image?.[0]?.['#text'];
                const imgUrl = res?.artworkUrl || fallbackUrl;
                
                if (!imgUrl && skipNoImage) return null;
                
                return {
                    rank: globalIndex + 1,
                    name: album.name,
                    artist: artistName,
                    imageUrl: imgUrl
                };
            }));
            resolvedAlbums.push(...chunkResults.filter(a => a !== null));
        }

        templateData.albums = resolvedAlbums;
        
        return await PuppeteerService.render('chart_grid', templateData, { width, height });
    }
}
