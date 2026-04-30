import {
  BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { LastFM } from '../../services/api/LastFM';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class TagCommand extends BaseCommand {
    name = 'tag';
    description = 'Explore your top artists, albums, or tracks by genre/tag';
    aliases = ['genre'];

    slashData = new SlashCommandBuilder()
        .setName('tag')
        .setDescription('Explore your top scrobbles by tag')
        .addSubcommand(sub => 
            sub.setName('artists')
               .setDescription('Your top artists for a tag')
               .addStringOption(opt => opt.setName('name').setDescription('Tag name (e.g. indie, rock)').setRequired(true))
               .addUserOption(opt => opt.setName('user').setDescription('View for another user').setRequired(false))
        )
        .addSubcommand(sub => 
            sub.setName('albums')
               .setDescription('Your top albums for a tag')
               .addStringOption(opt => opt.setName('name').setDescription('Tag name').setRequired(true))
               .addUserOption(opt => opt.setName('user').setDescription('View for another user').setRequired(false))
        )
        .addSubcommand(sub => 
            sub.setName('tracks')
               .setDescription('Your top tracks for a tag')
               .addStringOption(opt => opt.setName('name').setDescription('Tag name').setRequired(true))
               .addUserOption(opt => opt.setName('user').setDescription('View for another user').setRequired(false))
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let subcommand = 'artists';
        let tagName = '';
        let targetUserObj = null;

        if (isSlash) {
            subcommand = interactionOrMessage.options.getSubcommand() || 'artists';
            tagName = interactionOrMessage.options.getString('name') || '';
            targetUserObj = interactionOrMessage.options.getUser('user');
        } else {
            if (args && args.length > 0) {
                const sub = args[0].toLowerCase();
                if (['artists', 'albums', 'tracks'].includes(sub)) {
                    subcommand = sub;
                    tagName = args.slice(1).join(' ');
                } else {
                    subcommand = 'artists';
                    tagName = args.join(' ');
                }
            }
        }

        // If no tag name provided, try to auto-detect from currently playing artist
        if (!tagName) {
            const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
            const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
            if (dbAuthor?.lastfmUsername) {
                try {
                    const recent = await LastFM.getRecentTracks(dbAuthor.lastfmUsername, 1, dbAuthor.lastfmSessionKey);
                    const track = recent?.[0];
                    if (track) {
                        const artistName = track.artist?.['#text'] || track.artist?.name;
                        if (artistName) {
                            const tags = await LastFM.getArtistTopTags(artistName);
                            if (tags && tags.length > 0) {
                                tagName = tags[0].name;
                            }
                        }
                    }
                } catch { }
            }

            if (!tagName) {
                const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Please specify a tag name or scrobble something so I can auto-detect the genre.').build();
                if (isSlash) return interactionOrMessage.reply(payload);
                else return interactionOrMessage.reply(payload);
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
            triggerDeltaSync(targetDbUser.discordId);

            // Fetch top global items for this tag (limit 250 to get a good intersection)
            let globalItems: any[] = [];
            let results: any[] = [];
            let title = '';

            if (subcommand === 'artists') {
                title = 'Artists';
                globalItems = await LastFM.getTagTopArtists(tagName, 250);
                const globalNames = globalItems.map(i => i.name.toLowerCase());

                const userArtists = await prisma.userArtist.findMany({
                    where: { userId: targetDbUser.id },
                    orderBy: { playcount: 'desc' },
                    take: 500
                });

                for (const ua of userArtists) {
                    if (globalNames.includes(ua.artistName.toLowerCase())) {
                        results.push({ name: ua.artistName, playcount: ua.playcount });
                    }
                }
            } else if (subcommand === 'albums') {
                title = 'Albums';
                globalItems = await LastFM.getTagTopAlbums(tagName, 250);
                const globalNames = globalItems.map(i => i.name.toLowerCase());

                const userAlbums = await prisma.userAlbum.findMany({
                    where: { userId: targetDbUser.id },
                    orderBy: { playcount: 'desc' },
                    take: 500
                });

                for (const ua of userAlbums) {
                    if (globalNames.includes(ua.albumName.toLowerCase())) {
                        results.push({ name: `${ua.albumName} (by ${ua.artistName})`, playcount: ua.playcount });
                    }
                }
            } else if (subcommand === 'tracks') {
                title = 'Tracks';
                globalItems = await LastFM.getTagTopTracks(tagName, 250);
                const globalNames = globalItems.map(i => i.name.toLowerCase());

                const userTracks = await prisma.userTrack.findMany({
                    where: { userId: targetDbUser.id },
                    orderBy: { playcount: 'desc' },
                    take: 500
                });

                for (const ut of userTracks) {
                    if (globalNames.includes(ut.trackName.toLowerCase())) {
                        results.push({ name: `${ut.trackName} (by ${ut.artistName})`, playcount: ut.playcount });
                    }
                }
            }

            if (results.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no top ${title.toLowerCase()} tagged as **${tagName}**.`)
                    .build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            // Sort by playcount descending
            results.sort((a, b) => b.playcount - a.playcount);

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

                builder.addText(`### Top ${title} for tag: ${tagName}\n${list}`);
                builder.addText(`-# Page ${page}/${totalPages} - Filtered from top 250 global items for ${userSettings.displayName}`);

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
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to fetch tag info: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
