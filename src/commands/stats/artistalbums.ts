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

export default class ArtistAlbumsCommand extends BaseCommand {
    name = 'artistalbums';
    description = 'View your top albums for a specific artist';
    aliases = ['aa'];

    slashData = new SlashCommandBuilder()
        .setName('artistalbums')
        .setDescription('View your top albums for a specific artist')
        .addStringOption(opt => 
            opt.setName('artist')
                .setDescription('The artist name (leave blank for currently playing)')
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

        let artistQuery = '';
        let targetUserObj = null;

        if (isSlash) {
            artistQuery = interactionOrMessage.options.getString('artist') || '';
            targetUserObj = interactionOrMessage.options.getUser('user');
        } else {
            if (args && args.length > 0) {
                artistQuery = args.join(' ');
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
            if (!artistQuery) {
                if (!targetDbUser.lastfmUsername) {
                    throw new Error('No artist provided, and Last.fm account not linked to check current track.');
                }
                const recent = await LastFM.getRecentTracks(targetDbUser.lastfmUsername, 1, targetDbUser.lastfmSessionKey);
                if (!recent || recent.length === 0) {
                    throw new Error('No artist provided, and no recent track found to look up.');
                }
                artistQuery = recent[0].artist?.['#text'] || recent[0].artist?.name;
            }

            if (!artistQuery) throw new Error('Could not resolve an artist name.');

            // Fire & Forget background sync
            triggerDeltaSync(targetDbUser.discordId);

            const querySql = `
                SELECT album_name as album, CAST(COUNT(*) AS INTEGER) as playcount
                FROM user_plays
                WHERE user_id = '${targetDbUser.id}' 
                  AND artist_name ILIKE '${artistQuery.replace(/'/g, "''")}'
                  AND album_name IS NOT NULL
                GROUP BY album_name
                ORDER BY playcount DESC
            `;

            const results: any[] = await prisma.$queryRawUnsafe(querySql);

            if (results.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no logged album plays for **${artistQuery}**.`)
                    .build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const totalPlays = results.reduce((acc, a) => acc + a.playcount, 0);

            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(results.length / perPage) || 1;

            let thumbnail = null;
            try {
                const meta = await TrackResolverService.resolveArtist(artistQuery);
                if (meta?.avatarUrl) thumbnail = meta.avatarUrl;
            } catch {}

            const generatePayload = (page: number) => {
                const builder = new ComponentsV2().setAccent(embedColor);
                const start = (page - 1) * perPage;
                const slice = results.slice(start, start + perPage);

                const list = slice.map((a: any, i: number) => {
                    const rank = start + i + 1;
                    return `\`${rank}.\` **${a.album}** - **${a.playcount.toLocaleString()}** plays`;
                }).join('\n');

                builder.addText(`### Top Albums for ${artistQuery}\n${list}`);
                if (thumbnail) builder.setThumbnail(thumbnail);

                builder.addText(`-# Page ${page}/${totalPages} - ${totalPlays.toLocaleString()} total plays`);
                
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
