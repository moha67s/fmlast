import { BaseCommand } from '../../structures/BaseCommand';
import { AttachmentBuilder, SlashCommandBuilder, TextChannel, ChannelType } from 'discord.js';
import { Spotify } from '../../services/api/Spotify';
import { AppleMusic } from '../../services/api/AppleMusic';
import { Deezer } from '../../services/api/Deezer';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { config } from '../../../config';
import axios from 'axios';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { resolveTargetUser } from '../../utils/userResolver';
import { StatsService } from '../../services/bot/StatsService';

// ═══════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════

interface EraEntry {
    label: string;         // e.g. "2022" or "Mar 2023"
    topArtist: string;
    topTrack: string;
    topGenres: string[];
    coverUrl: string | null;
    playcount: number;
    eraName: string;        // e.g. "Your Indie Phase 🌿"
}

// ═══════════════════════════════════════════════════════
// ERA NAMER
// ═══════════════════════════════════════════════════════

function nameEra(genres: string[]): string {
    const g = genres.map(s => s.toLowerCase());
    const check = (...tags: string[]) => tags.some(t => g.some(gi => gi.includes(t)));

    if (check('electronic', 'edm', 'house', 'techno', 'synthwave')) return 'Electric Era ⚡';
    if (check('hip-hop', 'rap', 'trap', 'drill')) return 'Street Era 🎤';
    if (check('indie', 'alternative', 'indie pop', 'dream pop')) return 'Indie Phase 🌿';
    if (check('pop')) return 'Pop Era 🌟';
    if (check('rock', 'hard rock', 'classic rock')) return 'Rock Era 🎸';
    if (check('metal', 'heavy metal', 'metalcore', 'death metal')) return 'Dark Era 💀';
    if (check('r&b', 'soul', 'rnb')) return 'Soul Era 🕯️';
    if (check('jazz', 'blues', 'bossa nova')) return 'Jazz Phase 🎷';
    if (check('classical', 'orchestral', 'ambient')) return 'Quiet Era 🎼';
    if (check('lo-fi', 'chillhop', 'chill')) return 'Chill Phase 🌙';
    if (check('country', 'folk', 'americana')) return 'Folk Phase 🪕';
    if (check('reggae', 'dancehall', 'afrobeat')) return 'Groove Era 🌴';
    if (check('punk', 'emo', 'post-punk')) return 'Rebel Era 🔥';
    if (check('kpop', 'k-pop')) return 'K-Pop Era 🌸';
    if (check('arabic', 'arab', 'khaleeji', 'shaabi')) return 'Arabic Era 🌙';
    return 'Discovery Era 🔭';
}

// ═══════════════════════════════════════════════════════
// ERA COLOR ACCENTS
// ═══════════════════════════════════════════════════════

function eraColor(name: string): string {
    if (name.includes('⚡')) return '#7ef0ff';
    if (name.includes('🎤')) return '#ffcf6e';
    if (name.includes('🌿')) return '#90f0a0';
    if (name.includes('🌟')) return '#ffaadd';
    if (name.includes('🎸')) return '#ff9060';
    if (name.includes('💀')) return '#c87cff';
    if (name.includes('🕯️')) return '#ffb060';
    if (name.includes('🎷')) return '#60d0ff';
    if (name.includes('🎼')) return '#d0d0ff';
    if (name.includes('🌙')) return '#7090ff';
    if (name.includes('🪕')) return '#e0b080';
    if (name.includes('🌴')) return '#70e0a0';
    if (name.includes('🔥')) return '#ff6060';
    if (name.includes('🌸')) return '#ffaacc';
    if (name.includes('🔭')) return '#aaffee';
    return '#ffffff';
}

// ═══════════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════════

export default class TimelineCommand extends BaseCommand {
    name = 'timeline';
    description = 'Visualise how your music taste evolved over time with an era-by-era journey card.';
    aliases = ['eras', 'journey', 'musichistory'];

    slashData = new SlashCommandBuilder()
        .setName('timeline')
        .setDescription('See how your music taste evolved over time — era by era.')
        .addStringOption((opt: any) =>
            opt.setName('view')
                .setDescription('Show yearly or monthly breakdown')
                .setRequired(false)
                .addChoices(
                    { name: 'Yearly (default)', value: 'yearly' },
                    { name: 'Monthly (recent 6 months)', value: 'monthly' }
                )
        )
        .addUserOption((opt: any) =>
            opt.setName('user').setDescription('View another user\'s music timeline').setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        if (!isSlash) {
            try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { }
        }

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;

        let view = 'yearly';
        let requestedYear: number | null = null;

        if (isSlash) {
            view = interactionOrMessage.options.getString('view') || 'yearly';
        } else if (args && args.length > 0) {
            const joinedArgs = args.join(' ').toLowerCase();
            if (joinedArgs.includes('month')) view = 'monthly';
            
            // Year Detection (e.g. 2024)
            const yearMatch = joinedArgs.match(/\b(20\d{2}|19\d{2})\b/);
            if (yearMatch) {
                requestedYear = parseInt(yearMatch[1]);
                view = 'monthly'; // Force monthly for specific year requests
            }
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser?.lastfmUsername || !dbUser?.lastfmSessionKey) {
            const isSelf = userId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
            const msg = isSelf 
                ? '❌ You are not linked to Last.fm yet.\nRun `/login` or `+login` first!'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            return this.replyError(interactionOrMessage, isSlash, msg);
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { } }

        try {
            const userInfo = await LastFM.getUserInfo(dbUser.lastfmUsername, dbUser.lastfmSessionKey);
            const eras: EraEntry[] = [];

            // --- DATA RANGE RESOLUTION ---
            let fromDate: Date | undefined;
            let toDate: Date | undefined;
            if (requestedYear) {
                fromDate = new Date(requestedYear, 0, 1);
                toDate = new Date(requestedYear, 11, 31, 23, 59, 59);
            }

            // ── NEW INDEXED LOGIC ──
            const limit = requestedYear ? 12 : (view === 'monthly' ? 6 : 10);
            const dbEras = await StatsService.getEras(dbUser.id, view === 'monthly' ? 'month' : 'year', limit, fromDate, toDate);
            
            if (dbEras.length > 0) {
                // We have local scrobbles! Use them for a super fast experience.
                const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                
                // Sort by date ascending for a chronological timeline if it's a specific year
                const sortedEras = requestedYear ? [...dbEras].sort((a, b) => a.era_start.getTime() - b.era_start.getTime()) : dbEras;

                for (const dbEra of sortedEras) {
                    const label = view === 'monthly' 
                        ? `${monthNames[dbEra.era_start.getMonth()]} ${dbEra.era_start.getFullYear()}`
                        : `${dbEra.era_start.getFullYear()}`;
                    
                    const topArtist = dbEra.artist_name;

                    // Genre detection (Try DB first)
                    let genres: string[] = [];
                    try {
                        const dbArtist = await prisma.artist.findFirst({
                            where: { name: { equals: topArtist, mode: 'insensitive' } },
                            include: { tags: { include: { tag: true }, take: 3 } }
                        });
                        if (dbArtist && dbArtist.tags.length > 0) {
                            genres = dbArtist.tags.map(t => t.tag.name);
                        } else {
                            const tags = await LastFM.getArtistTopTags(topArtist);
                            genres = tags.slice(0, 3).map((t: any) => t.name);
                        }
                    } catch { }

                    // Cover art resolution
                    let coverUrl: string | null = null;
                    try {
                        coverUrl = await Spotify.getArtistCover(topArtist);
                        if (!coverUrl) {
                            const dzCover = await Deezer.getArtistCover(topArtist);
                            if (dzCover) coverUrl = dzCover;
                        }
                    } catch { }

                    eras.push({
                        label,
                        topArtist,
                        topTrack: '', // Less critical for timeline
                        topGenres: genres,
                        coverUrl,
                        playcount: dbEra.playcount,
                        eraName: nameEra(genres)
                    });
                }
            } else {
                // FALLBACK: Use API logic (Old way)
                if (view === 'monthly') {
                    const now = new Date();
                    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    for (let i = 5; i >= 0; i--) {
                        try {
                            const dStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
                            const dEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
                            const from = Math.floor(dStart.getTime() / 1000);
                            const to = Math.floor(dEnd.getTime() / 1000);
                            const label = `${monthNames[dStart.getMonth()]} ${dStart.getFullYear()}`;
                            const artists = await LastFM.getWeeklyArtistChart(dbUser.lastfmUsername, from, to, 10, dbUser.lastfmSessionKey);
                            if (!artists?.length) continue;
                            const topArtist = artists[0]?.name || 'Unknown';
                            let genres: string[] = [];
                            try {
                                const tags = await LastFM.getArtistTopTags(topArtist);
                                genres = tags.slice(0, 3).map((t: any) => t.name);
                            } catch { }
                            let coverUrl = await Spotify.getArtistCover(topArtist);
                            const totalPlaycount = artists.reduce((sum: number, a: any) => sum + (parseInt(a.playcount) || 0), 0);
                            eras.push({ label, topArtist, topTrack: '', topGenres: genres, coverUrl, playcount: totalPlaycount, eraName: nameEra(genres) });
                        } catch { }
                    }
                } else {
                    const periodDefs = [{ label: 'All Time', period: 'overall' }, { label: 'Last Year', period: '12month' }, { label: '6 Months', period: '6month' }, { label: '3 Months', period: '3month' }, { label: 'Last Month', period: '1month' }, { label: 'This Week', period: '7day' }];
                    for (const def of periodDefs) {
                        try {
                            const artists = await LastFM.getTopArtists(dbUser.lastfmUsername, def.period, 5, dbUser.lastfmSessionKey);
                            if (!artists?.length) continue;
                            const topArtist = artists[0]?.name || 'Unknown';
                            let genres: string[] = [];
                            try {
                                const tags = await LastFM.getArtistTopTags(topArtist);
                                genres = tags.slice(0, 3).map((t: any) => t.name);
                            } catch { }
                            let coverUrl = await Spotify.getArtistCover(topArtist);
                            const totalPlaycount = artists.reduce((sum: number, a: any) => sum + (parseInt(a.playcount) || 0), 0);
                            eras.push({ label: def.label, topArtist, topTrack: '', topGenres: genres, coverUrl, playcount: totalPlaycount, eraName: nameEra(genres) });
                        } catch { }
                    }
                }
            }

            if (eras.length === 0) {
                const msg = '😢 Not enough listening history to build a timeline. Listen to more music first!';
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.channel.send(msg);
                return;
            }

            // ══════════════════════════════════════
            // PUPPETEER RENDERING
            // ══════════════════════════════════════
            const CARD_W = 210;
            const PADDING = 30;
            const HEADER_H = 160;
            const FOOTER_H = 60;
            const GAP = 30;

            const totalCols = eras.length;
            const width = PADDING * 2 + totalCols * CARD_W + (totalCols - 1) * GAP + 80; // Extra side padding
            const height = HEADER_H + 400 + FOOTER_H; // Fixed height approx

            const userObjA = targetUser;
            const avatarUrl = userObjA.displayAvatarURL({ extension: 'png', size: 128 });

            let viewLabel = (view === 'monthly' ? 'MUSIC TIMELINE  ·  LAST 6 MONTHS' : 'MUSIC TIMELINE  ·  YEARLY JOURNEY').toUpperCase();
            if (requestedYear) viewLabel = `MUSIC TIMELINE  ·  YEAR ${requestedYear}`;

            const templateData = {
                width,
                height,
                displayName: (userObjA.globalName || userObjA.displayName || userObjA.username).toUpperCase(),
                username: dbUser.lastfmUsername,
                playcount: Number(userInfo?.playcount || 0).toLocaleString(),
                avatarUrl,
                viewLabel,
                eras: eras.map(e => ({
                    ...e,
                    color: eraColor(e.eraName),
                    plays: e.playcount.toLocaleString()
                }))
            };

            const buffer = await PuppeteerService.render('timeline', templateData, { width, height });

            // ── Upload via staging channel ──
            let cdnUrl: string | null = null;
            const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
            if (stagingChannelId && interactionOrMessage.client) {
                try {
                    const stagingChannel = await interactionOrMessage.client.channels.fetch(stagingChannelId) as TextChannel;
                    if (stagingChannel?.type === ChannelType.GuildText) {
                        const att = new AttachmentBuilder(buffer, { name: 'timeline.webp' });
                        const msg = await stagingChannel.send({ files: [att] });
                        cdnUrl = msg.attachments.first()?.url || null;
                        setTimeout(() => msg.delete().catch(() => { }), 30000);
                    }
                } catch (e) {
                    console.warn('⚠️ Timeline staging failed:', e);
                }
            }

            // ── Build shift label ──
            const biggestShift = detectBiggestEraShift(eras);
            const displayNameText = userObjA.globalName || userObjA.displayName || userObjA.username;

            const contentLines = [
                `### 🎵 Music Timeline — ${displayNameText}`,
                `Your taste across **${eras.length}** ${view === 'monthly' ? 'months' : 'years'} · **${Number(userInfo?.playcount || 0).toLocaleString()}** total scrobbles`,
                biggestShift
                    ? `-# Biggest vibe shift: **${biggestShift}**`
                    : `-# ${dbUser.lastfmUsername} on Last.fm`
            ];

            const contentText = contentLines.join('\n');
            const builder = new ComponentsV2().setAccent(0x8050ff);

            if (cdnUrl) {
                builder.addMedia(cdnUrl, `${displayNameText}'s music timeline`)
                    .addText(contentText)
                    .addSeparator()
                    .addLinkButton("-# View full library", "Last.fm Profile", `https://www.last.fm/user/${dbUser.lastfmUsername}`, { name: '🎵' });

                const payload = builder.build();
                isSlash ? await interactionOrMessage.editReply(payload) : await interactionOrMessage.channel.send(payload);
            } else {
                const payload: any = {
                    content: contentText,
                    files: [new AttachmentBuilder(buffer, { name: 'timeline.webp' })],
                    flags: 32768
                };
                isSlash ? await interactionOrMessage.editReply(payload) : await interactionOrMessage.channel.send(payload);
            }

        } catch (err: any) {
            console.error('[timeline] error:', err);
            const msg = `❌ ${err.message || 'Failed to generate your music timeline.'}`;
            if (isSlash) {
                if (interactionOrMessage.deferred || interactionOrMessage.replied) {
                    await interactionOrMessage.editReply({ content: msg });
                } else {
                    await interactionOrMessage.reply({ content: msg, ephemeral: true });
                }
            } else {
                await interactionOrMessage.channel.send(msg);
            }
        }
    }

    private async replyError(interactionOrMessage: any, isSlash: boolean, msg: string): Promise<void> {
        const payload = new ComponentsV2()
            .setAccent(0xff0000)
            .addText(msg)
            .build();

        if (isSlash) {
            if (interactionOrMessage.deferred || interactionOrMessage.replied) {
                await interactionOrMessage.editReply({ ...payload, ephemeral: true });
            } else {
                await interactionOrMessage.reply({ ...payload, ephemeral: true });
            }
        } else {
            await interactionOrMessage.channel.send(payload);
        }
    }
}

/** Find the most interesting era-name shift in a timeline */
function detectBiggestEraShift(eras: EraEntry[]): string | null {
    if (eras.length < 2) return null;
    for (let i = 1; i < eras.length; i++) {
        if (eras[i].eraName !== eras[i - 1].eraName) {
            return `${eras[i - 1].eraName} → ${eras[i].eraName}`;
        }
    }
    return null;
}
