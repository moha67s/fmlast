import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService, TimePeriod } from '../../services/bot/SettingService';
import { StatsService } from '../../services/bot/StatsService';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { getBillboardLine } from '../../utils/billboard';
import { TrackResolverService } from '../../services/api/TrackResolverService';


export default class TopArtistsCommand extends BaseCommand {
    name = 'tar';
    description = 'View your top artists for a time period';
    aliases = ['topartists'];

    slashData = new SlashCommandBuilder()
        .setName('tar')
        .setDescription('View top artists for a time period')
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

        // 1. Resolve User and Time
        const userSettings = await SettingService.getUser(query, dbAuthor);
        const targetDbUser = userSettings.targetUser;
        const timeSettings = SettingService.getTimePeriod(userSettings.searchValue);
        const { amount } = SettingService.getAmount(timeSettings.searchValue, 10, 100);

        // Fire & Forget background sync
        triggerDeltaSync(targetDbUser.discordId);

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            let artists: any[] = [];

            // 2. Fetch Data
            if (timeSettings.apiParameter === 'overall') {
                // ALL-TIME: Read directly from pre-aggregated UserArtist table
                const dbArtists = await prisma.userArtist.findMany({
                    where: { userId: targetDbUser.id, playcount: { gt: 0 } },
                    orderBy: { playcount: 'desc' },
                    take: amount
                });
                artists = dbArtists.map(a => ({ 
                    name: a.artistName, 
                    playcount: String(a.playcount) 
                }));
            } else if (timeSettings.startDateTime && timeSettings.endDateTime) {
                // TIME-FILTERED: Use StatsService to group UserPlay table
                artists = await StatsService.getTopArtists(targetDbUser.id, timeSettings.startDateTime, timeSettings.endDateTime, amount);
            } else if (timeSettings.apiParameter === 'day') {
                // SPECIAL CASE: Last 24h
                const oneDayAgo = new Date(Date.now() - 86400 * 1000);
                artists = await StatsService.getTopArtists(targetDbUser.id, oneDayAgo, new Date(), amount);
            }

            // 3. Build Pagination
            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(artists.length / perPage) || 1;

            const generatePayload = async (page: number) => {
                const builder = new ComponentsV2().setAccent(userSettings.accentColor);
                const start = (page - 1) * perPage;
                const slice = artists.slice(start, start + perPage);

                if (artists.length === 0) {
                    builder.addText(`### Top ${timeSettings.description} Artists\n**${userSettings.displayName}** has no data for this period.`);
                    return builder.build();
                }

                const isBillboard = isSlash ? interactionOrMessage.options.getBoolean('billboard') ?? false : false;

                const list = slice.map((a: any, i: number) => {
                    const rank = start + i + 1;
                    const url = `https://www.last.fm/music/${encodeURIComponent(a.name)}`;
                    
                    if (isBillboard) {
                        return getBillboardLine(rank, null, a.name, '', parseInt(a.playcount), url);
                    } else {
                        return `\u2005${rank}.\u2004\u2005**[${a.name}](${url})\u200E** - **${parseInt(a.playcount).toLocaleString()}** plays`;
                    }
                }).join('\n');

                let thumbnail = null;
                if (page === 1 && artists.length > 0 && !isBillboard) {
                    try {
                        const top = artists[0];
                        const meta = await TrackResolverService.resolveArtist(top.name);
                        thumbnail = meta.avatarUrl;
                    } catch {}
                }

                const content = `### Top ${timeSettings.description} Artists for ${userSettings.displayName}\n${list}\n\n-# Page ${page}/${totalPages} - ${artists.length} total artists`;
                
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
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch top artists.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
