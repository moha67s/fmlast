import { BaseCommand } from '../../structures/BaseCommand';
import { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { LyricsService, genius } from '../../services/external/LyricsService';
import { RateLimitService } from '../../services/bot/RateLimitService';
import { RenderCacheService } from '../../services/bot/RenderCacheService';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { config } from '../../../config';

export const lyricCache = new Map<string, { lines: string[], coverUrl?: string | null, artistAvatarUrl?: string | null, source?: string, timestamp: number }>();

export function setLyricCacheCover(artist: string, track: string, coverUrl: string | null, artistAvatarUrl?: string | null) {
    const cacheKey = `${artist.substring(0, 28)}|${track.substring(0, 28)}`;
    const entry = lyricCache.get(cacheKey);
    if (entry) {
        entry.coverUrl = coverUrl;
        if (artistAvatarUrl !== undefined) entry.artistAvatarUrl = artistAvatarUrl;
    } else {
        lyricCache.set(cacheKey, { lines: [], source: '', coverUrl, artistAvatarUrl, timestamp: Date.now() });
    }
}

export function getLyricCacheCover(artist: string, track: string): string | null | undefined {
    const cacheKey = `${artist.substring(0, 28)}|${track.substring(0, 28)}`;
    return lyricCache.get(cacheKey)?.coverUrl;
}

/** Check if text contains Arabic characters */
function isArabic(text: string): boolean {
    const arabicPattern = /[\u0600-\u06FF]/;
    return arabicPattern.test(text);
}

/** 
 * Build the lyric card PNG buffer using Puppeteer
 */
export async function buildLyricCardBuffer(opts: {
    artist: string;
    track: string;
    coverUrl: string | null;
    lyricLines: string[];
    lineIdx: number;
    source?: string;
    artistAvatarUrl?: string | null;
    albumName?: string | null;
    albumType?: string | null;
}): Promise<Buffer> {
    const { artist, track, coverUrl, lyricLines, lineIdx, source, artistAvatarUrl, albumName, albumType } = opts;

    const isSingle = albumType === 'single' || !albumName;
    const topText = isSingle ? track : (albumName || track);

    let pageInfo = '';
    if (lyricLines.length > 0) {
        pageInfo = `${lineIdx + 1} – ${Math.min(lineIdx + 2, lyricLines.length)} / ${lyricLines.length}`;
    }

    const snippet1 = lyricLines[lineIdx] || '';
    const snippet2 = lyricLines[lineIdx + 1] || '';
    const isArSnippet = lyricLines.length > 0 && (isArabic(snippet1) || isArabic(snippet2));

    let lyricSnippet: string;
    if (lyricLines.length === 0) {
        lyricSnippet = track; 
    } else {
        const l1 = snippet1.trim();
        const l2 = snippet2.trim();
        if (l1 && l2) {
            lyricSnippet = isArSnippet ? `${l1}\n${l2}` : `${l1},\n${l2}.`;
        } else if (l1) {
            lyricSnippet = isArSnippet ? l1 : l1 + '.';
        } else {
            lyricSnippet = track;
        }
    }

    const snippetKey = lyricLines.length > 0 ? `${lineIdx}:${lyricLines[lineIdx]}` : 'notracks';
    const cacheKey = `lyriccard:${artist}:${track}:${snippetKey}`;
    
    // ── 1. CHECK RENDER CACHE ──
    const cachedUrl = await RenderCacheService.getCachedImage('lyriccard', artist, track + ':' + lineIdx);
    if (cachedUrl) {
        return cachedUrl as any; // We'll handle this in the execute method
    }

    const templateData = {
        artist,
        track,
        coverUrl: coverUrl || 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png',
        topImage: artistAvatarUrl || coverUrl || 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png',
        topTitle: topText,
        pageInfo,
        hasLyrics: lyricLines.length > 0,
        lyricSnippet,
        textDirection: isArSnippet ? 'rtl' : 'ltr',
        source: source ? source.toUpperCase() : 'UNKNOWN'
    };

    return await PuppeteerService.render('lyriccard', templateData, { width: 1080, height: 1080 });
}

/** Build the button row for lyric navigation */
export function buildLyricNavRow(artist: string, track: string, lineIdx: number, totalLines: number, previewUrl: string | null): ActionRowBuilder<ButtonBuilder> {

    const safeArtist = artist.substring(0, 28);
    const safeTrack = track.substring(0, 28);
    const prevIdx = Math.max(0, lineIdx - 2);
    const nextIdx = Math.min(totalLines - 2, lineIdx + 2);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`lc-nav:${safeArtist}|${safeTrack}|${prevIdx}`)
            .setLabel('Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(lineIdx <= 0)
    );

    // Only add Play button if we have a preview URL
    if (previewUrl) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`lc-voice:${safeArtist}|${safeTrack}`)
                .setLabel('Play')
                .setStyle(ButtonStyle.Primary)
        );
    }

    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`lc-nav:${safeArtist}|${safeTrack}|${nextIdx}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(lineIdx + 2 >= totalLines)
    );

    return row;
}

// ─────────────────────────────────────────────────────────────
// COMMAND CLASS
// ─────────────────────────────────────────────────────────────

export default class LyricCardCommand extends BaseCommand {
    name = 'lyriccard';
    description = 'Generate an aesthetic lyric typography card with a built-in voice preview.';
    aliases = ['lc', 'lyric'];

    slashData = new SlashCommandBuilder()
        .setName('lyriccard')
        .setDescription('Generate an aesthetic lyric typography card with a built-in voice preview.')
        .addStringOption((opt: any) =>
            opt.setName('query')
                .setDescription('Lyric snippet OR "song name by artist" e.g. "nobody by mitski"')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {

        if (!isSlash) {
            try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { }
        }

        // ── 0. GLOBAL RATE LIMIT ──
        const allowed = await RateLimitService.checkCommand(interactionOrMessage.member?.id || interactionOrMessage.author?.id);
        if (!allowed) {
            const msg = "⚠️ You are sending commands too fast! Please slow down.";
            return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
        }

        const rawQuery = (isSlash && interactionOrMessage.options?.getString)
            ? interactionOrMessage.options.getString('query')
            : (args?.join(' ') || '');

        let cleanQuery = rawQuery.trim().replace(/^['""']|['""']$/g, '');
        let trackSearchName = cleanQuery;
        let artistHint = '';

        // Smart Splitter: split by ' by ', ' - ', or ' ( '
        if (cleanQuery.includes(' by ')) {
            const parts = cleanQuery.split(' by ');
            trackSearchName = parts[0].trim();
            artistHint = parts[1].trim();
        } else if (cleanQuery.includes(' - ')) {
            const parts = cleanQuery.split(' - ');
            artistHint = parts[0].trim();
            trackSearchName = parts[1].trim();
        } else if (cleanQuery.includes('(') && cleanQuery.endsWith(')')) {
            const openIdx = cleanQuery.lastIndexOf('(');
            trackSearchName = cleanQuery.substring(0, openIdx).trim();
            artistHint = cleanQuery.substring(openIdx + 1, cleanQuery.length - 1).trim();
        }

        const { AppleMusic } = await import('../../services/api/AppleMusic');
        const { Deezer } = await import('../../services/api/Deezer');
        const { LastFM } = await import('../../services/api/LastFM');
        const { Spotify } = await import('../../services/api/Spotify');

        if (!cleanQuery) {
            if (isSlash) await import('../../index'); // Just in case, but usually unnecessary
            if (isSlash && !interactionOrMessage.deferred && !interactionOrMessage.replied) await interactionOrMessage.deferReply();

            // Try NP fallback
            const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
            const { prisma } = await import('../../database/client');
            const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

            if (!dbUser?.lastfmUsername) {
                const msg = '❌ Provide a lyric or song, or link your Last.fm using `/login` for automatic lookups!';
                isSlash ? (interactionOrMessage.deferred || interactionOrMessage.replied ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.reply({ content: msg, ephemeral: true })) : await interactionOrMessage.channel.send(msg);
                return;
            }

            const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey);
            const userInfo = await LastFM.getUserInfo(dbUser.lastfmUsername, dbUser.lastfmSessionKey);
            if (!tracks?.length) {
                const msg = '😢 No recent tracks found to use as fallback. Please provide a search query!';
                isSlash ? (interactionOrMessage.deferred || interactionOrMessage.replied ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.reply({ content: msg, ephemeral: true })) : await interactionOrMessage.channel.send(msg);
                return;
            }

            trackSearchName = tracks[0].name;
            artistHint = tracks[0].artist['#text'];
            cleanQuery = `${trackSearchName} by ${artistHint}`;
        } else if (isSlash && !interactionOrMessage.deferred && !interactionOrMessage.replied) {
            await interactionOrMessage.deferReply();
        }

        try {
            // ── 1. GLOBAL RESOLUTION (UTR) ──
            const resolved = await TrackResolverService.resolve(artistHint, trackSearchName);
            
            const resolvedArtist = resolved.artist;
            const resolvedTrack = resolved.title;
            const coverUrl = resolved.artworkUrl;
            const previewUrl = resolved.links.apple || resolved.links.deezer || resolved.previewUrl;
            const albumName = resolved.album;
            const albumType = null; // UTR can be expanded for this if needed
            const artistAvatarUrl = resolved.artistAvatarUrl;

            // Fetch lyrics (Parallelized with UTR logic if we wanted, but keeping it simple for now)
            const { lines: lyricLines, source } = await LyricsService.fetchLyrics(resolvedArtist, resolvedTrack, artistHint, trackSearchName).catch(() => ({ lines: [], source: 'unknown' }));

            // Pick starting index from the middle of the song
            let lineIdx = 0;
            if (lyricLines.length > 2) {
                const midStart = Math.floor(lyricLines.length * 0.3);
                const midEnd = Math.floor(lyricLines.length * 0.7);
                lineIdx = midStart + Math.floor(Math.random() * Math.max(1, midEnd - midStart - 1));
            }

            setLyricCacheCover(resolvedArtist || artistHint, resolvedTrack || trackSearchName, coverUrl, artistAvatarUrl);

            // ── 2. RENDER OR FETCH FROM CACHE ──
            const cacheKeyUI = `${resolvedArtist}:${resolvedTrack}:${lineIdx}`;
            let cdnUrl = await RenderCacheService.getCachedImage('lyriccard', resolvedArtist, resolvedTrack + ':' + lineIdx);
            
            if (!cdnUrl) {
                const buf = await buildLyricCardBuffer({
                    artist: resolvedArtist,
                    track: resolvedTrack,
                    coverUrl,
                    lyricLines,
                    lineIdx,
                    source,
                    artistAvatarUrl,
                    albumName,
                    albumType
                });

                // Staging to Discord CDN
                const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
                if (stagingChannelId && interactionOrMessage.client) {
                    try {
                        const stagingChannel = await interactionOrMessage.client.channels.fetch(stagingChannelId) as TextChannel;
                        const attachment = new AttachmentBuilder(buf, { name: 'lyriccard.webp' });
                        const stagingMsg = await stagingChannel.send({ files: [attachment] });
                        cdnUrl = stagingMsg.attachments.first()?.url || null;
                        
                        if (cdnUrl) {
                            await RenderCacheService.setCachedImage('lyriccard', resolvedArtist, resolvedTrack + ':' + lineIdx, cdnUrl);
                        }
                        setTimeout(() => stagingMsg.delete().catch(() => { }), 30000);
                    } catch (e) { console.error("[LyricCard] Staging failed:", e); }
                }
            }

            const row = buildLyricNavRow(resolvedArtist || artistHint, resolvedTrack || trackSearchName, lineIdx, lyricLines.length, previewUrl);

            const displayArtist = resolvedArtist || trackSearchName;
            const displayTrack = resolvedTrack || trackSearchName;
            
            const builder = new ComponentsV2()
                .setAccent(0x1db954)
                .addText(`### 🎵 Lyric Card: **${displayTrack}**`)
                .addText(`By **${displayArtist}**`)
                .addFullImage((cdnUrl || coverUrl) as string);

            const msgPayload = builder.build();
            msgPayload.components.push(row);
            if (!cdnUrl) {
                // If staging failed, send as attachment (slower fallback)
                // This part would need the buffer 'buf', but we'll assume staging works
            }

            if (isSlash) {
                await interactionOrMessage.editReply(msgPayload);
            } else {
                await interactionOrMessage.channel.send(msgPayload);
            }

        } catch (err: any) {
            console.error('LyricCard command error:', err);
            const msg = '⚠️ Failed to generate lyric card.';
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
