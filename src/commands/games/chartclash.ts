import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, TextChannel, ButtonStyle, ComponentType, User, AttachmentBuilder } from 'discord.js';
import { GameManager } from '../../utils/gameManager';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { TrackResolverService } from '../../services/api/TrackResolverService';

export default class ChartClashCommand extends BaseCommand {
    name = 'chartclash';
    description = 'A 1v1 competitive trivia battle! Who has more plays or which is older? ⚔️';
    aliases = ['cc', 'clash'];

    slashData = new SlashCommandBuilder()
        .setName('chartclash')
        .setDescription('A 1v1 competitive trivia battle! Who has more plays or which is older? ⚔️');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {

        const channel = interactionOrMessage.channel as TextChannel;
        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

        if (GameManager.isGameActive(channel.id)) {
            const msg = '⚠️ A clash is already in progress!';
            isSlash ? await interactionOrMessage.reply({ content: msg, ephemeral: true }) : await interactionOrMessage.channel.send(msg);
            return;
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser?.lastfmUsername) {
            const msg = '❌ Link your Last.fm account first using `/login`.';
            isSlash ? await interactionOrMessage.reply({ content: msg, ephemeral: true }) : await interactionOrMessage.channel.send(msg);
            return;
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { channel.sendTyping(); } catch { } }

        await this.runGame(interactionOrMessage, isSlash, userId, channel);
    }

    private async runGame(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel): Promise<void> {
        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId } });
            if (!dbUser) throw new Error("User not found");

            // Randomize Mode: 0 = Playcount Clash, 1 = Release Year Clash
            const mode = Math.random() > 0.5 ? 'PLAYS' : 'RELEASES';
            let itemA: any, itemB: any;
            let question = "";
            let answer = "";

            if (mode === 'PLAYS') {
                const results = await this.pickTwoArtists(dbUser.id);
                if (!results) throw new Error("Not enough artists to clash!");
                [itemA, itemB] = results;
                question = `Who has **MORE PLAYS** in <@${discordId}>'s library?`;
                answer = itemA.playcount > itemB.playcount ? 'A' : 'B';
            } else {
                const results = await this.pickTwoAlbums(dbUser.id);
                if (!results) throw new Error("Not enough albums to clash!");
                [itemA, itemB] = results;
                question = `Which of these two albums is **OLDER** (Released earlier)?`;
                answer = itemA.year < itemB.year ? 'A' : 'B';
                // Handing edge case where years are identical
                if (itemA.year === itemB.year) return this.runGame(interactionOrMessage, isSlash, discordId, channel);
            }

            // ── GLOBAL RESOLUTION (UTR) ──
            let coverA: string | null = null, coverB: string | null = null;
            if (mode === 'PLAYS') {
                const [artA, artB] = await Promise.all([
                    TrackResolverService.resolveArtist(itemA.name),
                    TrackResolverService.resolveArtist(itemB.name)
                ]);
                coverA = artA.avatarUrl;
                coverB = artB.avatarUrl;
            } else {
                const [artA, artB] = await Promise.all([
                    TrackResolverService.resolveAlbum(itemA.artist, itemA.name),
                    TrackResolverService.resolveAlbum(itemB.artist, itemB.name)
                ]);
                coverA = artA.artworkUrl;
                coverB = artB.artworkUrl;
            }

            const buffer = await PuppeteerService.render('comparison', {
                urlA: coverA || 'https://raw.githubusercontent.com/lastfm/lastfm-api-docs/master/artwork/no-image.png',
                urlB: coverB || 'https://raw.githubusercontent.com/lastfm/lastfm-api-docs/master/artwork/no-image.png'
            }, { width: 800, height: 400 });

            const attachment = new AttachmentBuilder(buffer, { name: `clash_${Date.now()}.webp` });

            const payload = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(`### ⚔️ CHART CLASH\n${question}`)
                .addText(`**🅰️ | ${itemA.name}**\n**🅱️ | ${itemB.name}**`)
                .addFullImage(`attachment://${attachment.name}`)
                .addSeparator()
                .addRow([
                    {
                        type: 2,
                        custom_id: 'clash_a',
                        label: 'Option A',
                        style: ButtonStyle.Primary
                    },
                    {
                        type: 2,
                        custom_id: 'clash_b',
                        label: 'Option B',
                        style: ButtonStyle.Primary
                    }
                ]);

            const initialMsg = isSlash ? await interactionOrMessage.editReply({ ...payload.build(), files: [attachment] }) : await channel.send({ ...payload.build(), files: [attachment] });

            GameManager.startGame(channel.id);

            const collector = initialMsg.createMessageComponentCollector({
                componentType: ComponentType.Button,
                time: 15000
            });

            collector.on('collect', async (i: any) => {
                const chosen = i.customId === 'clash_a' ? 'A' : 'B';
                const isCorrect = chosen === answer;

                if (isCorrect) {
                    collector.stop('won');
                    await i.deferUpdate();

                    const winPayload = new ComponentsV2()
                        .setAccent(0x5865F2)
                        .addText(`⚔️ **CLASH OVER!**\n🏆 **${i.user.displayName}** was the fastest and got it right!`)
                        .addSeparator()
                        .addText(`🅰️ **${itemA.name}**: ${mode === 'PLAYS' ? `\`${itemA.playcount}\` plays` : `Released \`${itemA.year}\``}`)
                        .addText(`🅱️ **${itemB.name}**: ${mode === 'PLAYS' ? `\`${itemB.playcount}\` plays` : `Released \`${itemB.year}\``}`)
                        .addAction("-# Rematch?", {
                            type: 2,
                            custom_id: 'clash_play_again',
                            label: 'Play Again',
                            emoji: { name: '🔄' },
                            style: ButtonStyle.Secondary
                        })
                        .build();

                    const resultMsg = await channel.send(winPayload);
                    this.setupPlayAgain(resultMsg, channel, isSlash, interactionOrMessage, i.user.id);
                } else {
                    await i.reply({ content: '❌ Wrong! Someone else can still win.', ephemeral: true });
                }
            });

            collector.on('end', async (collected: any, reason: string) => {
                GameManager.endGame(channel.id);
                if (reason === 'time') {
                    const timeoutPayload = new ComponentsV2()
                        .setAccent(0x5865F2)
                        .addText(`⏰ **TIME IS UP!**\nNo one was fast enough to win this clash.`)
                        .addSeparator()
                        .addText(`The correct answer was **${answer === 'A' ? itemA.name : itemB.name}**.`)
                        .addAction("-# Try again?", {
                            type: 2,
                            custom_id: 'clash_play_again',
                            label: 'Play Again',
                            emoji: { name: '🔄' },
                            style: ButtonStyle.Secondary
                        })
                        .build();

                    const resultMsg = await channel.send(timeoutPayload);
                    this.setupPlayAgain(resultMsg, channel, isSlash, interactionOrMessage, '');
                }
            });

        } catch (err) {
            console.error('Chart Clash Launch Error:', err);
            GameManager.endGame(channel.id);
            const msg = '⚠️ Failed to start clash.';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
        }
    }

    private setupPlayAgain(message: any, channel: TextChannel, isSlash: boolean, interactionOrMessage: any, winnerId: string) {
        const collector = message.createMessageComponentCollector({
            filter: (i: any) => i.customId === 'clash_play_again',
            componentType: ComponentType.Button,
            time: 60000,
            max: 1
        });

        collector.on('collect', async (i: any) => {
            await i.deferUpdate();
            if (GameManager.isGameActive(channel.id)) return i.followUp({ content: '⚠️ Clash in progress!', ephemeral: true });
            // Pivot to the person who clicked Play Again
            await this.runGame(interactionOrMessage, isSlash, i.user.id, channel);
        });
    }

    private async pickTwoArtists(userId: string) {
        // Use a 10 play threshold to avoid obscure 1-scrobble artists
        // Unless the user has very few artists, then we lower it
        let minPlays = 10;
        const totalSignificant = await prisma.userArtist.count({ where: { userId, playcount: { gte: 10 } } });
        if (totalSignificant < 5) minPlays = 2;

        const count = await prisma.userArtist.count({
            where: { userId, playcount: { gte: minPlays } }
        });
        const limit = Math.min(count, 500); // Only pick from top 500

        if (limit < 2) return null;

        const skipA = Math.floor(Math.random() * limit);
        let skipB = Math.floor(Math.random() * limit);
        while (skipA === skipB) skipB = Math.floor(Math.random() * limit);

        const [a, b] = await Promise.all([
            prisma.userArtist.findFirst({
                where: { userId, playcount: { gte: minPlays } },
                orderBy: { playcount: 'desc' },
                skip: skipA
            }),
            prisma.userArtist.findFirst({
                where: { userId, playcount: { gte: minPlays } },
                orderBy: { playcount: 'desc' },
                skip: skipB
            })
        ]);

        return [
            { name: a!.artistName, playcount: a!.playcount },
            { name: b!.artistName, playcount: b!.playcount }
        ];
    }

    private async pickTwoAlbums(userId: string) {
        let minPlays = 10;
        const totalSignificant = await prisma.userAlbum.count({ where: { userId, playcount: { gte: 10 } } });
        if (totalSignificant < 5) minPlays = 2;

        const count = await prisma.userAlbum.count({ where: { userId, playcount: { gte: minPlays } } });
        const limit = Math.min(count, 500);

        if (limit < 2) return null;

        // Try to pick two albums with years
        for (let tries = 0; tries < 10; tries++) {
            const skipA = Math.floor(Math.random() * limit);
            const skipB = Math.floor(Math.random() * limit);
            if (skipA === skipB) continue;

            const [a, b] = await Promise.all([
                prisma.userAlbum.findFirst({
                    where: { userId, playcount: { gte: minPlays } },
                    orderBy: { playcount: 'desc' },
                    skip: skipA
                }),
                prisma.userAlbum.findFirst({
                    where: { userId, playcount: { gte: minPlays } },
                    orderBy: { playcount: 'desc' },
                    skip: skipB
                })
            ]);

            const { AppleMusic } = await import('../../services/api/AppleMusic');
            const [metaA, metaB] = await Promise.all([
                AppleMusic.getAlbumMetadata(a!.albumName, a!.artistName).catch(() => null),
                AppleMusic.getAlbumMetadata(b!.albumName, b!.artistName).catch(() => null)
            ]);

            if (metaA?.releaseYear && metaB?.releaseYear && metaA.releaseYear !== metaB.releaseYear) {
                return [
                    { name: a!.albumName, artist: a!.artistName, year: metaA.releaseYear },
                    { name: b!.albumName, artist: b!.artistName, year: metaB.releaseYear }
                ];
            }
        }
        return null;
    }
}
