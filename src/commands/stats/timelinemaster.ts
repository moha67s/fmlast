import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, TextChannel, ButtonStyle, ComponentType, AttachmentBuilder } from 'discord.js';
import { GameManager } from '../../utils/gameManager';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { resolveTargetUser } from '../../utils/userResolver';

export default class TimelineMasterCommand extends BaseCommand {
    name = 'timelinemaster';
    description = 'Sort 3 albums from your library by release year! 🗓️';
    aliases = ['tm', 'chronology'];

    slashData = new SlashCommandBuilder()
        .setName('timelinemaster')
        .setDescription('Sort 3 albums from your library by release year! 🗓️')
        .addUserOption((opt: any) =>
            opt.setName('user').setDescription('Use another user\'s library for the game').setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {

        const channel = interactionOrMessage.channel as TextChannel;
        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const targetUserId = targetUser.id;

        const dbUser = await prisma.user.findUnique({ where: { discordId: targetUserId } });
        if (!dbUser?.lastfmUsername) {
            const isSelf = targetUserId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
            const msg = isSelf 
                ? '❌ Link your Last.fm account first using `/login`.'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            isSlash ? await interactionOrMessage.reply({ content: msg, ephemeral: true }) : await interactionOrMessage.channel.send(msg);
            return;
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        await this.runGame(interactionOrMessage, isSlash, targetUserId, channel);
    }

    private async runGame(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel): Promise<void> {
        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId } });
            if (!dbUser) throw new Error("User not found");

            const albums = await this.pickThreeDistinctAlbums(dbUser.id);
            if (!albums) throw new Error("Not enough albums with release dates found in library.");

            // Sorted albums (Oldest to Newest)
            const sorted = [...albums].sort((a, b) => a.year - b.year);

            // Fetch Artworks
            const [art1, art2, art3] = await Promise.all([
                TrackResolverService.resolveAlbum(albums[0].artist, albums[0].name),
                TrackResolverService.resolveAlbum(albums[1].artist, albums[1].name),
                TrackResolverService.resolveAlbum(albums[2].artist, albums[2].name)
            ]);
            
            const c1 = art1.artworkUrl;
            const c2 = art2.artworkUrl;
            const c3 = art3.artworkUrl;

            const noImg = 'https://raw.githubusercontent.com/lastfm/lastfm-api-docs/master/artwork/no-image.png';
            const buffer = await PuppeteerService.render('timeline_grid', {
                url1: c1 || noImg,
                url2: c2 || noImg,
                url3: c3 || noImg
            }, { width: 1200, height: 400 });

            const attachment = new AttachmentBuilder(buffer, { name: `timeline_${Date.now()}.webp` });

            const payload = new ComponentsV2()
                .setAccent(0x818cf8)
                .addText(`### 🗓️ TIMELINE MASTER\nWhich of these 3 albums was released **EARLIEST** (Oldest)?`)
                .addText(`1️⃣ **${albums[0].name}** (${albums[0].artist})\n2️⃣ **${albums[1].name}** (${albums[1].artist})\n3️⃣ **${albums[2].name}** (${albums[2].artist})`)
                .addFullImage(`attachment://${attachment.name}`)
                .addSeparator()
                .addRow([
                    { type: 2, custom_id: 'tl_0', label: 'Album 1', emoji: { name: '1️⃣' }, style: ButtonStyle.Secondary },
                    { type: 2, custom_id: 'tl_1', label: 'Album 2', emoji: { name: '2️⃣' }, style: ButtonStyle.Secondary },
                    { type: 2, custom_id: 'tl_2', label: 'Album 3', emoji: { name: '3️⃣' }, style: ButtonStyle.Secondary }
                ]);

            const initialMsg = isSlash ? await interactionOrMessage.editReply({ ...payload.build(), files: [attachment] }) : await channel.send({ ...payload.build(), files: [attachment] });

            GameManager.startGame(channel.id);

            const collector = initialMsg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 20000
            });

            let phase = 1; // 1 = Picking Oldest, 2 = Picking Newest

            collector.on('collect', async (i: any) => {
                const index = parseInt(i.customId.split('_')[1]);
                const picked = albums[index];

                if (phase === 1) {
                    if (picked.name === sorted[0].name) {
                        phase = 2;
                        await i.deferUpdate();

                        // Update UI for Phase 2
                        const nextPayload = new ComponentsV2()
                            .setAccent(0x818cf8)
                            .addText(`### 🗓️ TIMELINE MASTER\n✅ **Correct!** Now, which of these is the **NEWEST** (Latest)?`)
                            .addText(`1️⃣ **${albums[0].name}**\n2️⃣ **${albums[1].name}**\n3️⃣ **${albums[2].name}**`)
                            .addFullImage(`attachment://${attachment.name}`)
                            .addSeparator()
                            .addRow([
                                { type: 2, custom_id: 'tl_0', label: 'Album 1', emoji: { name: '1️⃣' }, style: ButtonStyle.Secondary },
                                { type: 2, custom_id: 'tl_1', label: 'Album 2', emoji: { name: '2️⃣' }, style: ButtonStyle.Secondary },
                                { type: 2, custom_id: 'tl_2', label: 'Album 3', emoji: { name: '3️⃣' }, style: ButtonStyle.Secondary }
                            ]);

                        await i.editReply(nextPayload.build());
                    } else {
                        await i.reply({ content: `❌ **Wrong!** ${picked.name} was released in ${picked.year}. That's not the oldest!`, ephemeral: true });
                    }
                } else if (phase === 2) {
                    if (picked.name === sorted[2].name) {
                        collector.stop('won');
                        await i.deferUpdate();

                        const winPayload = new ComponentsV2()
                            .setAccent(0x818cf8)
                            .addText(`🏅 **CHRONOLOGY CLEARED!**\n**${i.user.displayName}** successfully sorted the timeline!`)
                            .addSeparator()
                            .addText(`📅 **${sorted[0].year}**: ${sorted[0].name}`)
                            .addText(`📅 **${sorted[1].year}**: ${sorted[1].name}`)
                            .addText(`📅 **${sorted[2].year}**: ${sorted[2].name}`)
                            .addAction("-# Play more?", {
                                type: 2,
                                custom_id: 'tl_play_again',
                                label: 'Play Again',
                                emoji: { name: '🔄' },
                                style: ButtonStyle.Secondary
                            })
                            .build();

                        const resultMsg = await channel.send(winPayload);
                        this.setupPlayAgain(resultMsg, channel, isSlash, interactionOrMessage);

                    } else {
                        await i.reply({ content: `❌ **Wrong!** That was released in ${picked.year}. Keep trying!`, ephemeral: true });
                    }
                }
            });

            collector.on('end', async (_: any, reason: string) => {
                GameManager.endGame(channel.id);
                if (reason === 'time') {
                    const timeoutPayload = new ComponentsV2()
                        .setAccent(0x818cf8)
                        .addText(`⏰ **TIME IS UP!**\nThe timeline has collapsed.`)
                        .addSeparator()
                        .addText(`**The correct order was:**`)
                        .addText(`1️⃣ **${sorted[0].name}** (${sorted[0].year})\n2️⃣ **${sorted[1].name}** (${sorted[1].year})\n3️⃣ **${sorted[2].name}** (${sorted[2].year})`)
                        .addAction("-# Play more?", {
                            type: 2,
                            custom_id: 'tl_play_again',
                            label: 'Play Again',
                            emoji: { name: '🔄' },
                            style: ButtonStyle.Secondary
                        })
                        .build();

                    const resultMsg = await channel.send(timeoutPayload);
                    this.setupPlayAgain(resultMsg, channel, isSlash, interactionOrMessage);
                }
            });

        } catch (err) {
            console.error('Timeline Launch Error:', err);
            GameManager.endGame(channel.id);
            const msg = '⚠️ Failed to start timeline game.';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
        }
    }

    private setupPlayAgain(message: any, channel: TextChannel, isSlash: boolean, interactionOrMessage: any) {
        const collector = message.createMessageComponentCollector({
            filter: (i: any) => i.customId === 'tl_play_again',
            componentType: ComponentType.Button,
            time: 60000,
            max: 1
        });

        collector.on('collect', async (i: any) => {
            await i.deferUpdate();
            if (GameManager.isGameActive(channel.id)) return i.followUp({ content: '⚠️ Game active!', ephemeral: true });
            await this.runGame(interactionOrMessage, isSlash, i.user.id, channel);
        });
    }

    private async pickThreeDistinctAlbums(userId: string) {
        const count = await prisma.userAlbum.count({ where: { userId } });
        if (count < 10) return null;

        const results: any[] = [];
        const seenNames = new Set<string>();

        for (let tries = 0; tries < 25 && results.length < 3; tries++) {
            const skip = Math.floor(Math.random() * count);
            const album = await prisma.userAlbum.findFirst({ where: { userId }, skip });
            if (!album || seenNames.has(album.albumName)) continue;

            const res = await TrackResolverService.resolveAlbum(album.artistName, album.albumName);
            if (res.releaseYear && !results.some(r => r.year === res.releaseYear)) {
                results.push({ name: album.albumName, artist: album.artistName, year: res.releaseYear });
                seenNames.add(album.albumName);
            }
        }

        return results.length === 3 ? results : null;
    }
}
