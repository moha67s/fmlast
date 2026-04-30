import {
  BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class ServerCommand extends BaseCommand {
    name = 'server';
    description = 'View aggregate statistics for the current server';
    aliases = ['serverstats'];

    slashData = new SlashCommandBuilder()
        .setName('server')
        .setDescription('View aggregate statistics for the current server')
        .addSubcommand(sub => 
            sub.setName('artists')
               .setDescription('Top artists across the entire server')
        )
        .addSubcommand(sub => 
            sub.setName('albums')
               .setDescription('Top albums across the entire server')
        )
        .addSubcommand(sub => 
            sub.setName('tracks')
               .setDescription('Top tracks across the entire server')
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let subcommand = 'artists';

        if (isSlash) {
            subcommand = interactionOrMessage.options.getSubcommand() || 'artists';
        } else {
            if (args && args.length > 0) {
                const sub = args[0].toLowerCase();
                if (['artists', 'albums', 'tracks'].includes(sub)) {
                    subcommand = sub;
                }
            }
        }

        const guild = interactionOrMessage.guild;
        if (!guild) {
            const reply = '❌ This command can only be used in a server.';
            return isSlash ? interactionOrMessage.reply(reply) : interactionOrMessage.reply(reply);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            let discordIds: string[] = [];
            try {
                // Try fetching first 10,000 members to avoid rate limits on massive servers
                const members = await guild.members.fetch({ limit: 10000 });
                discordIds = Array.from(members.keys());
            } catch (err) {
                // Fallback to cache if rate limited (Opcode 8 error)
                console.warn(`[ServerStats] Failed to fetch members for ${guild.id}, falling back to cache.`);
                discordIds = Array.from(guild.members.cache.keys());
            }

            // 2. Map to local DB user IDs
            const dbUsers = await prisma.user.findMany({
                where: { discordId: { in: discordIds } },
                select: { id: true, discordId: true }
            });

            if (dbUsers.length === 0) {
                const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ No registered users found in this server.').build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const userIds = dbUsers.map(u => u.id);

            // 3. Aggregate based on subcommand using raw SQL for speed
            let results: any[] = [];
            let title = '';

            // We must format the array for Postgres ANY()
            const idList = userIds.map(id => `'${id}'`).join(',');

            if (subcommand === 'artists') {
                title = 'Top Artists';
                const querySql = `
                    SELECT artist_name as name, CAST(SUM(playcount) AS INTEGER) as total_plays
                    FROM user_artists
                    WHERE user_id IN (${idList})
                    GROUP BY artist_name
                    ORDER BY total_plays DESC
                    LIMIT 100
                `;
                results = await prisma.$queryRawUnsafe(querySql);
            } else if (subcommand === 'albums') {
                title = 'Top Albums';
                const querySql = `
                    SELECT album_name as name, artist_name as artist, CAST(SUM(playcount) AS INTEGER) as total_plays
                    FROM user_albums
                    WHERE user_id IN (${idList})
                    GROUP BY album_name, artist_name
                    ORDER BY total_plays DESC
                    LIMIT 100
                `;
                results = await prisma.$queryRawUnsafe(querySql);
            } else if (subcommand === 'tracks') {
                title = 'Top Tracks';
                const querySql = `
                    SELECT track_name as name, artist_name as artist, CAST(SUM(playcount) AS INTEGER) as total_plays
                    FROM user_tracks
                    WHERE user_id IN (${idList})
                    GROUP BY track_name, artist_name
                    ORDER BY total_plays DESC
                    LIMIT 100
                `;
                results = await prisma.$queryRawUnsafe(querySql);
            }

            if (results.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`No data found for the server.`)
                    .build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(results.length / perPage) || 1;

            const generatePayload = (page: number) => {
                const builder = new ComponentsV2().setAccent(embedColor);
                const start = (page - 1) * perPage;
                const slice = results.slice(start, start + perPage);

                const list = slice.map((r: any, i: number) => {
                    const rank = start + i + 1;
                    let line = `\`${rank}.\` **${r.name}**`;
                    if (r.artist) line += ` by **${r.artist}**`;
                    line += ` - **${r.total_plays.toLocaleString()}** plays`;
                    return line;
                }).join('\n');

                builder.addText(`### ${title} in ${guild.name}\n${list}`);
                builder.addText(`-# Page ${page}/${totalPages} - Data from ${userIds.length} linked users`);

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

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to fetch server stats: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
