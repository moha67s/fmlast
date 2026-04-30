import {
  BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { Prisma } from '@prisma/client';
import { SlashCommandBuilder,
  TextChannel,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { LastfmHealthTracker } from '../../services/bot/LastfmHealthTracker';

export default class BillboardCommand extends BaseCommand {
    name = 'billboard';
    description = 'View top server tracks compared to the previous period.';
    aliases = ['bb', 'servertracks', 'st'];

    slashData = new SlashCommandBuilder()
        .setName('billboard')
        .setDescription('View top server tracks compared to the previous period.')
        .addStringOption((opt: any) =>
            opt.setName('query')
                .setDescription('Time period (e.g. 7d, 1m, 2023)')
                .setRequired(false)
        );

    // FMBot Emojis
    private emojis = {
        same_position: '➖',
        five_or_more_up: '⏫',
        one_to_five_up: '🔼',
        five_or_more_down: '⏬',
        one_to_five_down: '🔽',
        new: '🆕'
    };

    private getBillboardTrend(currentPos: number, previousPos: number | null): string {
        if (previousPos === null) return this.emojis.new;
        
        const diff = previousPos - currentPos; // Positive means moved UP in rank (closer to 1)

        if (diff === 0) return this.emojis.same_position;
        
        if (diff > 0) {
            if (diff >= 5) return this.emojis.five_or_more_up;
            return this.emojis.one_to_five_up;
        } else {
            if (Math.abs(diff) >= 5) return this.emojis.five_or_more_down;
            return this.emojis.one_to_five_down;
        }
    }

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const guild = interactionOrMessage.guild;
        if (!guild) {
            const reply = '❌ This command can only be used in a server.';
            return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
        }

        const query = isSlash 
            ? interactionOrMessage.options.getString('query') || '' 
            : (args ? args.join(' ') : '');

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { } }

        try {
            // 1. Resolve local users in the guild
            let members;
            try {
                members = await guild.members.fetch();
            } catch (e) {
                const msg = '❌ Failed to fetch server members.';
                return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
            }

            const discordIds = members.map((m: any) => m.id);
            const dbUsers = await prisma.user.findMany({
                where: { discordId: { in: discordIds } },
                select: { id: true, discordId: true, lastfmUsername: true }
            });

            if (dbUsers.length === 0) {
                const msg = '❌ No one in this server has linked their Last.fm account.';
                return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
            }

            const userIds = dbUsers.map(u => u.id);

            // 2. Determine Time Periods
            const timeSettings = SettingService.getTimePeriod(query);
            
            if (timeSettings.apiParameter === 'overall' || !timeSettings.startDateTime || !timeSettings.endDateTime) {
                const msg = '❌ Billboard mode requires a specific time period (e.g. `7d`, `1m`) to compare against. Overall is not supported.';
                return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
            }

            const currentStart = timeSettings.startDateTime;
            const currentEnd = timeSettings.endDateTime;
            
            const durationMs = currentEnd.getTime() - currentStart.getTime();
            const previousStart = new Date(currentStart.getTime() - durationMs);
            const previousEnd = new Date(currentStart.getTime() - 1);

            // 3. Run Native Postgres Aggregations!
            // We use user_plays table for time-filtered data.
            
            // CURRENT PERIOD
            const currentQuery: any[] = await prisma.$queryRaw`
                SELECT track_name, artist_name, COUNT(*) as playcount
                FROM user_plays
                WHERE user_id IN (${Prisma.join(userIds)})
                AND time_played >= ${currentStart}
                AND time_played <= ${currentEnd}
                GROUP BY track_name, artist_name
                ORDER BY playcount DESC
                LIMIT 100
            `;

            // PREVIOUS PERIOD
            const previousQuery: any[] = await prisma.$queryRaw`
                SELECT track_name, artist_name, COUNT(*) as playcount
                FROM user_plays
                WHERE user_id IN (${Prisma.join(userIds)})
                AND time_played >= ${previousStart}
                AND time_played <= ${previousEnd}
                GROUP BY track_name, artist_name
                ORDER BY playcount DESC
                LIMIT 500
            `; // Fetch deeper in case a track dropped out of the top 100

            if (currentQuery.length === 0) {
                const msg = `❌ No tracks were played in this server during the selected period.`;
                return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
            }

            // Create a lookup map for the previous period ranks
            const previousRanks = new Map<string, number>();
            previousQuery.forEach((row, i) => {
                const key = `${row.artist_name}|||${row.track_name}`.toLowerCase();
                previousRanks.set(key, i + 1); // 1-indexed
            });

            // 4. Combine and Compare
            const billboardItems = currentQuery.map((row, i) => {
                const currentPos = i + 1;
                const key = `${row.artist_name}|||${row.track_name}`.toLowerCase();
                const previousPos = previousRanks.get(key) || null;
                const trendEmoji = this.getBillboardTrend(currentPos, previousPos);

                return {
                    pos: currentPos,
                    trend: trendEmoji,
                    artist: row.artist_name,
                    track: row.track_name,
                    plays: Number(row.playcount)
                };
            });

            // 5. Pagination
            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(billboardItems.length / perPage) || 1;

            const generatePayload = (page: number) => {
                const builder = new ComponentsV2().setAccent(embedColor);
                const start = (page - 1) * perPage;
                const slice = billboardItems.slice(start, start + perPage);

                builder.addText(`### Top ${timeSettings.description.toLowerCase()} tracks in ${guild.name}`);
                builder.addSeparator();

                const list = slice.map((t) => {
                    return `${t.trend} \`${t.pos}\` · **${t.artist}** - **${t.track}** · *${t.plays} plays*`;
                }).join('\n');

                builder.addText(list);
                builder.addSeparator();

                // FMBot puts description at bottom
                builder.addText(`-# Listener count - Page ${page}/${totalPages}\n-# Comparing to ${previousStart.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} til ${previousEnd.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);

                if (totalPages > 1) {
                    builder.addRow([
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'bb_first', emoji: { id: '883825508633182208' }, disabled: page === 1 },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'bb_prev', emoji: { id: '883825508507336704' }, disabled: page === 1 },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'bb_next', emoji: { id: '883825508087922739' }, disabled: page === totalPages },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'bb_last', emoji: { id: '883825508482183258' }, disabled: page === totalPages }
                    ]);
                }

                return builder.build();
            };

            const initialPayload = generatePayload(currentPage);
            const message = isSlash 
                ? await interactionOrMessage.editReply({ ...initialPayload, fetchReply: true })
                : await interactionOrMessage.reply(initialPayload);

            if (totalPages > 1) {
                const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
                const collector = message.createMessageComponentCollector({
                    filter: (i: any) => i.user.id === authorId,
                    time: 60000
                });

                collector.on('collect', async (i: any) => {
                    if (i.customId === 'bb_first') currentPage = 1;
                    else if (i.customId === 'bb_prev') currentPage = Math.max(1, currentPage - 1);
                    else if (i.customId === 'bb_next') currentPage = Math.min(totalPages, currentPage + 1);
                    else if (i.customId === 'bb_last') currentPage = totalPages;
                    
                    await i.update(generatePayload(currentPage));
                });
            }

        } catch (err: any) {
            console.error('[billboard] error:', err);
            const msg = `❌ Failed to fetch billboard statistics.`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
        }
    }
}
