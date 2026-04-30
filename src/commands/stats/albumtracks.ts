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
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { TrackResolverService } from '../../services/api/TrackResolverService';

export default class AlbumTracksCommand extends BaseCommand {
    name = 'albumtracks';
    description = 'View your playcounts for each track on an album';
    aliases = ['alt'];

    slashData = new SlashCommandBuilder()
        .setName('albumtracks')
        .setDescription('View your playcounts for each track on an album')
        .addStringOption(opt => 
            opt.setName('album')
                .setDescription('The album name (leave blank for currently playing)')
                .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('artist')
                .setDescription('The artist name')
                .setRequired(false)
        )
        .addUserOption(opt => 
            opt.setName('user')
                .setDescription('View for another user')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let albumQuery = '';
        let artistQuery = '';
        let targetUserObj = null;

        if (isSlash) {
            albumQuery = interactionOrMessage.options.getString('album') || '';
            artistQuery = interactionOrMessage.options.getString('artist') || '';
            targetUserObj = interactionOrMessage.options.getUser('user');
        } else {
            if (args && args.length > 0) {
                const str = args.join(' ');
                const parts = str.split('|').map(s => s.trim());
                albumQuery = parts[0];
                if (parts.length > 1) artistQuery = parts[1];
            }
        }

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        const lookupUser = targetUserObj || author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        const userSettings = await SettingService.getUser(lookupUser.id !== author.id ? `<@${lookupUser.id}>` : '', dbAuthor);
        const targetDbUser = userSettings.targetUser;

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            if (!albumQuery) {
                // 1. Try currently playing track in voice channel
                const { QueueManager } = await import('../../services/music/QueueManager');
                const queue = QueueManager.getQueue(interactionOrMessage.guildId || '');
                if (queue?.currentTrack) {
                    // Similar to albumplays, but YouTube tracks rarely have album metadata
                }

                // 2. Try Last.fm
                if (!targetDbUser.lastfmUsername) {
                    throw new Error('No album provided, and Last.fm account not linked to check current track.');
                }

                const recent = await LastFM.getRecentTracks(targetDbUser.lastfmUsername, 1, targetDbUser.lastfmSessionKey);
                if (recent && recent.length > 0) {
                    const track = recent[0];
                    albumQuery = track.album?.['#text'] || '';
                    artistQuery = track.artist?.['#text'] || track.artist?.name || '';

                    // 3. Deeper lookup if album is missing from recent scrobble
                    if (!albumQuery) {
                        try {
                            const info = await LastFM.getTrackInfo(artistQuery, track.name, targetDbUser.lastfmUsername, targetDbUser.lastfmSessionKey);
                            if (info?.album?.title) {
                                albumQuery = info.album.title;
                                if (!artistQuery) artistQuery = info.artist?.name || '';
                            }
                        } catch {}
                    }
                }

                if (!albumQuery) {
                    throw new Error('No album provided, and no recent album found to look up.');
                }
            }

            if (!albumQuery) throw new Error('Could not resolve an album name.');

            // Fire & Forget background sync
            triggerDeltaSync(targetDbUser.discordId);

            // Fetch official tracklist
            let officialTracks: any[] = [];
            // High-res Image Priority: Spotify/Apple/Deezer via Resolver -> Last.fm fallback
            let coverUrl = null;
            if (artistQuery) {
                try {
                    const meta = await TrackResolverService.resolveAlbum(artistQuery, albumQuery);
                    if (meta?.artworkUrl) coverUrl = meta.artworkUrl;
                } catch { }

                if (!coverUrl) {
                    try {
                        const albumData = await LastFM.getAlbumInfo(artistQuery, albumQuery, null, null);
                        if (albumData?.tracks?.track) {
                            officialTracks = Array.isArray(albumData.tracks.track) ? albumData.tracks.track : [albumData.tracks.track];
                        }
                        const images = albumData.image as any[];
                        if (images && images.length > 0) {
                            const largest = images[images.length - 1]['#text'];
                            if (largest && !LastFM.isDefaultImage(largest)) coverUrl = largest;
                        }
                    } catch { }
                } else {
                    // Still need tracklist from Last.fm even if we have high-res cover
                    try {
                        const albumData = await LastFM.getAlbumInfo(artistQuery, albumQuery, null, null);
                        if (albumData?.tracks?.track) {
                            officialTracks = Array.isArray(albumData.tracks.track) ? albumData.tracks.track : [albumData.tracks.track];
                        }
                    } catch { }
                }
            }

            const querySql = `
                SELECT track_name as track, CAST(COUNT(*) AS INTEGER) as playcount
                FROM user_plays
                WHERE user_id = '${targetDbUser.id}' 
                  ${artistQuery ? `AND artist_name ILIKE '${artistQuery.replace(/'/g, "''")}'` : ''}
                  AND album_name ILIKE '${albumQuery.replace(/'/g, "''")}'
                GROUP BY track_name
                ORDER BY playcount DESC
            `;

            const results: any[] = await prisma.$queryRawUnsafe(querySql);

            if (results.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no logged plays for **${albumQuery}**.`)
                    .build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            // Map results to official tracks if available, otherwise just use results
            let trackList = [];
            if (officialTracks.length > 0) {
                trackList = officialTracks.map((t, index) => {
                    const dbMatch = results.find(r => r.track.toLowerCase() === t.name.toLowerCase());
                    return {
                        rank: index + 1,
                        name: t.name,
                        playcount: dbMatch ? dbMatch.playcount : 0
                    };
                });
            } else {
                trackList = results.map((r, index) => ({
                    rank: index + 1,
                    name: r.track,
                    playcount: r.playcount
                }));
            }

            // Remove tracks with 0 plays if not using official order, but keep them if official
            // FMBot usually sorts by playcount
            trackList.sort((a, b) => b.playcount - a.playcount);

            const totalPlays = trackList.reduce((acc, t) => acc + t.playcount, 0);

            const perPage = 15;
            let currentPage = 1;
            const totalPages = Math.ceil(trackList.length / perPage) || 1;

            const generatePayload = (page: number) => {
                const builder = new ComponentsV2().setAccent(embedColor);
                const start = (page - 1) * perPage;
                const slice = trackList.slice(start, start + perPage);

                const list = slice.map((t: any, i: number) => {
                    const rank = start + i + 1;
                    return `\u2005${rank}.\u2004\u2005**${t.name}** - **${t.playcount.toLocaleString()}** plays`;
                }).join('\n');

                const content = `### Top Tracks for ${albumQuery}\n${artistQuery ? `by **${artistQuery}**\n` : ''}${list}\n\n-# Page ${page}/${totalPages} - ${totalPlays.toLocaleString()} total plays`;
                
                if (coverUrl) {
                    builder.addThumbnail(coverUrl, content);
                } else {
                    builder.addText(content);
                }

                if (totalPages > 1) {
                    builder.addRow([
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'paginator_prev', emoji: { name: '◀️' }, disabled: page === 1 },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'paginator_next', emoji: { name: '▶️' }, disabled: page === totalPages }
                    ]);
                }

                return builder.build();
            };

            const initialPayload = generatePayload(currentPage);
            const message = isSlash 
                ? await interactionOrMessage.editReply(initialPayload)
                : await interactionOrMessage.channel.send(initialPayload);

            if (totalPages > 1) {
                const collector = message.createMessageComponentCollector({
                    filter: (i: any) => i.user.id === author.id,
                    time: 60000
                });

                collector.on('collect', async (i: any) => {
                    if (i.customId === 'paginator_prev') currentPage = Math.max(1, currentPage - 1);
                    else if (i.customId === 'paginator_next') currentPage = Math.min(totalPages, currentPage + 1);
                    await i.update(generatePayload(currentPage));
                });
            }

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
