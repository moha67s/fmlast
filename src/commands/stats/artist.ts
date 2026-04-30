import {
  BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

/** Convert ISO 3166-1 alpha-2 country code to flag emoji */
function countryFlag(code: string): string {
    return [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join('');
}

export default class ArtistCommand extends BaseCommand {
    name = 'artist';
    description = 'View detailed information about an artist';
    aliases = ['a', 'artistinfo'];

    slashData = new SlashCommandBuilder()
        .setName('artist')
        .setDescription('View detailed information about an artist')
        .addStringOption(opt => 
            opt.setName('artist')
                .setDescription('The artist to look up (leave blank for currently playing)')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        let artistQuery = isSlash 
            ? interactionOrMessage.options.getString('artist') || '' 
            : (args ? args.join(' ') : '');

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        const userSettings = await SettingService.getUser('', dbAuthor);
        const targetDbUser = userSettings.targetUser;

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        // Fire & Forget background sync
        triggerDeltaSync(targetDbUser.discordId);

        try {
            // If no artist provided, try to fetch their recent track to use its artist
            if (!artistQuery) {
                if (!targetDbUser.lastfmUsername) {
                    throw new Error('No artist provided, and Last.fm account not linked to check current track.');
                }
                const recent = await LastFM.getRecentTracks(targetDbUser.lastfmUsername, 1, targetDbUser.lastfmSessionKey);
                if (!recent || recent.length === 0) {
                    throw new Error('No artist provided, and no recent tracks found to look up.');
                }
                artistQuery = recent[0].artist?.['#text'] || recent[0].artist?.name;
            }

            if (!artistQuery) throw new Error('Could not resolve an artist name.');

            // Parallel fetch: Last.fm info + thumbnail + DB metadata + user info
            const [artistData, resolverMeta, dbArtist, userInfo] = await Promise.all([
                LastFM.getArtistInfo(artistQuery, targetDbUser.lastfmUsername, targetDbUser.lastfmSessionKey),
                TrackResolverService.resolveArtist(artistQuery).catch(() => null),
                prisma.artist.findFirst({ 
                    where: { name: { equals: artistQuery, mode: 'insensitive' } },
                    include: { 
                        tags: { include: { tag: true }, orderBy: { count: 'desc' }, take: 5 },
                        links: true
                    }
                }).catch(() => null),
                LastFM.getUserInfo(targetDbUser.lastfmUsername!, targetDbUser.lastfmSessionKey).catch(() => null)
            ]);

            if (!artistData) {
                throw new Error(`Could not find information for artist: ${artistQuery}`);
            }

            const name = artistData.name;
            const url = artistData.url;
            const globalListeners = parseInt(artistData.stats?.listeners || '0');
            const globalPlaycount = parseInt(artistData.stats?.playcount || '0');
            const userPlaycount = parseInt(artistData.stats?.userplaycount || '0');
            const lfmTags = (artistData.tags?.tag as any[] || []).map((t: any) => t.name).slice(0, 5);
            let bio = artistData.bio?.summary || '';
            
            // Clean up bio
            bio = bio.replace(/<a href="https:\/\/www\.last\.fm[^>]+>Read more on Last\.fm<\/a>\.?/g, '').trim();
            if (bio.length > 400) bio = bio.substring(0, 397) + '...';

            const thumbnail = resolverMeta?.avatarUrl || null;

            // ── Resolve MusicBrainz metadata ──────────────────────────────
            // Try DB first, fall back to live MusicBrainz lookup
            let mbOrigin: string | null = null;
            let mbCountryCode: string | null = dbArtist?.countryCode || null;
            let mbType: string | null = dbArtist?.type || null;
            let mbStartDate: string | null = null;
            let artistLinks = dbArtist?.links || [];

            if (!mbCountryCode || !mbType || artistLinks.length === 0) {
                try {
                    const { MusicBrainz } = await import('../../services/api/MusicBrainz');
                    const mbInfo = await MusicBrainz.getArtistFullInfo(name);
                    if (mbInfo) {
                        mbOrigin = mbInfo.metadata.origin !== 'Unknown' ? mbInfo.metadata.origin : null;
                        mbCountryCode = mbCountryCode || mbInfo.metadata.countryCode;
                        mbType = mbType || mbInfo.metadata.type;
                        mbStartDate = mbInfo.metadata.activeSince;

                        // Persist to DB for next time (fire & forget)
                        if (dbArtist) {
                            prisma.artist.update({
                                where: { id: dbArtist.id },
                                data: {
                                    countryCode: mbCountryCode || undefined,
                                    type: mbType || undefined,
                                }
                            }).catch(() => {});

                            if (mbInfo.links.length > 0 && artistLinks.length === 0) {
                                prisma.artistLink.createMany({
                                    data: mbInfo.links.map(l => ({
                                        artistId: dbArtist.id,
                                        type: l.type,
                                        url: l.url
                                    })),
                                    skipDuplicates: true
                                }).catch(() => {});
                                artistLinks = mbInfo.links.map(l => ({ type: l.type, url: l.url })) as any;
                            }
                        }
                    }
                } catch {}
            }

            // ── Section 1: Header with Thumbnail ──────────────────────────
            let header = `## [${name}](${url})`;
            
            // Build metadata lines like FMBot
            const metaLines: string[] = [];
            if (mbOrigin && mbCountryCode) {
                metaLines.push(`Artist from **${mbOrigin}** ${countryFlag(mbCountryCode)}`);
            } else if (mbCountryCode) {
                metaLines.push(countryFlag(mbCountryCode));
            }
            if (mbType && mbType !== 'Unknown') {
                metaLines.push(mbType);
            }
            if (mbStartDate) {
                const ts = Math.floor(new Date(mbStartDate).getTime() / 1000);
                if (ts > 0) metaLines.push(`Started: <t:${ts}:D>`);
            }
            if (metaLines.length > 0) {
                header += `\n${metaLines.join('\n')}`;
            }

            const builder = new ComponentsV2().setAccent(userSettings.accentColor);
            
            if (thumbnail) {
                builder.addThumbnail(thumbnail, header);
            } else {
                builder.addText(header);
            }

            // ── Section 2: User Plays ──────────────────────────────────────
            if (userPlaycount > 0) {
                builder.addSeparator();

                // Compute last month plays from DB
                let lastMonthPlays = 0;
                try {
                    const oneMonthAgo = new Date();
                    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
                    lastMonthPlays = await prisma.userPlay.count({
                        where: {
                            userId: targetDbUser.id,
                            artistName: { equals: name, mode: 'insensitive' },
                            timePlayed: { gte: oneMonthAgo }
                        }
                    });
                } catch {}

                // Compute percentage of total plays
                let percentage = '';
                const totalScrobbles = parseInt(userInfo?.playcount || '0');
                if (totalScrobbles > 0 && userPlaycount > 0) {
                    const pct = ((userPlaycount / totalScrobbles) * 100).toFixed(2);
                    percentage = `\n**${pct} %** of all your plays`;
                }

                let userSection = `**${userPlaycount.toLocaleString()}** plays by **${userSettings.displayName}**`;
                if (lastMonthPlays > 0) {
                    userSection += ` — **${lastMonthPlays.toLocaleString()}** last month`;
                }
                userSection += percentage;

                builder.addText(userSection);
            }

            // ── Section 3: Server + Global Stats ───────────────────────────
            builder.addSeparator();

            let statsSection = '';

            // Server stats (if in a guild)
            if (interactionOrMessage.guild) {
                try {
                    const guildId = interactionOrMessage.guild.id;
                    
                    const guildMembers = await prisma.guildMember.findMany({
                        where: { guild: { guildId } },
                        select: { userId: true }
                    });
                    const memberUserIds = guildMembers.map(m => m.userId);

                    if (memberUserIds.length > 0) {
                        const serverData = await prisma.userArtist.aggregate({
                            where: {
                                userId: { in: memberUserIds },
                                artistName: { equals: name, mode: 'insensitive' }
                            },
                            _sum: { playcount: true },
                            _count: { userId: true }
                        });

                        const serverPlays = serverData._sum.playcount || 0;
                        const serverListeners = serverData._count.userId || 0;

                        if (serverPlays > 0) {
                            statsSection += `**${serverPlays.toLocaleString()}** plays in this server by **${serverListeners}** listener${serverListeners !== 1 ? 's' : ''}\n`;
                        }
                    }
                } catch {}
            }

            statsSection += `**${globalPlaycount.toLocaleString()}** Last.fm plays by **${globalListeners.toLocaleString()}** listeners`;
            builder.addText(statsSection);

            // ── Section 4: Bio ─────────────────────────────────────────────
            if (bio) {
                builder.addSeparator();
                builder.addText(bio);
            }

            // ── Section 5: Tags ────────────────────────────────────────────
            const tags = (dbArtist?.tags?.map(t => t.tag.name) || lfmTags).slice(0, 5);
            if (tags.length > 0) {
                builder.addSeparator();
                builder.addText(`-# ${tags.join(' · ')}`);
            }

            // ── Section 6: Link Buttons ────────────────────────────────────
            const linkButtons: any[] = [];
            const linkOrder = ['spotify', 'apple_music', 'instagram', 'twitter', 'bandcamp', 'soundcloud', 'youtube'];
            const linkEmojis: Record<string, { name: string; id: string } | { name: string }> = {
                spotify: { name: 'sp', id: '1496297132381048995' },
                apple_music: { name: 'am', id: '1496297174869479548' },
                instagram: { name: 'inst', id: '1499324552201633862' },
                twitter: { name: 'x_', id: '1499324577786892308' },
                bandcamp: { name: 'bnd', id: '1499324758364524595' },
                soundcloud: { name: '☁️' },
                youtube: { name: '▶️' },
            };
            const linkLabels: Record<string, string> = {
                spotify: 'Spotify',
                apple_music: 'Apple Music',
                instagram: 'Instagram',
                twitter: 'Twitter',
                bandcamp: 'Bandcamp',
                soundcloud: 'SoundCloud',
                youtube: 'YouTube',
            };

            for (const linkType of linkOrder) {
                const link = artistLinks.find((l: any) => l.type === linkType);
                if (link) {
                    linkButtons.push({
                        type: ComponentType.Button,
                        style: ButtonStyle.Link,
                        url: link.url,
                        emoji: linkEmojis[linkType] || { name: '🔗' },
                    });
                }
                if (linkButtons.length >= 5) break; // Discord max per row
            }

            if (linkButtons.length > 0) {
                builder.addRow(linkButtons);
            }

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
