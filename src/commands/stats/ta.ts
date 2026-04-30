import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { StatsService } from '../../services/bot/StatsService';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { getBillboardLine } from '../../utils/billboard';
import { TrackResolverService } from '../../services/api/TrackResolverService';

export default class TopAlbumsCommand extends BaseCommand {
    name = 'ta';
    description = 'View your top albums for a time period';
    aliases = ['topalbums'];

    slashData = new SlashCommandBuilder()
        .setName('ta')
        .setDescription('View top albums for a time period')
        .addStringOption((opt: any) =>
            opt.setName('query')
                .setDescription('Time period (e.g. 1m, 2023) or user mention')
                .setRequired(false)
        )
        .addBooleanOption((opt: any) => 
            opt.setName('billboard')
                .setDescription('Use billboard formatting mode')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const query = isSlash 
            ? interactionOrMessage.options.getString('query') || '' 
            : (args ? args.join(' ') : '');

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        const userSettings = await SettingService.getUser(query, dbAuthor);
        const targetDbUser = userSettings.targetUser;
        const timeSettings = SettingService.getTimePeriod(userSettings.searchValue);
        const { amount } = SettingService.getAmount(timeSettings.searchValue, 10, 100);

        // Fire & Forget background sync
        triggerDeltaSync(targetDbUser.discordId);

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            let albums: any[] = [];

            if (timeSettings.apiParameter === 'overall') {
                // ALL-TIME: Read directly from pre-aggregated UserAlbum table
                const dbAlbums = await prisma.userAlbum.findMany({
                    where: { userId: targetDbUser.id, playcount: { gt: 0 } },
                    orderBy: { playcount: 'desc' },
                    take: amount
                });
                albums = dbAlbums.map(a => ({ 
                    name: a.albumName, 
                    artist: { name: a.artistName }, 
                    playcount: String(a.playcount) 
                }));
            } else if (timeSettings.startDateTime && timeSettings.endDateTime) {
                // TIME-FILTERED: Use StatsService to group UserPlay table
                const dbAlbums = await StatsService.getTopAlbums(targetDbUser.id, timeSettings.startDateTime, timeSettings.endDateTime, amount);
                albums = dbAlbums.map(a => ({ 
                    name: a.name, 
                    artist: { name: a.artistName }, 
                    playcount: String(a.playcount) 
                }));
            } else if (timeSettings.apiParameter === 'day') {
                // DAILY
                const oneDayAgo = new Date(Date.now() - 86400 * 1000);
                const dbAlbums = await StatsService.getTopAlbums(targetDbUser.id, oneDayAgo, new Date(), amount);
                albums = dbAlbums.map(a => ({ 
                    name: a.name, 
                    artist: { name: a.artistName }, 
                    playcount: String(a.playcount) 
                }));
            }

            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(albums.length / perPage) || 1;

            const generatePayload = async (page: number) => {
                const builder = new ComponentsV2().setAccent(userSettings.accentColor);
                const start = (page - 1) * perPage;
                const slice = albums.slice(start, start + perPage);

                if (albums.length === 0) {
                    builder.addText(`### Top ${timeSettings.description} Albums\n**${userSettings.displayName}** has no data for this period.`);
                    return builder.build();
                }

                const isBillboard = isSlash ? interactionOrMessage.options.getBoolean('billboard') ?? false : false;

                const list = slice.map((a: any, i: number) => {
                    const rank = start + i + 1;
                    const artist = a.artist?.name || 'Unknown Artist';
                    const url = `https://www.last.fm/music/${encodeURIComponent(artist)}/${encodeURIComponent(a.name)}`;
                    
                    if (isBillboard) {
                        return getBillboardLine(rank, null, a.name, artist, parseInt(a.playcount), url);
                    } else {
                        return `\u2005${rank}.\u2004\u2005**[${a.name}](${url})\u200E** by **${artist}** - **${parseInt(a.playcount).toLocaleString()}** plays`;
                    }
                }).join('\n');

                let thumbnail = null;
                if (page === 1 && albums.length > 0 && !isBillboard) {
                    try {
                        const top = albums[0];
                        const meta = await TrackResolverService.resolveAlbum(top.artist.name, top.name);
                        thumbnail = meta.artworkUrl;
                    } catch {}
                }

                const content = `### Top ${timeSettings.description} Albums for ${userSettings.displayName}\n${list}\n\n-# Page ${page}/${totalPages} - ${albums.length} total albums`;
                
                if (thumbnail) {
                    builder.addThumbnail(thumbnail, content);
                } else {
                    builder.addText(content);
                }

                if (totalPages > 1) {
                    builder.addRow([
                        { type: 2, style: 2, custom_id: 'paginator_prev', emoji: { name: '◀️' }, disabled: page === 1 },
                        { type: 2, style: 2, custom_id: 'paginator_next', emoji: { name: '▶️' }, disabled: page === totalPages }
                    ]);
                }

                return builder.build();
            };

            const initialPayload = await generatePayload(currentPage);
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
                    await i.update(await generatePayload(currentPage));
                });
            }

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch top albums.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
