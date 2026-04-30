import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { AttachmentBuilder, SlashCommandBuilder, TextChannel, ButtonStyle, ComponentType } from 'discord.js';
import { GameManager } from '../../utils/gameManager';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { TrackResolverService } from '../../services/api/TrackResolverService';

export default class ScrambleCommand extends BaseCommand {
    name = 'scramble';
    description = 'Identify the album as it slowly un-scrambles! 🧩';
    aliases = ['scr', 'puzzle'];

    slashData = new SlashCommandBuilder()
        .setName('scramble')
        .setDescription('Identify the album as it slowly un-scrambles! 🧩');

    private gridSize = 3;

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {

        const channel = interactionOrMessage.channel as TextChannel;
        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

        if (GameManager.isGameActive(channel.id)) {
            const msg = '⚠️ A game is already active in this channel!';
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

    private async runGame(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel, skipStartPrompt = false, retries = 5): Promise<void> {
        if (retries <= 0) {
            const msg = '⚠️ Could not find a high-quality challenge. Try again later!';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
            return;
        }

        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId } });
            if (!dbUser) throw new Error("User not found");

            const target: any = await this.pickAlbumFromDB(dbUser.id) || await this.pickAlbumFromAPI(dbUser.lastfmUsername!);
            if (!target) throw new Error("Could not find any albums.");

            const { albumName, artistName } = target;
            const res = await TrackResolverService.resolveAlbum(artistName, albumName);
            const artworkUrl = res.artworkUrl;

            if (!artworkUrl || LastFM.isDefaultImage(artworkUrl)) {
                return this.runGame(interactionOrMessage, isSlash, discordId, channel, true, retries - 1);
            }

            const gameData = {
                albumName,
                artistName,
                artworkUrl,
                originalOrder: Array.from({ length: this.gridSize * this.gridSize }, (_, i) => i),
                currentOrder: [] as number[],
                solved: false
            };

            // Shuffle
            gameData.currentOrder = [...gameData.originalOrder].sort(() => Math.random() - 0.5);

            if (!skipStartPrompt) {
                const startPayload = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`### 🧩 COVER SCRAMBLE\nReady to solve an album puzzle from <@${discordId}>'s collection?\n**Identify the artwork as the pieces move back to their original spots!**`)
                    .addAction("-# Puzzle Difficulty: 3x3", {
                        type: 2,
                        custom_id: 'start_scramble',
                        label: 'Start Puzzle',
                        emoji: { name: '🧩' },
                        style: ButtonStyle.Success
                    })
                    .build();

                const initialMsg = isSlash ? await interactionOrMessage.editReply(startPayload) : await channel.send(startPayload);
                const filter = (i: any) => i.customId === 'start_scramble';
                const collector = initialMsg.createMessageComponentCollector({ filter, componentType: ComponentType.Button, time: 60000, max: 1 });

                collector.on('collect', async (i: any) => {
                    try {
                        await i.deferUpdate();
                        await this.startGameLoop(i, channel, gameData, isSlash, interactionOrMessage, discordId);
                    } catch (err) {
                        console.error("[Scramble] Interaction error:", err);
                        GameManager.endGame(channel.id);
                        try {
                            await i.followUp({ content: '⚠️ An error occurred while starting the puzzle.', ephemeral: true });
                        } catch { }
                    }
                });
            } else {
                await this.startGameLoop(null, channel, gameData, isSlash, interactionOrMessage, discordId);
            }

        } catch (err) {
            console.error('Scramble Launch Error:', err);
            GameManager.endGame(channel.id);
            const msg = '⚠️ Failed to start puzzle.';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
        }
    }

    private async startGameLoop(interaction: any, channel: TextChannel, data: any, isSlash: boolean, interactionOrMessage: any, originalId: string): Promise<void> {
        GameManager.startGame(channel.id);
        let solved = false;
        let winner: any = null;
        let hintStage = 0; // 0 = 0% solved, 1 = 33% solved, 2 = 66% solved, 3 = 100% solved (automatic loss stage)

        const calculateTiles = () => {
            const S = this.gridSize;
            return data.currentOrder.map((tileIndex: number) => {
                const posX = (tileIndex % S) * (100 / (S - 1));
                const posY = Math.floor(tileIndex / S) * (100 / (S - 1));
                return { posX, posY };
            });
        };

        const unscramble = (percent: number) => {
            const total = data.originalOrder.length;
            const targetSolved = Math.floor(total * percent);
            let currentlySolved = data.currentOrder.filter((v: number, i: number) => v === data.originalOrder[i]).length;

            while (currentlySolved < targetSolved) {
                // Find a tile that isn't solved and solve it
                const unsolvedIndices = data.currentOrder
                    .map((v: number, i: number) => (v !== data.originalOrder[i] ? i : -1))
                    .filter((idx: number) => idx !== -1);

                if (unsolvedIndices.length === 0) break;

                const randIdx = unsolvedIndices[Math.floor(Math.random() * unsolvedIndices.length)];
                // Swap the correct tile into this position
                const correctTileValue = data.originalOrder[randIdx];
                const currentPosOfCorrectTile = data.currentOrder.indexOf(correctTileValue);

                // Swap values
                [data.currentOrder[randIdx], data.currentOrder[currentPosOfCorrectTile]] = [data.currentOrder[currentPosOfCorrectTile], data.currentOrder[randIdx]];
                currentlySolved++;
            }
        };

        let lastMessage: any = null;
        const sendGameMessage = async (targetInteraction?: any) => {
            const buffer = await PuppeteerService.render('scramble', {
                artworkUrl: data.artworkUrl,
                size: this.gridSize,
                tiles: calculateTiles()
            }, { width: 800, height: 800 });

            const attachment = new AttachmentBuilder(buffer, { name: `scramble_${Date.now()}.webp` });

            let hintText = `### 🧩 COVER SCRAMBLE\nIdentify this album cover! ⏳ Pieces are drifting back...`;
            if (hintStage >= 1) hintText += `\n- **Hint:** Artist is **${data.artistName}**`;
            if (hintStage >= 2) hintText += `\n- **Solving...** (${Math.round(hintStage * 33)}% of pieces are now in place)`;

            const payload = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(hintText)
                .addFullImage(`attachment://${attachment.name}`);

            const messagePayload = { ...payload.build(), files: [attachment] };

            if (targetInteraction) return await targetInteraction.editReply(messagePayload);
            if (lastMessage) {
                try {
                    return await lastMessage.edit(messagePayload);
                } catch (e) {
                    return await channel.send(messagePayload);
                }
            }
            return await channel.send(messagePayload);
        };

        lastMessage = await sendGameMessage(interaction);

        // Guessing Collector
        const guessCollector = channel.createMessageCollector({
            filter: (m) => !m.author.bot,
            time: 60000
        });

        // Hint/Unscramble Timer
        const solveTimer = setInterval(async () => {
            try {
                if (solved || hintStage >= 3) {
                    clearInterval(solveTimer);
                    return;
                }
                hintStage++;
                unscramble(hintStage * 0.33);
                const updatedMsg = await sendGameMessage();
                if (updatedMsg) lastMessage = updatedMsg;
            } catch (err) {
                console.error("[Scramble] solveTimer error:", err);
                clearInterval(solveTimer);
                GameManager.endGame(channel.id);
            }
        }, 15000);

        guessCollector.on('collect', async (m) => {
            const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
            const guess = clean(m.content);
            const actual = clean(data.albumName);

            if (guess === actual || (actual.includes(guess) && guess.length > 5 && guess.length >= actual.length - 2)) {
                solved = true;
                winner = m.author;
                clearInterval(solveTimer);
                guessCollector.stop('solved');
            }
        });

        guessCollector.on('end', async (_, reason) => {
            clearInterval(solveTimer);
            GameManager.endGame(channel.id);

            const isWinner = reason === 'solved' || solved;
            const resultPayload = new ComponentsV2()
                .setAccent(isWinner ? 0x4ade80 : 0xf04444)
                .addText(isWinner ? `🎉 **PUZZLE SOLVED!** **${winner.displayName}** identified **${data.albumName}**!` : `⏰ **TIME UP!** The album was **${data.albumName}** by **${data.artistName}**.`)
                .addFullImage(data.artworkUrl)
                .addAction("-# Keep puzzling?", {
                    type: 2,
                    custom_id: 'scr_play_again',
                    label: 'Play Again',
                    emoji: { name: '🔄' },
                    style: ButtonStyle.Secondary
                })
                .build();

            const resultMsg = await channel.send(resultPayload);
            this.setupPlayAgain(resultMsg, channel, isSlash, interactionOrMessage);
        });
    }

    private setupPlayAgain(message: any, channel: TextChannel, isSlash: boolean, interactionOrMessage: any) {
        const collector = message.createMessageComponentCollector({
            filter: (i: any) => i.customId === 'scr_play_again',
            componentType: ComponentType.Button,
            time: 60000,
            max: 1
        });

        collector.on('collect', async (i: any) => {
            await i.deferUpdate();
            if (GameManager.isGameActive(channel.id)) return i.followUp({ content: '⚠️ Game active!', ephemeral: true });
            await this.runGame(interactionOrMessage, isSlash, i.user.id, channel, true);
        });
    }

    private async pickAlbumFromDB(userId: string) {
        try {
            const count = await prisma.userAlbum.count({ where: { userId } });
            if (count === 0) return null;
            const item = await prisma.userAlbum.findFirst({ where: { userId }, skip: Math.floor(Math.random() * count) });
            return { albumName: item!.albumName, artistName: item!.artistName };
        } catch { return null; }
    }

    private async pickAlbumFromAPI(username: string) {
        try {
            const albums = await LastFM.getTopAlbums(username, 'overall', 100);
            if (!albums?.length) return null;
            const item = albums[Math.floor(Math.random() * albums.length)];
            return { albumName: item.name, artistName: item.artist?.name || 'Unknown' };
        } catch { return null; }
    }
}

