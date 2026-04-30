import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { IdResolutionService } from '../../services/bot/IdResolutionService';
import { LastFM } from '../../services/api/LastFM';
import { SettingService } from '../../services/bot/SettingService';

export default class GlobalWhoKnowsCommand extends BaseCommand {
    name = 'gwk';
    description = 'View who knows an artist across the entire bot';
    aliases = ['globalwhoknows', 'gwhoknows'];

    slashData = new SlashCommandBuilder()
        .setName('gwk')
        .setDescription('View who knows an artist across the entire bot')
        .addStringOption((opt: any) => 
            opt.setName('artist')
                .setDescription('The artist to check')
                .setRequired(true)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let artistName = isSlash 
            ? interactionOrMessage.options.getString('artist') || '' 
            : (args ? args.join(' ') : '');

        if (!artistName) {
            const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
            const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
            
            if (dbAuthor?.lastfmUsername) {
                const nowPlaying = await LastFM.getRecentTracks(dbAuthor.lastfmUsername, 1, dbAuthor.lastfmSessionKey);
                const track = nowPlaying?.[0];
                if (track) {
                    artistName = track.artist?.['#text'] || track.artist?.name;
                }
            }
        }

        if (!artistName) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Please specify an artist or scrobble something first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        try {
            // 1. Resolve Artist ID
            const artistId = await IdResolutionService.getArtistId(artistName);
            
            // 2. Fetch all users who have this artist
            const knowers = await (prisma.userArtist as any).findMany({
                where: { artistId },
                include: { user: true },
                orderBy: { playcount: 'desc' },
                take: 100 // Top 100 global
            }) as any[];

            if (knowers.length === 0) {
                const payload = new ComponentsV2().addText(`Nobody globally knows **${artistName}** yet.`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            // 3. Resolve the "real" name (from DB if possible)
            const artist = await prisma.artist.findUnique({ where: { id: artistId } });
            const finalName = artist?.name || artistName;

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

                builder.addText(`### Global Who Knows: **${finalName}**\n${list}`);
                builder.addText(`-# Total Knowers: ${knowers.length}`);

                if (totalPages > 1) {
                    builder.addRow([
                        { type: 2, style: 2, custom_id: 'paginator_prev', emoji: { name: '◀️' }, disabled: page === 1 },
                        { type: 2, style: 2, custom_id: 'paginator_next', emoji: { name: '▶️' }, disabled: page === totalPages }
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
