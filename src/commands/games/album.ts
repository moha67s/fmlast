import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import {
    SlashCommandBuilder,
    TextChannel,
    ButtonStyle,
    ComponentType,
    MessageFlags,
    AttachmentBuilder,
    ChannelType
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { AlbumGameService, AlbumRarity } from '../../services/bot/AlbumGameService';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { Spotify } from '../../services/api/Spotify';
import { LastFM } from '../../services/api/LastFM';
import { AlbumRenderService } from '../../services/bot/AlbumRenderService';
import { RenderCacheService } from '../../services/bot/RenderCacheService';
import { config } from '../../../config';
import axios from 'axios';

export default class AlbumCommand extends BaseCommand {
    name = 'album';
    description = 'Roll for and collect albums in your personal music collection!';
    aliases = ['ar', 'roll', 'claim'];

    slashData = new SlashCommandBuilder()
        .setName('album')
        .setDescription('Music Album Collection Game')
        .addSubcommand(sub =>
            sub.setName('roll')
                .setDescription('Roll for a random album to add to your collection')
        )
        .addSubcommand(sub =>
            sub.setName('collection')
                .setDescription('View your collected albums')
                .addUserOption(opt => opt.setName('user').setDescription('User to view collection of'))
        )
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription('View your game profile, Vinyls, and wishlist')
                .addUserOption(opt => opt.setName('user').setDescription('User to view profile of'))
        )
        .addSubcommand(sub =>
            sub.setName('wish')
                .setDescription('Add/remove an album from your wishlist')
                .addStringOption(opt => opt.setName('query').setDescription('Artist - Album').setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName('market')
                .setDescription('View and buy from the global album market')
        )
        .addSubcommand(sub =>
            sub.setName('daily')
                .setDescription('Claim your daily Vinyls and quota reset')
        )
        .addSubcommand(sub =>
            sub.setName('balance')
                .setDescription('Check your Vinyls balance')
                .addUserOption(opt => opt.setName('user').setDescription('User to check balance of'))
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const channel = interactionOrMessage.channel as TextChannel;
        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const subcommand = isSlash ? interactionOrMessage.options.getSubcommand() : (args?.[0] || 'roll');

        if (subcommand === 'roll' || subcommand === 'r') {
            await this.handleRoll(interactionOrMessage, isSlash, userId, channel);
        } else if (subcommand === 'collection' || subcommand === 'c' || subcommand === 'inv') {
            await this.handleCollection(interactionOrMessage, isSlash, userId, channel, 0);
        } else if (subcommand === 'profile' || subcommand === 'p') {
            await this.handleProfile(interactionOrMessage, isSlash, userId, channel);
        } else if (subcommand === 'wish' || subcommand === 'w') {
            await this.handleWishlist(interactionOrMessage, isSlash, userId, channel, args);
        } else if (subcommand === 'market' || subcommand === 'm' || subcommand === 'shop') {
            await this.handleMarket(interactionOrMessage, isSlash, userId, channel);
        } else if (subcommand === 'daily' || subcommand === 'd') {
            await this.handleDaily(interactionOrMessage, isSlash, userId, channel);
        } else if (subcommand === 'balance' || subcommand === 'b' || subcommand === 'bal') {
            await this.handleBalance(interactionOrMessage, isSlash, userId, channel);
        }
    }

    private async handleRoll(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel): Promise<void> {
        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId } });
            if (!dbUser) {
                const msg = '❌ Link your account first with `/login`!';
                isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
                return;
            }

            // 1. Quota & Cooldown Check (10 turns / 30 minutes)
            const COOLDOWN_MS = 30 * 60 * 1000;
            const MAX_ROLLS = 10;
            const now = Date.now();

            let rolls = dbUser.albumRolls;
            const lastRoll = dbUser.lastAlbumRoll;

            // If cooldown has passed, reset quota
            if (lastRoll && (now - lastRoll.getTime() >= COOLDOWN_MS)) {
                rolls = 0;
            }

            // Check if quota exhausted
            if (rolls >= MAX_ROLLS && lastRoll && (now - lastRoll.getTime() < COOLDOWN_MS)) {
                const remaining = Math.ceil((COOLDOWN_MS - (now - lastRoll.getTime())) / 60000);
                const msg = `⏳ Quota exhausted! You need to wait **${remaining}m** before your next batch of rolls.`;
                isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
                return;
            }

            // 2. Roll for Album
            const roll = await AlbumGameService.rollAlbum(discordId);
            if (!roll) {
                const msg = '😢 No albums found in the pool. Try again later.';
                isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
                return;
            }

            // Increment rolls
            const newRolls = rolls + 1;
            await prisma.user.update({
                where: { discordId },
                data: {
                    albumRolls: newRolls,
                    lastAlbumRoll: newRolls >= MAX_ROLLS ? new Date() : dbUser.lastAlbumRoll
                }
            });

            // Proxy the image to Discord CDN
            const proxiedImage = await this.proxyImage(roll.image, interactionOrMessage.client);

            // RPG: Check for duplicates
            const isOwned = await AlbumGameService.isOwned(discordId, roll.albumId);
            const scrapValue = AlbumGameService.getScrapValue(roll.rarity);

            // RPG: Check for wishlists
            const wishers = await AlbumGameService.getWishers(roll.albumId);
            const isWish = wishers.length > 0;

            // 3. Build Card UI
            const color = isWish ? 0xFF007F : AlbumGameService.getRarityColor(roll.rarity);
            let flavorText = this.getFlavorText(roll.rarity);
            if (isWish) flavorText = `✨ **A DIVINE MANIFESTATION!** ✨`;

            const builder = new ComponentsV2()
                .setAccent(color)
                .addText(`### 🎲 ALBUM ROLL\n${flavorText}\n**${roll.artistName}** — **${roll.albumName}**`)
                .setImage(proxiedImage || roll.image);

            if (isOwned) {
                builder.addText(`\n💿 **Duplicate!** You already own this album.\nConverted into **${scrapValue} Vinyls**.`);
                builder.addFooter(`Rarity: ${roll.rarity} • Rolls Left: ${MAX_ROLLS - newRolls}`);
                await AlbumGameService.awardVinyls(discordId, scrapValue);

                const payload = builder.build();
                isSlash ? await interactionOrMessage.editReply(payload) : await channel.send(payload);
                return;
            }

            if (isWish) {
                const wisherMentions = wishers.map(id => `<@${id}>`).join(', ');
                builder.addText(`\n🌟 **On wishlist of:** ${wisherMentions}`);
            }

            builder.addFooter(`Rarity: ${roll.rarity} • Rolls Left: ${MAX_ROLLS - newRolls} • Exclusive: 15s`);

            // Claim Button
            const claimId = `claim_album:${roll.albumId}:${roll.rarity}:${Date.now()}`;
            builder.addAction(`-# Priority claim for <@${discordId}>`, {
                type: ComponentType.Button,
                custom_id: claimId,
                label: 'Claim Album',
                emoji: { name: '📥' },
                style: ButtonStyle.Primary
            });

            const rollMsg = isSlash
                ? await interactionOrMessage.editReply(builder.build())
                : await channel.send(builder.build());

            // 4. Interaction Collector
            const collector = rollMsg.createMessageComponentCollector({
                filter: (i: any) => i.customId === claimId,
                time: 45000,
                max: 1
            });

            // Timer for Sniping
            let isSnipable = false;
            setTimeout(async () => {
                isSnipable = true;
                builder.addFooter(`Rarity: ${roll.rarity} • Rolls Left: ${MAX_ROLLS - newRolls} • OPEN FOR SNIPING!`);
                builder.payload.components[builder.payload.components.length - 2].components[0].content = `-# 🔓 **Open for anyone to claim!**`;
                await rollMsg.edit(builder.build()).catch(() => { });
            }, 15000);

            collector.on('collect', async (i: any) => {
                // Sniping Logic
                if (i.user.id !== discordId && !isSnipable) {
                    return i.reply({ content: '❌ Wait for the 15s priority window to end before sniping!', ephemeral: true });
                }

                await i.deferUpdate();
                const success = await AlbumGameService.claimAlbum(i.user.id, roll.albumId, roll.rarity);

                if (success) {
                    const claimedBuilder = new ComponentsV2()
                        .setAccent(0x4ade80)
                        .addText(`### ✅ ALBUM ${i.user.id === discordId ? 'CLAIMED' : 'SNIPED'}!\n**${roll.artistName}** — **${roll.albumName}** added to <@${i.user.id}>'s collection.`)
                        .setThumbnail(roll.image)
                        .addFooter(`Rarity: ${roll.rarity}`);

                    await i.editReply(claimedBuilder.build());
                } else {
                    await i.followUp({ content: '❌ Failed to claim. You might already own this or your quota is full!', ephemeral: true });
                }
            });

            collector.on('end', async (collected: any) => {
                if (collected.size === 0) {
                    const expiredBuilder = new ComponentsV2()
                        .setAccent(0x333333)
                        .addText(`### 🎲 ALBUM ROLL\n❌ **Claim period expired.**\n**${roll.artistName}** — **${roll.albumName}** returned to the pool.`)
                        .addFooter(`Rarity: ${roll.rarity}`);

                    if (isSlash) await interactionOrMessage.editReply(expiredBuilder.build());
                    else await rollMsg.edit(expiredBuilder.build()).catch(() => { });
                }
            });

        } catch (err) {
            console.error('Album Roll Error:', err);
            const msg = '⚠️ Failed to generate roll.';
            isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
        }
    }

    private async handleCollection(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel, startPage = 0, overrideTargetId?: string): Promise<void> {
        const targetId = overrideTargetId || (isSlash && interactionOrMessage.options?.getUser
            ? (interactionOrMessage.options.getUser('user')?.id || discordId)
            : discordId);

        if (isSlash && !interactionOrMessage.deferred && !interactionOrMessage.replied) await interactionOrMessage.deferReply();
        else if (!isSlash && startPage === 0) { try { channel.sendTyping(); } catch { } }

        const totalResult = await AlbumGameService.getCollection(targetId, 0, 1);
        if (!totalResult || totalResult.count === 0) {
            const msg = targetId === discordId ? '❌ Your collection is empty! Use `/album roll` to start.' : `❌ <@${targetId}>'s collection is empty.`;
            isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
            return;
        }
        const totalItems = totalResult.count;
        let currentPage = Math.max(0, Math.min(startPage, totalItems - 1));
        let listPage = 0;
        const LIST_LIMIT = 10;

        // ── Card mode payload ──
        const buildCardPayload = async (page: number) => {
            const collection = await AlbumGameService.getCollection(targetId, page, 1);
            const item = collection!.items[0];
            const artist = item.album.artist.name;
            const albumName = item.album.name;
            const rarity = item.rarity as AlbumRarity;

            const claimedDate = new Date(item.claimedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

            // ── 1. CHECK RENDER CACHE ──
            const cacheKey = `${albumName}:${rarity}`;
            let cdnUrl = await RenderCacheService.getCachedImage('album_card', artist, cacheKey);
            let cardBuffer: Buffer | null = null;

            if (!cdnUrl) {
                const resolved = await TrackResolverService.resolveAlbum(artist, albumName);
                const artworkUrl = resolved.artworkUrl || item.album.imageLarge || 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';

                cardBuffer = await AlbumRenderService.renderAlbumCard({
                    artistName: artist,
                    albumName: albumName,
                    image: artworkUrl,
                    rarity: rarity
                });

                // ── 2. UPLOAD TO STAGING CHANNEL FOR CDN URL ──
                const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
                const client = interactionOrMessage.client;
                if (stagingChannelId && client) {
                    try {
                        const stagingChannel = await client.channels.fetch(stagingChannelId) as TextChannel;
                        if (stagingChannel?.type === ChannelType.GuildText) {
                            const att = new AttachmentBuilder(cardBuffer, { name: `album_${item.album.id}.webp` });
                            const stagingMsg = await stagingChannel.send({ files: [att] });
                            cdnUrl = stagingMsg.attachments.first()?.url || null;

                            if (cdnUrl) {
                                await RenderCacheService.setCachedImage('album_card', artist, cacheKey, cdnUrl);
                                setTimeout(() => stagingMsg.delete().catch(() => {}), 86400000);
                            }
                        }
                    } catch (e) {
                        console.warn('[album] Staging upload failed:', e);
                    }
                }
            }

            const builder = new ComponentsV2()
                .setAccent(AlbumGameService.getRarityColor(rarity))
                .addText(`### 🗃️ SOUNDSCAPE ARCHIVE (#${page + 1}/${totalItems})\nViewing collection for <@${targetId}>\n-# 📅 Claimed on ${claimedDate}`)
                .setImage(cdnUrl ?? 'attachment://album_card.webp');

            const row: any[] = [];
            if (page > 0) row.push({
                type: ComponentType.Button, style: ButtonStyle.Secondary,
                label: 'Back', custom_id: 'col_prev', emoji: { name: '⬅️' }
            });
            row.push({
                type: ComponentType.Button, style: ButtonStyle.Secondary,
                label: 'List', custom_id: 'col_list', emoji: { name: '📋' }
            });
            if (page < totalItems - 1) row.push({
                type: ComponentType.Button, style: ButtonStyle.Secondary,
                label: 'Next', custom_id: 'col_next', emoji: { name: '➡️' }
            });
            builder.addRow(row);

            const payload: any = builder.build();
            if (!cdnUrl) {
                if (!cardBuffer) {
                    const resolved = await TrackResolverService.resolveAlbum(artist, albumName);
                    const artworkUrl = resolved.artworkUrl || item.album.imageLarge || 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png';
                    cardBuffer = await AlbumRenderService.renderAlbumCard({
                        artistName: artist,
                        albumName: albumName,
                        image: artworkUrl,
                        rarity: rarity
                    });
                }
                payload.files = [new AttachmentBuilder(cardBuffer, { name: 'album_card.webp' })];
            }
            return payload;
        };

        // ── List mode payload ──
        const buildListPayload = async (lPage: number) => {
            const totalListPages = Math.ceil(totalItems / LIST_LIMIT);
            const collection = await AlbumGameService.getCollection(targetId, lPage, LIST_LIMIT);

            let listText = '';
            for (const item of collection!.items) {
                const rarityEmoji = this.getRarityEmoji(item.rarity as AlbumRarity);
                const claimed = new Date(item.claimedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                listText += `${rarityEmoji} **${item.album.artist.name}** — ${item.album.name}\n-# 📅 ${claimed}\n`;
            }

            const builder = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(`### 📋 ALBUM COLLECTION (${lPage + 1}/${totalListPages})\nViewing collection for <@${targetId}>\n\n${listText}`);

            const row: any[] = [];
            if (lPage > 0) row.push({
                type: ComponentType.Button, style: ButtonStyle.Secondary,
                label: 'Back', custom_id: 'col_list_prev', emoji: { name: '⬅️' }
            });
            row.push({
                type: ComponentType.Button, style: ButtonStyle.Primary,
                label: 'Card View', custom_id: 'col_card', emoji: { name: '🖼️' }
            });
            if (lPage < totalListPages - 1) row.push({
                type: ComponentType.Button, style: ButtonStyle.Secondary,
                label: 'Next', custom_id: 'col_list_next', emoji: { name: '➡️' }
            });
            builder.addRow(row);

            return builder.build();
        };

        // Initial send
        const payload = await buildCardPayload(currentPage);
        const msg = isSlash
            ? await interactionOrMessage.editReply(payload)
            : await channel.send(payload);

        // Single persistent collector handling all modes
        const COL_IDS = ['col_prev', 'col_next', 'col_list', 'col_card', 'col_list_prev', 'col_list_next'];
        const collector = msg.createMessageComponentCollector({
            filter: (i: any) => COL_IDS.includes(i.customId),
            time: 300000
        });

        collector.on('collect', async (i: any) => {
            if (i.user.id !== discordId) {
                return i.reply({ content: '❌ Open your own collection to browse!', ephemeral: true });
            }
            await i.deferUpdate();

            switch (i.customId) {
                case 'col_prev':
                    currentPage = Math.max(0, currentPage - 1);
                    await i.editReply(await buildCardPayload(currentPage));
                    break;
                case 'col_next':
                    currentPage = Math.min(totalItems - 1, currentPage + 1);
                    await i.editReply(await buildCardPayload(currentPage));
                    break;
                case 'col_list':
                    await i.editReply(await buildListPayload(listPage));
                    break;
                case 'col_card':
                    await i.editReply(await buildCardPayload(currentPage));
                    break;
                case 'col_list_prev':
                    listPage = Math.max(0, listPage - 1);
                    await i.editReply(await buildListPayload(listPage));
                    break;
                case 'col_list_next':
                    listPage = Math.min(Math.ceil(totalItems / LIST_LIMIT) - 1, listPage + 1);
                    await i.editReply(await buildListPayload(listPage));
                    break;
            }
        });
    }


    private async handleProfile(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel): Promise<void> {
        const targetId = isSlash ? (interactionOrMessage.options.getUser('user')?.id || discordId) : discordId;

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        const dbUser = await prisma.user.findUnique({
            where: { discordId: targetId },
            include: { gameProfile: true }
        });

        if (!dbUser) {
            isSlash ? await interactionOrMessage.editReply('❌ User not found.') : await channel.send('❌ User not found.');
            return;
        }

        const profile = dbUser.gameProfile || await AlbumGameService.getGameProfile(targetId);
        const collection = await AlbumGameService.getCollection(targetId, 0, 1); // Get count

        // Fetch Last.fm info for thumbnail
        let lfmInfo: any = null;
        try {
            if (dbUser.lastfmUsername) {
                lfmInfo = await LastFM.getUserInfo(dbUser.lastfmUsername, dbUser.lastfmSessionKey);
            }
        } catch (err) {
            console.warn(`[AlbumCommand] Failed to fetch Last.fm info for ${dbUser.lastfmUsername}:`, err instanceof Error ? err.message : err);
        }

        const thumbnail = lfmInfo?.image?.find((img: any) => img.size === 'extralarge')?.['#text']
            || lfmInfo?.image?.find((img: any) => img.size === 'large')?.['#text'];

        const settings = dbUser.settings as any;
        const color = settings?.embedColor ? parseInt(settings.embedColor.replace('#', ''), 16) : 0x5865F2;

        const builder = new ComponentsV2()
            .setAccent(color);

        let mainText = `### 👤 SOUNDSCAPE PROFILE: <@${targetId}>\n`;
        mainText += `📀 **Collection**: \`${collection?.count || 0}\` albums\n`;
        mainText += `💿 **Vinyls**: **${profile.vinylScraps}**\n`;
        mainText += `⭐ **Wishlist**: \`${profile.wishlist.length}/5\` slots used\n`;

        if (lfmInfo) {
            mainText += `📊 **Total Scrobbles**: \`${parseInt(lfmInfo.playcount).toLocaleString()}\` plays\n`;
        }

        builder.addThumbnail(thumbnail, mainText);

        if (profile.wishlist.length > 0) {
            const albums = await prisma.album.findMany({
                where: { id: { in: profile.wishlist } },
                include: { artist: true }
            });
            let wishText = '';
            albums.forEach(a => wishText += `- ${a.artist.name} — **${a.name}**\n`);
            builder.addText(`\n**CURRENT WISHES:**\n${wishText}`);
        } else {
            builder.addText(`\n-# *Wishlist is empty. Use \`/album wish\` to manifest albums!*`);
        }

        const payload = builder.build();
        isSlash ? await interactionOrMessage.editReply(payload) : await channel.send(payload);
    }

    private async handleWishlist(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel, args?: string[]): Promise<void> {
        const query = isSlash ? interactionOrMessage.options.getString('query') : args?.slice(1).join(' ');
        if (!query) {
            const msg = '❌ Usage: `/album wish Artist Album` or `/album wish Artist - Album`';
            isSlash ? await interactionOrMessage.reply(msg) : await channel.send(msg);
            return;
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        const reply = (msg: string) => isSlash ? interactionOrMessage.editReply(msg) : channel.send(msg);

        // Smart fuzzy search strategy:
        // 1. If there's a dash, try "Artist - Album" split first
        // 2. Also try fuzzy DB search on raw query
        // 3. Fall back to API resolver

        let dbAlbum: any = null;

        // Strategy 1: dash split → exact DB match
        if (query.includes('-')) {
            const dashIdx = query.indexOf('-');
            const artistPart = query.substring(0, dashIdx).trim();
            const albumPart = query.substring(dashIdx + 1).trim();

            if (artistPart && albumPart) {
                dbAlbum = await prisma.album.findFirst({
                    where: {
                        name: { contains: albumPart, mode: 'insensitive' },
                        artist: { name: { contains: artistPart, mode: 'insensitive' } }
                    },
                    include: { artist: true }
                });
            }
        }

        // Strategy 2: fuzzy DB search — treat whole query as album name
        if (!dbAlbum) {
            // Try to find an album whose name contains some part of the query
            const words = query.split(/\s+/);
            // Try full query as album name first
            dbAlbum = await prisma.album.findFirst({
                where: { name: { contains: query, mode: 'insensitive' } },
                include: { artist: true }
            });

            // If not found, try matching any 3+ consecutive words
            if (!dbAlbum && words.length >= 2) {
                for (let len = words.length; len >= 2; len--) {
                    for (let start = 0; start <= words.length - len; start++) {
                        const phrase = words.slice(start, start + len).join(' ');
                        const found = await prisma.album.findFirst({
                            where: { name: { contains: phrase, mode: 'insensitive' } },
                            include: { artist: true }
                        });
                        if (found) { dbAlbum = found; break; }
                    }
                    if (dbAlbum) break;
                }
            }
        }

        // Strategy 3: API resolver with smart guess using Spotify search
        if (!dbAlbum) {
            const spMatch = await Spotify.searchAlbum(query);
            if (spMatch && spMatch.artist && spMatch.album) {
                const dbArtist = await prisma.artist.findFirst({ where: { name: { contains: spMatch.artist, mode: 'insensitive' } } });
                if (dbArtist) {
                    dbAlbum = await prisma.album.findFirst({
                        where: { artistId: dbArtist.id, name: { contains: spMatch.album, mode: 'insensitive' } },
                        include: { artist: true }
                    });
                }
            }
        }

        if (!dbAlbum) {
            await reply(`❌ Couldn't find **"${query}"** in anyone's collection yet. Try being more specific or check the spelling!`);
            return;
        }

        const profile = await AlbumGameService.getGameProfile(discordId);
        const isOnWishlist = profile?.wishlist.includes(dbAlbum.id);


        if (isOnWishlist) {
            await AlbumGameService.updateWishlist(discordId, dbAlbum.id, 'remove');
            const msg = `✅ Removed **${dbAlbum.name}** from your wishlist.`;
            isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
        } else {
            const success = await AlbumGameService.updateWishlist(discordId, dbAlbum.id, 'add');
            if (success) {
                const msg = `✨ Added **${dbAlbum.name}** to your wishlist!`;
                isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
            } else {
                const msg = '❌ Your wishlist is full (max 5)!';
                isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
            }
        }
    }


    private async handleMarket(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel): Promise<void> {
        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        let items = await AlbumGameService.getMarketItems();
        if (items.length === 0) {
            await AlbumGameService.refreshMarket();
            items = await AlbumGameService.getMarketItems();
        }

        if (items.length === 0) {
            const msg = '_The market is currently empty. Check back soon!_';
            isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
            return;
        }

        const profile = await AlbumGameService.getGameProfile(discordId);
        let currentIndex = 0;

        const buildPayload = async (idx: number) => {
            const item = items[idx];
            const expiresAt = item.expiresAt;
            const msLeft = expiresAt ? Math.max(0, expiresAt.getTime() - Date.now()) : 0;
            const hoursLeft = Math.floor(msLeft / 3600000);
            const minsLeft = Math.floor((msLeft % 3600000) / 60000);
            const timeStr = hoursLeft > 0 ? `${hoursLeft}h ${minsLeft}m` : `${minsLeft}m`;
            const rarityEmoji = this.getRarityEmoji(item.rarity as AlbumRarity);
            const color = AlbumGameService.getRarityColor(item.rarity as AlbumRarity);

            // Cache-backed artwork
            const resolved = await TrackResolverService.resolveAlbum(item.album.artist.name, item.album.name);
            let proxiedImage = await AlbumGameService.getCachedProxyUrl(resolved.artworkUrl || '');
            if (!proxiedImage && resolved.artworkUrl) {
                proxiedImage = await this.proxyImage(resolved.artworkUrl, interactionOrMessage.client);
                if (proxiedImage) await AlbumGameService.cacheProxyUrl(resolved.artworkUrl, proxiedImage);
            }

            const builder = new ComponentsV2()
                .setAccent(color)
                .addText(`### 🏪 GLOBAL MARKET (#${idx + 1}/${items.length})\n`)
                .addText(`${rarityEmoji} **${item.album.artist.name}** — **${item.album.name}**\n`)
                .addText(`Price: **${item.price}** 💿  |  Balance: **${profile?.vinylScraps || 0}** 💿\n`)
                .addText(`\n-# ⏳ Refreshes in **${timeStr}**`)
                .setImage(proxiedImage || resolved.artworkUrl || 'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png');

            const navRow: any[] = [];
            if (idx > 0) navRow.push({
                type: ComponentType.Button, style: ButtonStyle.Secondary,
                label: 'Prev', custom_id: 'mkt_prev', emoji: { name: '⬅️' }
            });
            navRow.push({
                type: ComponentType.Button, style: ButtonStyle.Primary,
                label: `Buy for ${item.price} Vinyls`, custom_id: `mkt_buy:${item.id}`, emoji: { name: '🛒' }
            });
            if (idx < items.length - 1) navRow.push({
                type: ComponentType.Button, style: ButtonStyle.Secondary,
                label: 'Next', custom_id: 'mkt_next', emoji: { name: '➡️' }
            });
            builder.addRow(navRow);

            return builder.build();
        };

        // Initial send
        const payload = await buildPayload(currentIndex);
        const msg = isSlash
            ? await interactionOrMessage.editReply(payload)
            : await channel.send(payload);

        // Single stateful collector — no recursion
        const collector = msg.createMessageComponentCollector({
            filter: (i: any) => i.customId.startsWith('mkt_'),
            time: 120000
        });

        collector.on('collect', async (i: any) => {
            if (i.user.id !== discordId) {
                return i.reply({ content: '❌ Open the market yourself to browse!', ephemeral: true });
            }

            await i.deferUpdate();

            if (i.customId === 'mkt_prev') {
                currentIndex = Math.max(0, currentIndex - 1);
                await i.editReply(await buildPayload(currentIndex));

            } else if (i.customId === 'mkt_next') {
                currentIndex = Math.min(items.length - 1, currentIndex + 1);
                await i.editReply(await buildPayload(currentIndex));

            } else if (i.customId.startsWith('mkt_buy:')) {
                const marketId = i.customId.split(':')[1];
                const result = await AlbumGameService.buyFromMarket(i.user.id, marketId);
                if (result.success) {
                    const successPayload = new ComponentsV2()
                        .setAccent(0x4ade80)
                        .addText(`### ✅ Purchase Complete!\n${result.msg}`)
                        .build();
                    await i.editReply(successPayload);
                    collector.stop();
                } else {
                    // Errors go as ephemeral followUp (allowed as plain content since it's a new message)
                    await i.followUp({ content: `❌ ${result.msg}`, ephemeral: true });
                }
            }
        });
    }


    private async handleDaily(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel): Promise<void> {
        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        const result = await AlbumGameService.claimDaily(discordId);

        if (result.success) {
            const builder = new ComponentsV2()
                .setAccent(0x4ade80)
                .addText(`### 🎁 DAILY REWARDS CLAIMED!\n\n`)
                .addText(`💿 Received **${result.scraps} Vinyls**\n`)
                .addText(`🎲 **Roll Quota Reset!** (You can roll 10 times again)\n\n`)
                .addFooter(`Come back in 6 hours for more!`);

            const payload = builder.build();
            isSlash ? await interactionOrMessage.editReply(payload) : await channel.send(payload);
        } else {
            if (result.cooldown) {
                const hours = Math.floor(result.cooldown / 3600000);
                const minutes = Math.floor((result.cooldown % 3600000) / 60000);
                const msg = `⏳ You've already claimed your daily! Come back in **${hours}h ${minutes}m**.`;
                isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
            } else {
                const msg = '❌ Failed to claim daily rewards.';
                isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
            }
        }
    }

    private async handleBalance(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel): Promise<void> {
        const targetId = isSlash ? (interactionOrMessage.options.getUser('user')?.id || discordId) : discordId;

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        const profile = await AlbumGameService.getGameProfile(targetId);
        if (!profile) {
            isSlash ? await interactionOrMessage.editReply('❌ User not found.') : await channel.send('❌ User not found.');
            return;
        }

        const msg = targetId === discordId
            ? `💳 You have **${profile.vinylScraps}** Vinyls.`
            : `💳 <@${targetId}> has **${profile.vinylScraps}** Vinyls.`;

        isSlash ? await interactionOrMessage.editReply(msg) : await channel.send(msg);
    }

    private getRarityEmoji(rarity: AlbumRarity): string {
        switch (rarity) {
            case AlbumRarity.LEGENDARY: return '🌟';
            case AlbumRarity.EPIC: return '💎';
            case AlbumRarity.RARE: return '🔵';
            default: return '⚪';
        }
    }

    private getFlavorText(rarity: AlbumRarity): string {
        switch (rarity) {
            case AlbumRarity.LEGENDARY: return '✨ **A DIVINE DISCOVERY!** ✨';
            case AlbumRarity.EPIC: return '🔥 **AN EPIC FIND!**';
            case AlbumRarity.RARE: return '💎 **A RARE TREASURE!**';
            default: return '💿 **New discovery!**';
        }
    }

    private async proxyImage(url: string, client: any): Promise<string | null> {
        if (!url) return null;
        try {
            const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
            if (!stagingChannelId) return url;

            const stagingChannel = await client.channels.fetch(stagingChannelId) as TextChannel | null;
            if (!stagingChannel || (stagingChannel.type !== ChannelType.GuildText && stagingChannel.type !== ChannelType.PublicThread && stagingChannel.type !== ChannelType.PrivateThread)) {
                return url;
            }

            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data, 'binary');

            const attachment = new AttachmentBuilder(buffer, { name: 'roll-artwork.webp' });
            const msg = await stagingChannel.send({ files: [attachment] });
            const cdnUrl = msg.attachments.first()?.url || null;

            // Optional: delete after some time to save space, but Discord CDN links usually persist for a while
            setTimeout(() => msg.delete().catch(() => { }), 3600000); // 1 hour

            return cdnUrl;
        } catch (err) {
            console.error('[AlbumGame] Proxy failed:', err);
            return url;
        }
    }
}
