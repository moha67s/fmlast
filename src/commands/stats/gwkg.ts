import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { LastFM } from '../../services/api/LastFM';
import { SettingService } from '../../services/bot/SettingService';

export default class GlobalWhoKnowsGenreCommand extends BaseCommand {
    name = 'gwkg';
    description = 'View who knows a genre globally';
    aliases = ['globalwhoknowsgenre', 'gwkgenre'];

    slashData = new SlashCommandBuilder()
        .setName('gwkg')
        .setDescription('View who knows a genre globally')
        .addStringOption((opt: any) => 
            opt.setName('genre')
                .setDescription('The genre/tag to check (e.g. rock, k-pop)')
                .setRequired(true)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let genreName = isSlash 
            ? interactionOrMessage.options.getString('genre') || '' 
            : (args ? args.join(' ') : '');

        if (!genreName) {
            const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
            const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
            
            if (dbAuthor?.lastfmUsername) {
                const nowPlaying = await LastFM.getRecentTracks(dbAuthor.lastfmUsername, 1, dbAuthor.lastfmSessionKey);
                const track = nowPlaying?.[0];
                if (track) {
                    const artistName = track.artist?.['#text'] || track.artist?.name;
                    if (artistName) {
                        const topTags = await LastFM.getArtistTopTags(artistName);
                        if (topTags && topTags.length > 0) {
                            genreName = topTags[0].name;
                        }
                    }
                }
            }
        }

        if (!genreName) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Please specify a genre or scrobble something with tags first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        try {
            // 1. Fetch Global Leaders for Genre
            // Using raw query for the 4-way join + aggregation
            const leaders: any[] = await prisma.$queryRaw`
                SELECT u.discord_id as "discordId", u.lastfm_username as "lfmName", CAST(SUM(ua.playcount) AS INTEGER) as total
                FROM user_artists ua
                JOIN artists a ON ua.artist_id = a.id
                JOIN artist_tags at ON a.id = at.artist_id
                JOIN tags t ON at.tag_id = t.id
                JOIN users u ON ua.user_id = u.id
                WHERE t.name = ${genreName.toLowerCase().trim()}
                GROUP BY u.id, u.discord_id, u.lastfm_username
                ORDER BY total DESC
                LIMIT 50
            `;

            if (leaders.length === 0) {
                const payload = new ComponentsV2().addText(`Nobody globally knows the genre **${genreName}** yet. Data is enriched from Last.fm tags by the background worker.`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            // 2. Build Pagination
            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(leaders.length / perPage) || 1;

            const generatePayload = (page: number) => {
                const builder = new ComponentsV2().setAccent(embedColor);
                const start = (page - 1) * perPage;
                const slice = leaders.slice(start, start + perPage);

                const list = slice.map((k, i) => {
                    const rank = start + i + 1;
                    const discordTag = k.discordId ? `<@${k.discordId}>` : `**${k.lfmName}**`;
                    return `${rank}.\u2004\u2005${discordTag} — **${k.total.toLocaleString()}** plays`;
                }).join('\n');

                builder.addText(`### Global Leaders: **${genreName}**\n${list}`);
                builder.addText(`-# Based on top tags of the artists they listen to.`);

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
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch genre stats.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
