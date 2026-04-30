// src/commands/lastfm/songtwin.ts
import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Deezer } from '../../services/api/Deezer';
import { AppleMusic } from '../../services/api/AppleMusic';
import { Spotify } from '../../services/api/Spotify';
import { prisma } from '../../database/client';
import { AttachmentBuilder, SlashCommandBuilder, TextChannel, ChannelType } from 'discord.js';
import { config } from '../../../config';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { ArtistMetadataService } from '../../services/external/ArtistMetadataService';
import { TrackResolverService } from '../../services/api/TrackResolverService';

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/** Compute Weighted Pro Compatibility between two artist/track lists */
function computeWeightedCompatibility(listA: any[], listB: any[]): number {
    if (!listA.length || !listB.length) return 0;

    const mapA = new Map(listA.map((item, i) => [
        (item.name || item.text || '').toLowerCase().trim(),
        { playcount: parseInt(item.playcount || '1'), rank: i + 1 }
    ]));
    const mapB = new Map(listB.map((item, i) => [
        (item.name || item.text || '').toLowerCase().trim(),
        { playcount: parseInt(item.playcount || '1'), rank: i + 1 }
    ]));

    const maxRank = Math.max(listA.length, listB.length, 100);
    let totalWeight = 0;
    let sharedWeight = 0;

    // Weighting parameters
    const getRankWeight = (rank: number) => Math.pow((maxRank - rank + 1) / maxRank, 2); // Quadratic decay

    // Process List A
    for (const [name, infoA] of mapA) {
        const rWeightA = getRankWeight(infoA.rank);
        const infoB = mapB.get(name);

        if (infoB) {
            const rWeightB = getRankWeight(infoB.rank);
            // Intensity match: How similar are the scrobble counts?
            const intensity = Math.min(infoA.playcount, infoB.playcount) / Math.max(infoA.playcount, infoB.playcount);
            
            // Shared weight = Average of rank weights * (base similarity + intensity bonus)
            sharedWeight += ((rWeightA + rWeightB) / 2) * (0.4 + 0.6 * intensity);
        }
        totalWeight += rWeightA;
    }

    // Add weights for B's unique items to the denominator
    for (const [name, infoB] of mapB) {
        if (!mapA.has(name)) {
            totalWeight += getRankWeight(infoB.rank);
        }
    }

    if (totalWeight === 0) return 0;
    const rawOverlap = (sharedWeight / totalWeight) * 100;

    // Apply a logarithmic "Friendship Curve" 
    // This ensures that even a 15% raw overlap (which is huge in music) feels meaningful (~40%)
    const boosted = Math.pow(rawOverlap / 100, 0.45) * 100;
    return Math.min(100, Math.round(boosted));
}

/** Get top artist names from a list */
function getArtistNames(artists: any[]): string[] {
    return artists.map(a => a.name).filter(Boolean);
}



// ═══════════════════════════════════════════════════════
// COMMAND
// ═══════════════════════════════════════════════════════

export default class SongTwinCommand extends BaseCommand {
    name = 'songtwin';
    description = 'Compare music taste with another user and see your sonic compatibility score.';
    aliases = ['twin', 'compare', 'musicmatch'];

    slashData = new SlashCommandBuilder()
        .setName('songtwin')
        .setDescription('Compare music taste with another user and see your compatibility score.')
        .addUserOption((opt: any) =>
            opt.setName('user')
                .setDescription('The Discord user to compare with (leave empty to compare with the server)')
                .setRequired(false)
        )
        .addStringOption((opt: any) =>
            opt.setName('period')
                .setDescription('Time period to compare')
                .setRequired(false)
                .addChoices(
                    { name: 'Week', value: '7day' },
                    { name: 'Month', value: '1month' },
                    { name: 'Year', value: '12month' },
                    { name: 'All Time', value: 'overall' }
                )
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {

        if (!isSlash) {
            try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { }
        }

        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

        let period = '7day';
        if (isSlash) {
            period = interactionOrMessage.options.getString('period') || '7day';
        } else if (args && args.length > 0) {
            const joinedArgs = args.join(' ').toLowerCase();
            if (joinedArgs.includes('overall') || joinedArgs.includes('alltime') || joinedArgs.includes('all')) period = 'overall';
            else if (joinedArgs.includes('12month') || joinedArgs.includes('year')) period = '12month';
            else if (joinedArgs.includes('6month') || joinedArgs.includes('half')) period = '6month';
            else if (joinedArgs.includes('3month')) period = '3month';
            else if (joinedArgs.includes('1month') || joinedArgs.includes('month')) period = '1month';
            else period = '7day';
        }

        // ── Get initiating user ──
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser?.lastfmUsername || !dbUser?.lastfmSessionKey) {
            return this.replyError(interactionOrMessage, isSlash,
                '❌ You are not linked to Last.fm yet.\nRun `/login` or `+login` first!');
        }

        // ── Get target user ──
        let targetDiscordId: string | undefined = undefined;
        let targetDbUser: any = null;

        if (isSlash) {
            const targetUser = interactionOrMessage.options.getUser('user');
            if (targetUser) {
                targetDiscordId = targetUser.id;
                targetDbUser = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
                if (!targetDbUser?.lastfmUsername) {
                    return this.replyError(interactionOrMessage, isSlash,
                        `❌ **${targetUser.username}** hasn't linked their Last.fm account yet.`);
                }
            }
        } else if (args && args.length > 0) {
            // Prefix: try mention or last.fm username
            const mention = interactionOrMessage.mentions?.users?.first();
            if (mention) {
                targetDiscordId = mention.id;
                targetDbUser = await prisma.user.findUnique({ where: { discordId: mention.id } });
                if (!targetDbUser?.lastfmUsername) {
                    return this.replyError(interactionOrMessage, isSlash,
                        `❌ **${mention.username}** hasn't linked their Last.fm account yet.`);
                }
            }
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { } }

        try {
            // ── Fetch data for both users ── depth increased to 100 for Pro Accuracy
            const artistsA = await LastFM.getTopArtists(dbUser.lastfmUsername, period, 100, dbUser.lastfmSessionKey).catch(() => []);
            const topTracksA = await LastFM.getTopTracks(dbUser.lastfmUsername, period, 100, dbUser.lastfmSessionKey).catch(() => []);
            let userInfoA = await LastFM.getUserInfo(dbUser.lastfmUsername, dbUser.lastfmSessionKey).catch(() => null);
            if (!userInfoA) userInfoA = await LastFM.getUserInfo(dbUser.lastfmUsername).catch(() => null);

            const artistsB = targetDbUser
                ? await LastFM.getTopArtists(targetDbUser.lastfmUsername, period, 100, targetDbUser.lastfmSessionKey).catch(() => [])
                : [] as any[];
            const topTracksB = targetDbUser
                ? await LastFM.getTopTracks(targetDbUser.lastfmUsername, period, 100, targetDbUser.lastfmSessionKey).catch(() => [])
                : [] as any[];
            const topAlbumsA = await LastFM.getTopAlbums(dbUser.lastfmUsername, period, 30, dbUser.lastfmSessionKey).catch(() => []);
            const topAlbumsB = targetDbUser
                ? await LastFM.getTopAlbums(targetDbUser.lastfmUsername, period, 30, targetDbUser.lastfmSessionKey).catch(() => [])
                : [] as any[];

            const userInfoB = targetDbUser
                ? await LastFM.getUserInfo(targetDbUser.lastfmUsername, targetDbUser.lastfmSessionKey).catch(() => null)
                : null;

            const namesA = getArtistNames(artistsA);
            const namesB = getArtistNames(artistsB);

            // ── Shared / Unique artists ──
            const sharedArtists = namesA.filter(n => namesB.map(b => b.toLowerCase()).includes(n.toLowerCase())).slice(0, 6);
            const uniqueToA = namesA.filter(n => !namesB.map(b => b.toLowerCase()).includes(n.toLowerCase())).slice(0, 3);
            const uniqueToB = namesB.filter(n => !namesA.map(a => a.toLowerCase()).includes(n.toLowerCase())).slice(0, 3);

            // ── New Weighted Pro Compatibility score ──
            const artistScore = computeWeightedCompatibility(artistsA, artistsB);
            const trackScore = computeWeightedCompatibility(topTracksA, topTracksB);
            const compatScore = Math.round((artistScore * 0.7) + (trackScore * 0.3));

            // ── Bridge tracks recommendation (one per shared artist, up to 7) ──
            const bridgeTracks: { track: string; artist: string; cover: string | null }[] = [];

            const bridgePool = sharedArtists.slice(0, 7);
            for (const chosen of bridgePool) {
                try {
                    // 1. Find tracks by this artist that BOTH users have in their top lists
                    const sharedInUserHistory = topTracksA.filter(ta =>
                        ta.artist?.name?.toLowerCase() === chosen.toLowerCase() &&
                        topTracksB.some(tb => tb.name.toLowerCase() === ta.name.toLowerCase() && tb.artist?.name?.toLowerCase() === chosen.toLowerCase())
                    );

                    // 2. Find tracks by this artist that AT LEAST one user has
                    const eitherInUserHistory = [
                        ...topTracksA.filter(ta => ta.artist?.name?.toLowerCase() === chosen.toLowerCase()),
                        ...topTracksB.filter(tb => tb.artist?.name?.toLowerCase() === chosen.toLowerCase())
                    ];

                    // Unique tracks from history
                    const historyTracks = [...new Map([...sharedInUserHistory, ...eitherInUserHistory].map(t => [t.name.toLowerCase(), t])).values()];

                    // 3. Fallback to global top tracks if history is empty
                    const globalTop = historyTracks.length > 0 ? [] : await LastFM.getArtistTopTracks(chosen, 5);

                    const candidateTracks = [...historyTracks, ...globalTop];

                    if (candidateTracks.length > 0) {
                        let cover: string | null = null;
                        let source = 'none';
                        let trackName = '';

                        // ── GLOBAL RESOLUTION (UTR) ──
                        for (let i = 0; i < Math.min(candidateTracks.length, 5); i++) {
                            const pick = candidateTracks[i];
                            const res = await TrackResolverService.resolve(chosen, pick.name);
                            if (res.artworkUrl) {
                                cover = res.artworkUrl;
                                source = res.source;
                                trackName = res.title;
                                break;
                            }
                        }


                        if (cover && trackName) {
                            console.log(`[songtwin] Resolved Bridge Track: ${chosen} — ${trackName} (${source})`);
                            bridgeTracks.push({ track: trackName, artist: chosen, cover });
                        }
                    }
                } catch { }
            }

            // ── Name & display info ──
            const userObjA = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
            let displayNameA = userObjA.globalName || userObjA.displayName || userObjA.username;
            const usernameA = dbUser.lastfmUsername;

            // Use server nickname if possible (User A)
            if (interactionOrMessage.guild) {
                try {
                    const memberA = await interactionOrMessage.guild.members.fetch(userId);
                    displayNameA = memberA.displayName;
                } catch { }
            }

            const guildName = interactionOrMessage.guild?.name || 'Server';
            let displayNameB = targetDbUser?.lastfmUsername || guildName;
            const usernameB = targetDbUser?.lastfmUsername || 'server';

            const avatarAUrl = userObjA.displayAvatarURL({ extension: 'png', size: 256 });

            let avatarBUrl = 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
            if (targetDiscordId) {
                try {
                    const targetUserObj = await interactionOrMessage.client.users.fetch(targetDiscordId);
                    avatarBUrl = targetUserObj.displayAvatarURL({ extension: 'png', size: 256 });

                    if (interactionOrMessage.guild) {
                        try {
                            const memberB = await interactionOrMessage.guild.members.fetch(targetDiscordId);
                            displayNameB = memberB.displayName;
                        } catch {
                            displayNameB = targetUserObj.globalName || targetUserObj.displayName || targetUserObj.username;
                        }
                    } else {
                        displayNameB = targetUserObj.globalName || targetUserObj.displayName || targetUserObj.username;
                    }
                } catch { }
            }

            // ── Background Selection Logic ──
            const bgPool: { name: string; artist?: string; type: 'artist' | 'track' | 'album' }[] = [];
            artistsA.slice(0, 5).forEach(a => bgPool.push({ name: a.name, type: 'artist' }));
            artistsB.slice(0, 5).forEach(a => bgPool.push({ name: a.name, type: 'artist' }));
            topTracksA.slice(0, 5).forEach(t => bgPool.push({ name: t.name, artist: t.artist?.name, type: 'track' }));
            topTracksB.slice(0, 5).forEach(t => bgPool.push({ name: t.name, artist: t.artist?.name, type: 'track' }));
            topAlbumsA.slice(0, 5).forEach(a => bgPool.push({ name: a.name, artist: a.artist?.name, type: 'album' }));
            topAlbumsB.slice(0, 5).forEach(a => bgPool.push({ name: a.name, artist: a.artist?.name, type: 'album' }));

            // ── Prepare Data for Puppeteer ──
            const periodLabelMap: Record<string, string> = {
                '7day': 'the last 7 days',
                '1month': 'the last month',
                '12month': 'the last year',
                'overall': 'all time'
            };
            const periodLabelText = periodLabelMap[period] || 'LAST 7 DAYS';

            // ── Build score label ──
            const scoreLabel = compatScore >= 85 ? 'SONIC SOULMATES'
                : compatScore >= 70 ? 'GENRE TWINS'
                    : compatScore >= 50 ? 'PARALLEL LISTENERS'
                        : compatScore >= 30 ? 'COMMON GROUND'
                            : compatScore >= 15 ? 'DISTANT COUSINS'
                                : 'COMPLETE OPPOSITES';

            const renderData = {
                bgUrl: '', // Will populate below
                userA: {
                    avatarUrl: avatarAUrl,
                    displayName: displayNameA,
                    username: usernameA,
                    scrobbles: userInfoA?.playcount ? `${Number(userInfoA.playcount).toLocaleString()}` : '0',
                    topArtists: namesA.slice(0, 8).map((name, i) => ({
                        rank: i + 1,
                        name: truncate(name, 26),
                        isShared: namesB.some(b => b.toLowerCase().trim() === name.toLowerCase().trim())
                    }))
                },
                userB: {
                    avatarUrl: avatarBUrl,
                    displayName: displayNameB,
                    username: usernameB,
                    scrobbles: targetDbUser && userInfoB?.playcount ? `${Number(userInfoB.playcount).toLocaleString()}` : '0',
                    topArtists: namesB.slice(0, 8).map((name, i) => ({
                        rank: i + 1,
                        name: truncate(name, 26),
                        isShared: namesA.some(a => a.toLowerCase().trim() === name.toLowerCase().trim())
                    }))
                },
                compatScore,
                compatColor: compatScore >= 85 ? '#f0d060' : compatScore >= 70 ? '#ff8c5f' : compatScore >= 45 ? '#a875ff' : '#f07a7a',
                scoreLabel,
                sharedArtists: sharedArtists.slice(0, 8),
                bridgeTracks: bridgeTracks.slice(0, 5).map(t => ({
                    track: truncate(t.track, 25),
                    artist: truncate(t.artist, 20),
                    coverUrl: t.cover
                })),
                periodLabel: periodLabelText.toUpperCase()
            };

            // ── Mosaic Background ──
            const mosaicPool = [
                ...topAlbumsA.map(a => a.image?.[2]?.['#text'] || a.image?.[1]?.['#text']).filter(Boolean),
                ...topAlbumsB.map(a => a.image?.[2]?.['#text'] || a.image?.[1]?.['#text']).filter(Boolean),
                ...bridgeTracks.map(t => t.cover).filter(Boolean)
            ];
            // Fill with randoms if needed or just shuffle and repeat
            const shuffledMosaic = [...mosaicPool].sort(() => Math.random() - 0.5).slice(0, 20);
            (renderData as any).mosaicCovers = shuffledMosaic;
            console.log(`[songtwin] Generated mosaic with ${shuffledMosaic.length} covers.`);

            // ── Background URL ──
            if (bgPool.length > 0) {
                const choice = bgPool[Math.floor(Math.random() * bgPool.length)];
                const itemName = choice.name;
                const artistName = choice.artist || choice.name;

                try {
                    let bgUrl: string | null = null;
                    if (choice.type === 'artist') {
                        const res = await TrackResolverService.resolveArtist(itemName);
                        bgUrl = res.avatarUrl;
                    } else if (choice.type === 'album') {
                        const res = await TrackResolverService.resolveAlbum(artistName, itemName);
                        bgUrl = res.artworkUrl;
                    } else {
                        const res = await TrackResolverService.resolve(artistName, itemName);
                        bgUrl = res.artworkUrl;
                    }
                    if (bgUrl) renderData.bgUrl = bgUrl;
                } catch (e) {
                    console.warn('[songtwin] Background resolution failed:', e);
                }
            }

            // ── Render with Puppeteer (1200x700 for Pro aesthetics) ──
            const buffer = await PuppeteerService.render('songtwin', renderData, { width: 1200, height: 700 });

            // ── Upload via staging ──
            let cdnUrl: string | null = null;
            const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
            if (stagingChannelId && interactionOrMessage.client) {
                try {
                    const stagingChannel = await interactionOrMessage.client.channels.fetch(stagingChannelId) as TextChannel;
                    if (stagingChannel?.type === ChannelType.GuildText) {
                        const att = new AttachmentBuilder(buffer, { name: 'songtwin.webp' });
                        const msg = await stagingChannel.send({ files: [att] });
                        cdnUrl = msg.attachments.first()?.url || null;
                        // Deleting after 24 hours to keep the CDN link alive for a while
                        setTimeout(() => msg.delete().catch(() => { }), 86400000);
                    }
                } catch (e) {
                    console.warn('⚠️ SongTwin staging failed:', e);
                }
            }


            const contentText = [
                `###  Song Twin — ${scoreLabel}`,
                `**${displayNameA}** and **${displayNameB}** share **${compatScore}%** compatibility over **${periodLabelText}**`,
                sharedArtists.length > 0
                    ? `-# Common artists: ${sharedArtists.slice(0, 7).join(', ')}${sharedArtists.length > 7 ? ' + more' : ''}`
                    : `-# No shared artists in this period`
            ].join('\n');

            // ── Payload ──
            const builder = new ComponentsV2().setAccent(0x8050ff);

            if (cdnUrl) {
                builder.addMedia(cdnUrl, `${displayNameA} vs ${displayNameB} — ${compatScore}% compatibility`)
                    .addSeparator()
                    .addText(contentText);

                const payload = builder.build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
            } else {
                // Fallback: direct attachment
                const payload: any = {
                    content: contentText,
                    files: [new AttachmentBuilder(buffer, { name: 'songtwin.webp' })],
                    flags: 32768
                };
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
            }

        } catch (err: any) {
            console.error('[songtwin] error:', err);
            await this.replyError(interactionOrMessage, isSlash, `❌ ${err.message || 'Failed to generate Song Twin card.'}`);
        }
    }

    private async replyError(interactionOrMessage: any, isSlash: boolean, msg: string): Promise<void> {
        const payload = new ComponentsV2()
            .setAccent(0x8050ff)
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

function truncate(str: string, maxLen: number): string {
    if (!str) return '';
    return str.length > maxLen ? str.substring(0, maxLen - 1) + '…' : str;
}
