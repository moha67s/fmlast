import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class SearchCommand extends BaseCommand {
    name = 'find';
    description = 'Search your scrobbles for artists, albums, or tracks';
    aliases = ['f'];

    slashData = new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search your scrobbles')
        .addStringOption(opt =>
            opt.setName('type')
                .setDescription('What to search for')
                .setRequired(true)
                .addChoices(
                    { name: 'Artist', value: 'artist' },
                    { name: 'Album', value: 'album' },
                    { name: 'Track', value: 'track' }
                )
        )
        .addStringOption(opt =>
            opt.setName('query')
                .setDescription('Search term')
                .setRequired(true)
        )
        .addUserOption(opt =>
            opt.setName('user')
                .setDescription('Search for another user')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let searchType: 'artist' | 'album' | 'track' | 'all' = 'artist';
        let query = '';
        let targetUserObj = null;

        if (isSlash) {
            searchType = interactionOrMessage.options.getString('type') as any;
            query = interactionOrMessage.options.getString('query') || '';
            targetUserObj = interactionOrMessage.options.getUser('user');
        } else {
            if (!args || args.length === 0) {
                return interactionOrMessage.reply('❌ Usage: `.search <query>` or `.search <artist|album|track> <query>`');
            }
            const typeStr = args[0].toLowerCase();
            if (typeStr === 'artist' || typeStr === 'album' || typeStr === 'track') {
                searchType = typeStr;
                query = args.slice(1).join(' ');
            } else {
                // No type prefix — search all types with the full query
                searchType = 'all' as any;
                query = args.join(' ');
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
            let results: any[] = [];

            if (searchType === 'all') {
                const [artists, albums, tracks] = await Promise.all([
                    prisma.userArtist.findMany({
                        where: { userId: targetDbUser.id, artistName: { contains: query, mode: 'insensitive' } },
                        orderBy: { playcount: 'desc' },
                        take: 30
                    }),
                    prisma.userAlbum.findMany({
                        where: { userId: targetDbUser.id, albumName: { contains: query, mode: 'insensitive' } },
                        orderBy: { playcount: 'desc' },
                        take: 30
                    }),
                    prisma.userTrack.findMany({
                        where: { userId: targetDbUser.id, trackName: { contains: query, mode: 'insensitive' } },
                        orderBy: { playcount: 'desc' },
                        take: 30
                    })
                ]);
                results = [
                    ...artists.map(r => ({ name: `🎤 ${r.artistName}`, playcount: r.playcount })),
                    ...albums.map(r => ({ name: `💿 ${r.albumName} (by ${r.artistName})`, playcount: r.playcount })),
                    ...tracks.map(r => ({ name: `🎵 ${r.trackName} (by ${r.artistName})`, playcount: r.playcount }))
                ];
                results.sort((a, b) => b.playcount - a.playcount);
                results = results.slice(0, 100);
            } else if (searchType === 'artist') {
                results = await prisma.userArtist.findMany({
                    where: { userId: targetDbUser.id, artistName: { contains: query, mode: 'insensitive' } },
                    orderBy: { playcount: 'desc' },
                    take: 100
                });
                results = results.map(r => ({ name: r.artistName, playcount: r.playcount }));
            } else if (searchType === 'album') {
                results = await prisma.userAlbum.findMany({
                    where: { userId: targetDbUser.id, albumName: { contains: query, mode: 'insensitive' } },
                    orderBy: { playcount: 'desc' },
                    take: 100
                });
                results = results.map(r => ({ name: `${r.albumName} (by ${r.artistName})`, playcount: r.playcount }));
            } else if (searchType === 'track') {
                results = await prisma.userTrack.findMany({
                    where: { userId: targetDbUser.id, trackName: { contains: query, mode: 'insensitive' } },
                    orderBy: { playcount: 'desc' },
                    take: 100
                });
                results = results.map(r => ({ name: `${r.trackName} (by ${r.artistName})`, playcount: r.playcount }));
            }

            if (results.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no ${searchType}s matching \`${query}\`.`)
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
                    return `\`${rank}.\` **${r.name}** - **${r.playcount.toLocaleString()}** plays`;
                }).join('\n');

                builder.addText(`### Search Results: ${searchType} matching "${query}"\n${list}`);
                builder.addText(`-# Page ${page}/${totalPages} - ${results.length} results found for ${userSettings.displayName}`);

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
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to search: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
