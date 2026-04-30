import {
  BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { prisma } from '../../database/client';
import { ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  TextChannel,
  ComponentType
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';

// ── Manual artist-level overrides ─────────────────────────────────────────
// For artists Last.fm misattributes (e.g. Egyptian Zaf vs Greek Zaf).
const ARTIST_OVERRIDES: Record<string, { cluster: string, related?: string[] }> = {
    'zaf': {
        cluster: 'arabic',
        related: ['young giza', 'HAITHAM', 'ZDAN', 'zalka', 'ZIEN4L', 'ghassan', 'dokshan', 'Wg sad', 'kingoo', 'omar gangster', 'begad', '$savage', 'karim enzo', 'salah tayer', 'qetoo']
    },
};

// ── Regional tag clusters ──────────────────────────────────────────────────
const REGION_CLUSTERS: Record<string, string[]> = {
    arabic: ['arabic', 'arab', 'egyptian', 'egypt', 'arabic music', 'lebanese',
        'khaleeji', 'mahraganat', 'shaabi', 'arabic pop', 'egyptian pop', 'arab pop'],
    greek: ['greek', 'greek music', 'laiko', 'greece', 'rebetiko', 'ellada', 'greek pop'],
    turkish: ['turkish', 'turkey', 'turkish music', 'arabesk', 'turk pop'],
    kpop: ['kpop', 'k-pop', 'korean', 'korean pop', 'k pop'],
    latin: ['latin', 'reggaeton', 'cumbia', 'salsa', 'bachata', 'latin pop'],
    hindi: ['hindi', 'bollywood', 'indian', 'desi', 'punjabi', 'tamil'],
};

function detectCluster(tags: string[]): string | null {
    const lowerTags = tags.map((t: string) => t.toLowerCase());
    let bestCluster: string | null = null;
    let bestScore = 0;
    for (const [cluster, clusterTags] of Object.entries(REGION_CLUSTERS)) {
        const score = clusterTags.filter(ct => lowerTags.some(lt => lt.includes(ct) || ct.includes(lt))).length;
        if (score > bestScore) { bestScore = score; bestCluster = cluster; }
    }
    return bestScore >= 1 ? bestCluster : null;
}

async function fetchArtistClusters(artists: string[], sessionKey?: string | null): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const chunks: string[][] = [];
    for (let i = 0; i < artists.length; i += 10) chunks.push(artists.slice(i, i + 10));
    for (const chunk of chunks) {
        await Promise.all(chunk.map(async artistName => {
            const override = ARTIST_OVERRIDES[artistName.toLowerCase()];
            if (override) { result.set(artistName, override.cluster); return; }
            try {
                const rawTags = await LastFM.getArtistTopTags(artistName, sessionKey);
                const tagNames: string[] = (Array.isArray(rawTags) ? rawTags : []).slice(0, 8).map((t: any) => t.name || '');
                result.set(artistName, detectCluster(tagNames));
            } catch {
                result.set(artistName, null);
            }
        }));
    }
    return result;
}

export default class RadioCommand extends BaseCommand {
    name = 'radio';
    description = 'Get song recommendations based on your currently playing track.';
    aliases = ['rec', 'recommend'];

    slashData = new SlashCommandBuilder()
        .setName('radio')
        .setDescription('Get song recommendations based on your currently playing track.');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        if (!isSlash) {
            try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { }
        }

        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        if (!dbUser?.lastfmUsername) {
            const msg = '❌ Link your Last.fm account first using `/login`.';
            isSlash ? await interactionOrMessage.reply({ content: msg, ephemeral: true }) : await interactionOrMessage.channel.send(msg);
            return;
        }

        if (isSlash) {
            await interactionOrMessage.deferReply();
        }

        try {
            const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey);
            if (!tracks?.length) {
                const msg = '😢 No recent tracks found.';
                isSlash ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.channel.send(msg);
                return;
            }

            const current = tracks[0];
            const artist = current.artist?.['#text'] || 'Unknown Artist';
            const trackName = current.name || 'Unknown Track';

            // ── Load user's library ────────────────────────────────────────
            const userArtistRows = await prisma.userArtist.findMany({
                where: { userId: dbUser.id },
                orderBy: { playcount: 'desc' },
                take: 300,
                select: { artistName: true, playcount: true }
            });
            const userLibrary = new Map<string, number>(
                userArtistRows.map(r => [r.artistName.toLowerCase(), r.playcount])
            );
            const hasLibrary = userLibrary.size >= 20;

            // ── Detect seed cultural cluster ───────────────────────────────
            let seedCluster: string | null = ARTIST_OVERRIDES[artist.toLowerCase()]?.cluster || null;
            if (!seedCluster) {
                try {
                    const seedRawTags = await LastFM.getArtistTopTags(artist, dbUser.lastfmSessionKey);
                    const seedTagNames = (Array.isArray(seedRawTags) ? seedRawTags : []).slice(0, 8).map((t: any) => t.name || '');
                    seedCluster = detectCluster(seedTagNames);
                } catch { }
            }
            if (seedCluster) console.log(`[Radio] Cultural zone for "${artist}": ${seedCluster}`);

            const filterOutRemixes = (list: any[]) => {
                const rx = /\b(remix|edit|version|live|acoustic|cover|mix|instrumental|instr|remastered|remaster|karaoke|screwed|chopped|slowed|reverb|sped up|demo)\b/i;
                return list.filter(s => !rx.test(s.name || ''));
            };

            const buildResponse = (recs: { name: string; artistName: string }[], label: string) => {
                const builder = new ComponentsV2()
                    .addText(`### 📻 ${label}\n**${trackName}** by ${artist}`)
                    .addSeparator();

                let tracksText = '';
                const buttons: any[] = [];
                for (let i = 0; i < recs.length; i++) {
                    const r = recs[i];
                    tracksText += `${i + 1}. **${r.name}** by ${r.artistName}\n`;
                    buttons.push({
                        type: ComponentType.Button,
                        style: ButtonStyle.Secondary, // Secondary
                        label: `${i + 1}`,
                        custom_id: `radio-pre:${r.artistName.substring(0, 35)}|${r.name.substring(0, 50)}`
                    });
                }
                
                builder.addText(tracksText.trim());
                builder.addRow(buttons);
                builder.addRow([{
                    type: ComponentType.Button,
                    style: ButtonStyle.Primary, // Primary
                    label: '🔀 Reroll Station',
                    custom_id: 'radio-reroll'
                }]);

                return builder.build();
            };

            const isReroll = interactionOrMessage.isButton?.();
            const send = async (payload: any) => {
                if (isSlash) {
                    if (isReroll) {
                        await interactionOrMessage.followUp(payload);
                    } else {
                        await interactionOrMessage.editReply(payload);
                    }
                } else {
                    await interactionOrMessage.channel.send(payload);
                }
            };

            // ══════════ ENGINE 1: SPOTIFY (primary) ══════════════════════
            // Searches by track name → finds correct artist even when names collide.
            // Uses Spotify's ML-based related-artists graph for accurate recommendations.
            const spotifyRecs = await Spotify.getRadioRecommendations(trackName, artist);
            if (spotifyRecs.length >= 3) {
                console.log(`[Radio] Spotify engine: ${spotifyRecs.length} candidates.`);
                const spUnique = new Set<string>([artist.toLowerCase()]);
                const spSelected: { name: string; artistName: string }[] = [];
                for (const r of spotifyRecs) {
                    if (!spUnique.has(r.artist.toLowerCase()) && r.name.toLowerCase() !== trackName.toLowerCase()) {
                        spSelected.push({ name: r.name, artistName: r.artist });
                        spUnique.add(r.artist.toLowerCase());
                    }
                    if (spSelected.length === 5) break;
                }
                if (spSelected.length >= 3) {
                    await send(buildResponse(spSelected, 'Radio'));
                    return;
                }
            }
            console.log(`[Radio] Spotify insufficient — falling back to Last.fm.`);

            // ══════════ ENGINE 2: LAST.FM TRACK SIMILARITY (fallback) ══════
            const isManualOverride = artist.toLowerCase() in ARTIST_OVERRIDES;
            let mode = 'track';

            if (!isManualOverride) {
                let similarTracks = await LastFM.getSimilarTracks(artist, trackName, 50, dbUser.lastfmSessionKey);
                let similarFiltered = filterOutRemixes(similarTracks);

                // Cultural guard + library scoring
                if (similarFiltered.length > 0) {
                    const candidateArtists = [...new Set<string>(
                        similarFiltered.map((t: any) => t.artist?.name).filter(Boolean) as string[]
                    )];
                    const clusterMap = await fetchArtistClusters(candidateArtists, dbUser.lastfmSessionKey);

                    const scored = similarFiltered
                        .map(t => {
                            const tArtistRaw: string = t.artist?.name || '';
                            if (seedCluster) {
                                const tCluster = clusterMap.get(tArtistRaw);
                                if (tCluster !== null && tCluster !== undefined && tCluster !== seedCluster) return { t, score: -1 };
                            }
                            const lp = userLibrary.get(tArtistRaw.toLowerCase());
                            return { t, score: lp !== undefined ? 100 + Math.min(lp, 500) : 0 };
                        })
                        .filter(x => x.score >= 0)
                        .sort((a, b) => b.score - a.score);

                    const libTracks = scored.filter(x => x.score > 0);
                    const neutralTracks = scored.filter(x => x.score === 0);
                    for (let i = neutralTracks.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [neutralTracks[i], neutralTracks[j]] = [neutralTracks[j], neutralTracks[i]];
                    }
                    const finalPool = [...libTracks, ...neutralTracks];

                    const uniqueArtists = new Set<string>([artist.toLowerCase()]);
                    const selected: any[] = [];
                    for (const { t } of finalPool) {
                        const tA = (t.artist?.name || '').toLowerCase();
                        if (!uniqueArtists.has(tA) && t.name.toLowerCase() !== trackName.toLowerCase()) {
                            selected.push(t);
                            uniqueArtists.add(tA);
                        }
                        if (selected.length === 5) break;
                    }

                    if (selected.length >= 3) {
                        const recs = selected.map(t => ({ name: t.name, artistName: t.artist?.name || 'Unknown' }));
                        await send(buildResponse(recs, 'Radio'));
                        return;
                    }
                }
            }

            // ══════════ ENGINE 2.5: HARDCODED RELATED OVERRIDES ═══════════
            const manualOverrideOpts = ARTIST_OVERRIDES[artist.toLowerCase()];
            if (isManualOverride && manualOverrideOpts?.related && manualOverrideOpts.related.length > 0) {
                console.log(`[Radio] Using hardcoded related artists for "${artist}".`);
                let fallbackTracks: any[] = [];
                // Shuffle the related artists to get a random set
                const relatedPool = [...manualOverrideOpts.related];
                for (let i = relatedPool.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [relatedPool[i], relatedPool[j]] = [relatedPool[j], relatedPool[i]];
                }

                for (const relatedArtist of relatedPool.slice(0, 10)) {
                    try {
                        const top = await LastFM.getArtistTopTracks(relatedArtist, 3, dbUser.lastfmSessionKey);
                        fallbackTracks.push(...top);
                    } catch { }
                }
                fallbackTracks = filterOutRemixes(fallbackTracks);
                for (let i = fallbackTracks.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [fallbackTracks[i], fallbackTracks[j]] = [fallbackTracks[j], fallbackTracks[i]];
                }

                const fbUnique = new Set<string>([artist.toLowerCase()]);
                const fbSelected: any[] = [];
                for (const t of fallbackTracks) {
                    const tA = (t.artist?.name || '').toLowerCase();
                    if (!fbUnique.has(tA) && t.name?.toLowerCase() !== trackName.toLowerCase()) {
                        fbSelected.push(t);
                        fbUnique.add(tA);
                    }
                    if (fbSelected.length === 5) break;
                }
                if (fbSelected.length >= 2) {
                    const recs = fbSelected.map(t => ({ name: t.name, artistName: t.artist?.name || 'Unknown' }));
                    await send(buildResponse(recs, 'Discovery Station'));
                    return;
                }
            }

            // ══════════ ENGINE 3: LIBRARY-BASED (for overridden artists) ═══
            if (isManualOverride && hasLibrary && seedCluster) {
                console.log(`[Radio] "${artist}" override — checking library for ${seedCluster} artists...`);
                const libPool = userArtistRows.filter(r => r.artistName.toLowerCase() !== artist.toLowerCase()).slice(0, 80);
                const libNames = libPool.map(r => r.artistName);
                const libClusterMap = await fetchArtistClusters(libNames, dbUser.lastfmSessionKey);
                const culturalArtists = libPool.filter(r => {
                    const ov = ARTIST_OVERRIDES[r.artistName.toLowerCase()];
                    return (ov?.cluster || libClusterMap.get(r.artistName)) === seedCluster;
                });

                console.log(`[Radio] Found ${culturalArtists.length} ${seedCluster} artists in library.`);

                if (culturalArtists.length >= 2) {
                    let fallbackTracks: any[] = [];
                    for (const la of culturalArtists.slice(0, 12)) {
                        try {
                            const top = await LastFM.getArtistTopTracks(la.artistName, 3, dbUser.lastfmSessionKey);
                            fallbackTracks.push(...top);
                        } catch { }
                    }
                    fallbackTracks = filterOutRemixes(fallbackTracks);
                    for (let i = fallbackTracks.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [fallbackTracks[i], fallbackTracks[j]] = [fallbackTracks[j], fallbackTracks[i]];
                    }
                    const fbUnique = new Set<string>([artist.toLowerCase()]);
                    const fbSelected: any[] = [];
                    for (const t of fallbackTracks) {
                        const tA = (t.artist?.name || '').toLowerCase();
                        if (!fbUnique.has(tA) && t.name?.toLowerCase() !== trackName.toLowerCase()) {
                            fbSelected.push(t);
                            fbUnique.add(tA);
                        }
                        if (fbSelected.length === 5) break;
                    }
                    if (fbSelected.length >= 2) {
                        const recs = fbSelected.map(t => ({ name: t.name, artistName: t.artist?.name || 'Unknown' }));
                        await send(buildResponse(recs, 'Discovery Station'));
                        return;
                    }
                }
            }

            // ══════════ ENGINE 4: LAST.FM ARTIST SIMILARITY (final fallback) ═
            if (!isManualOverride) {
                console.log(`[Radio] Using artist similarity fallback for "${artist}".`);
                mode = 'artist';
                let similarArtists = await LastFM.getSimilarArtists(artist, 15, dbUser.lastfmSessionKey);
                const fbArtistNames = similarArtists.map((a: any) => a.name).filter(Boolean) as string[];
                const fbClusterMap = await fetchArtistClusters(fbArtistNames, dbUser.lastfmSessionKey);

                const scoredArtists = similarArtists
                    .map((a: any) => {
                        if (seedCluster) {
                            const c = fbClusterMap.get(a.name);
                            if (c !== null && c !== undefined && c !== seedCluster) return { a, score: -1 };
                        }
                        const lp = userLibrary.get((a.name || '').toLowerCase());
                        return { a, score: lp !== undefined ? 100 + Math.min(lp, 500) : 0 };
                    })
                    .filter(x => x.score >= 0)
                    .sort((a, b) => b.score - a.score)
                    .map(x => x.a);

                let fallbackTracks: any[] = [];
                for (const sa of scoredArtists.slice(0, 10)) {
                    const top = await LastFM.getArtistTopTracks(sa.name, 5, dbUser.lastfmSessionKey);
                    fallbackTracks.push(...top);
                }
                fallbackTracks = filterOutRemixes(fallbackTracks);
                for (let i = fallbackTracks.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [fallbackTracks[i], fallbackTracks[j]] = [fallbackTracks[j], fallbackTracks[i]];
                }

                const fbUnique = new Set<string>([artist.toLowerCase()]);
                const final: any[] = [];
                for (const t of fallbackTracks) {
                    const tA = (t.artist?.name || '').toLowerCase();
                    if (!fbUnique.has(tA) && t.name.toLowerCase() !== trackName.toLowerCase()) {
                        final.push(t);
                        fbUnique.add(tA);
                    }
                    if (final.length === 5) break;
                }
                if (final.length >= 3) {
                    const recs = final.map(t => ({ name: t.name, artistName: t.artist?.name || 'Unknown' }));
                    await send(buildResponse(recs, 'Discovery Station'));
                    return;
                }
            }

            // ══════════ ENGINE 5: TAG/CHART (Deep Fallback) ══════════════
            if (seedCluster) {
                console.log(`[Radio] Using tag top tracks fallback for cluster "${seedCluster}".`);
                let tagTracks = await LastFM.getTagTopTracks(seedCluster, 100, dbUser.lastfmSessionKey);
                tagTracks = filterOutRemixes(tagTracks);
                for (let i = tagTracks.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [tagTracks[i], tagTracks[j]] = [tagTracks[j], tagTracks[i]];
                }
                const tagUnique = new Set<string>([artist.toLowerCase()]);
                const tagSelected: any[] = [];
                for (const t of tagTracks) {
                    const tA = (t.artist?.name || '').toLowerCase();
                    if (!tagUnique.has(tA) && t.name?.toLowerCase() !== trackName.toLowerCase()) {
                        tagSelected.push(t);
                        tagUnique.add(tA);
                    }
                    if (tagSelected.length === 5) break;
                }
                if (tagSelected.length >= 3) {
                    const recs = tagSelected.map(t => ({ name: t.name, artistName: t.artist?.name || 'Unknown' }));
                    await send(buildResponse(recs, 'Discovery Station'));
                    return;
                }
            }

            if (isManualOverride) {
                await send({ content: `📻 **No ${seedCluster} artists found in your library, and deep fallback failed.**\nListen to more **${artist}**-style artists and run \`+update\` to build your library!` });
                return;
            }

            await send({ content: `😢 I couldn't find any recommendations for **${trackName}** or similar artists.` });

        } catch (err) {
            console.error('Radio command error:', err);
            const msg = '⚠️ Failed to generate radio station.';
            isSlash ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.channel.send(msg);
        }
    }
}
