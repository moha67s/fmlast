import {
  BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { IdResolutionService } from '../../services/bot/IdResolutionService';
import { LastFM } from '../../services/api/LastFM';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { SettingService } from '../../services/bot/SettingService';

export default class GlobalWhoKnowsTrackCommand extends BaseCommand {
    name = 'gwkt';
    description = 'View who knows a track across the entire bot';
    aliases = ['gwktrack', 'globalwhoknowstrack'];

    slashData = new SlashCommandBuilder()
        .setName('gwkt')
        .setDescription('View who knows a track across the entire bot')
        .addStringOption((opt: any) => 
            opt.setName('track')
                .setDescription('The track to check')
                .setRequired(false)
        )
        .addStringOption((opt: any) => 
            opt.setName('artist')
                .setDescription('The artist of the track')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let trackName = '';
        let artistName = '';

        if (isSlash) {
            trackName = interactionOrMessage.options.getString('track') || '';
            artistName = interactionOrMessage.options.getString('artist') || '';
        } else {
            if (args && args.length > 0) {
                const parts = args.join(' ').split('|').map(s => s.trim());
                trackName = parts[0];
                if (parts.length > 1) artistName = parts[1];
            }
        }

        if (!trackName) {
            const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
            const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
            
            if (dbAuthor?.lastfmUsername) {
                const nowPlaying = await LastFM.getRecentTracks(dbAuthor.lastfmUsername, 1, dbAuthor.lastfmSessionKey);
                const track = nowPlaying?.[0];
                if (track) {
                    trackName = track.name;
                    artistName = track.artist?.['#text'] || track.artist?.name || '';
                }
            }
        }

        if (!trackName) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Please specify a track or scrobble something first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // 1. Resolve Artist ID and Track ID
            const artistId = artistName ? await IdResolutionService.getArtistId(artistName) : '';
            if (!artistId && artistName) {
                throw new Error(`Could not resolve artist: ${artistName}`);
            }

            let knowers: any[] = [];
            let finalName = trackName;
            let finalArtistName = artistName;

            if (artistId) {
                const trackId = await IdResolutionService.getTrackId(artistId, trackName);
                
                knowers = await (prisma.userTrack as any).findMany({
                    where: { trackId },
                    include: { user: true },
                    orderBy: { playcount: 'desc' },
                    take: 100 // Top 100 global
                });

                const track = await prisma.track.findUnique({ where: { id: trackId } });
                const artist = await prisma.artist.findUnique({ where: { id: artistId } });
                if (track) finalName = track.name;
                if (artist) finalArtistName = artist.name;
            } else {
                knowers = await (prisma.userTrack as any).findMany({
                    where: { trackName: { equals: trackName, mode: 'insensitive' } },
                    include: { user: true },
                    orderBy: { playcount: 'desc' },
                    take: 100
                });
                
                // Set artistName from the top result if not provided
                if (knowers.length > 0 && !finalArtistName) {
                    finalArtistName = knowers[0].artistName;
                }
            }

            if (knowers.length === 0) {
                const payload = new ComponentsV2().addText(`Nobody globally knows **${finalName}**${finalArtistName ? ` by **${finalArtistName}**` : ''} yet.`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            let thumbnail = null;
            if (finalArtistName) {
                try {
                    const meta = await TrackResolverService.resolve(finalArtistName, finalName);
                    if (meta?.artworkUrl) thumbnail = meta.artworkUrl;
                } catch { }
            }

            // 4. Build Pagination
            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(knowers.length / perPage) || 1;

            const generatePayload = (page: number) => {
                const builder = new ComponentsV2().setAccent(embedColor);
                const start = (page - 1) * perPage;
                const slice = knowers.slice(start, start + perPage);

                const list = slice.map((k, i) => {
                    const rank = start + i + 1;
                    const username = k.user.lastfmUsername || 'Unknown';
                    const discordTag = k.user.discordId ? `<@${k.user.discordId}>` : `**${username}**`;
                    return `${rank}.\u2004\u2005${discordTag} — **${k.playcount.toLocaleString()}** plays`;
                }).join('\n');

                builder.addText(`### Global Who Knows: **${finalName}**\n${finalArtistName ? `by **${finalArtistName}**\n` : ''}${list}`);
                if (thumbnail) builder.setThumbnail(thumbnail);
                builder.addText(`-# Total Knowers: ${knowers.length}`);

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
                const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
                const collector = message.createMessageComponentCollector({
                    filter: (i: any) => i.user.id === authorId,
                    time: 60000
                });

                collector.on('collect', async (i: any) => {
                    if (i.customId === 'paginator_prev') currentPage = Math.max(1, currentPage - 1);
                    else if (i.customId === 'paginator_next') currentPage = Math.min(totalPages, currentPage + 1);
                    await i.update(generatePayload(currentPage));
                });
            }

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch global who knows.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
