import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { MusicBrainz } from '../../services/api/MusicBrainz';
import { prisma } from '../../database/client';
import { AttachmentBuilder, SlashCommandBuilder, TextChannel, ButtonStyle, ComponentType, ActionRowBuilder, ButtonBuilder } from 'discord.js';
import { GameManager } from '../../utils/gameManager';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { TrackResolverService } from '../../services/api/TrackResolverService';

export default class PixelGuessCommand extends BaseCommand {
    name = 'pixelguess';
    description = 'Guess the album cover from a pixelated image! 🎨';
    aliases = ['pg', 'pixel'];

    slashData = new SlashCommandBuilder()
        .setName('pixelguess')
        .setDescription('Guess the album cover from a pixelated image! 🎨');

    private pixelFactors = [0.015, 0.04, 0.10, 0.22]; // Level 0, 1, 2, 3

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
            const msg = '⚠️ Could not find a high-quality challenge after multiple attempts. Try again later!';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
            return;
        }

        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId } });
            if (!dbUser) throw new Error("User not found");

            // 1. Pick an album (DB first, fallback to API)
            let target: any = await this.pickAlbumFromDB(dbUser.id);
            if (!target) {
                target = await this.pickAlbumFromAPI(dbUser.lastfmUsername!);
            }

            if (!target) throw new Error("Could not find any albums to guess.");

            const { albumName, artistName } = target;

            // 2. Resolve Artwork (Must have architecture for this game)
            const res = await TrackResolverService.resolveAlbum(artistName, albumName);
            const artworkUrl = res.artworkUrl;

            // Validate: artwork must exist and not be a default Last.fm placeholder
            if (!artworkUrl || LastFM.isDefaultImage(artworkUrl)) {
                return this.runGame(interactionOrMessage, isSlash, discordId, channel, true, retries - 1);
            }

            // 3. Fetch Artist Metadata (Hints)
            const mbInfo = await MusicBrainz.getArtistInfo(artistName);
            const tags = await LastFM.getArtistTopTags(artistName);
            const genres = tags.slice(0, 3).map(t => t.name).join(', ');

            // QUALITY CHECK: If EVERYTHING is Unknown (Origin, Age, and Genre), we skip it for a better challenge
            const hasMetadata = mbInfo?.origin || mbInfo?.activeSince || (genres && genres !== 'Unknown');
            if (!hasMetadata) {
                console.log(`[PixelGuess] Skipping ${artistName} - ${albumName} due to zero metadata.`);
                return this.runGame(interactionOrMessage, isSlash, discordId, channel, true, retries - 1);
            }

            const gameData = {
                albumName,
                artistName,
                artworkUrl,
                genres: genres || 'Unknown',
                origin: mbInfo?.origin || 'Unknown',
                activeSince: mbInfo?.activeSince?.split('-')[0] || 'Unknown',
                type: mbInfo?.type || 'Artist',
                hintsUsed: 0
            };

            // 4. Initial Start
            if (!skipStartPrompt) {
                const startContent = `### 🎨 PIXEL GUESS\nReady to guess an album from <@${discordId}>'s collection?\n**Click the button below to start.**`;
                const startPayload = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(startContent)
                    .addAction("-# Album Guessing Game", {
                        type: 2,
                        custom_id: 'start_pixelguess',
                        label: 'Start Game',
                        emoji: { name: '🎮' },
                        style: ButtonStyle.Success
                    })
                    .build();

                const initialMsg = isSlash ? await interactionOrMessage.editReply(startPayload) : await channel.send(startPayload);
                const filter = (i: any) => i.customId === 'start_pixelguess';
                const collector = initialMsg.createMessageComponentCollector({ filter, componentType: ComponentType.Button, time: 60000, max: 1 });

                collector.on('collect', async (i: any) => {
                    try {
                        await i.deferUpdate();
                        await this.startGameLoop(i, channel, gameData, isSlash, interactionOrMessage, discordId);
                    } catch (err) {
                        console.error("[PixelGuess] Interaction error:", err);
                        GameManager.endGame(channel.id);
                        try {
                            await i.followUp({ content: '⚠️ Failed to start the game loop.', ephemeral: true });
                        } catch { }
                    }
                });
            } else {
                await this.startGameLoop(null, channel, gameData, isSlash, interactionOrMessage, discordId);
            }

        } catch (err) {
            console.error('Pixel Guess Launch Error:', err);
            GameManager.endGame(channel.id);
            const msg = '⚠️ Failed to start game.';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
        }
    }

    private async startGameLoop(interaction: any, channel: TextChannel, data: any, isSlash: boolean, interactionOrMessage: any, originalId: string): Promise<void> {
        GameManager.startGame(channel.id);
        let hintsUsed = 0;
        let solved = false;
        let winner: any = null;

        const sendGameMessage = async (targetInteraction?: any) => {
            const buffer = await PuppeteerService.render('pixelation', {
                artworkUrl: data.artworkUrl,
                pixelFactor: this.pixelFactors[hintsUsed]
            }, { width: 800, height: 800 });

            const attachment = new AttachmentBuilder(buffer, { name: `pixel_${Date.now()}.webp` });

            let hintText = `### 🎨 PIXEL GUESS\nIdentify this album cover by **${data.artistName}**!`;
            hintText += `\n- **Genre:** ${data.genres || '???'} `;

            if (hintsUsed >= 1) hintText += `\n- **Origin:** ${data.origin}`;
            if (hintsUsed >= 2) hintText += `\n- **Stage:** ${data.type} (Active since ${data.activeSince})`;
            if (hintsUsed >= 3) hintText += `\n- **Final Hint:** Name starts with \`${data.albumName[0].toUpperCase()}\``;

            const payload = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(hintText)
                .addFullImage(`attachment://${attachment.name}`);

            if (hintsUsed < 3) {
                payload.addAction("-# Need a clue?", {
                    type: 2,
                    custom_id: 'pg_hint',
                    label: `Hint (${3 - hintsUsed} left)`,
                    emoji: { name: '💡' },
                    style: ButtonStyle.Secondary
                });
            }

            const messagePayload = { ...payload.build(), files: [attachment] };
            if (targetInteraction) {
                return await targetInteraction.editReply(messagePayload);
            } else {
                return await channel.send(messagePayload);
            }
        };

        // First turn: Replace the "Start Game" button if we have an interaction
        let gameMessage = await sendGameMessage(interaction);

        // Hint Collector
        const hintCollector = gameMessage.createMessageComponentCollector({
            filter: (i: any) => i.customId === 'pg_hint',
            componentType: ComponentType.Button,
            time: 45000
        });

        hintCollector.on('collect', async (i: any) => {
            await i.deferUpdate();
            hintsUsed++;
            await sendGameMessage(i);
        });

        // Guessing Collector
        const guessCollector = channel.createMessageCollector({
            filter: (m) => !m.author.bot,
            time: 45000
        });

        guessCollector.on('collect', async (m) => {
            const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
            const guess = clean(m.content);
            const actual = clean(data.albumName);

            if (guess === actual || (actual.includes(guess) && guess.length > 5 && guess.length >= actual.length - 2)) {
                solved = true;
                winner = m.author;
                guessCollector.stop('solved');
                hintCollector.stop('solved');
            }
        });

        guessCollector.on('end', async (_, reason) => {
            GameManager.endGame(channel.id);
            if (reason === 'solved' || solved) {
                const resultPayload = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`🎉 **CORRECT!** Congratulations **${winner.displayName}**!\nThe album was **${data.albumName}** by **${data.artistName}**.`)
                    .addFullImage(data.artworkUrl)
                    .addAction("-# Another round?", {
                        type: 2,
                        custom_id: 'pg_play_again',
                        label: 'Play Again',
                        emoji: { name: '🔄' },
                        style: ButtonStyle.Secondary
                    })
                    .build();

                const resultMsg = await channel.send(resultPayload);
                this.setupPlayAgain(resultMsg, channel, isSlash, interactionOrMessage);

            } else {
                const resultPayload = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`⏰ **Time is up!**\nThe correct answer was **${data.albumName}** by **${data.artistName}**.`)
                    .addFullImage(data.artworkUrl)
                    .addAction("-# Try again?", {
                        type: 2,
                        custom_id: 'pg_play_again',
                        label: 'Play Again',
                        emoji: { name: '🔄' },
                        style: ButtonStyle.Secondary
                    })
                    .build();

                const resultMsg = await channel.send(resultPayload);
                this.setupPlayAgain(resultMsg, channel, isSlash, interactionOrMessage);
            }
        });
    }

    private setupPlayAgain(message: any, channel: TextChannel, isSlash: boolean, interactionOrMessage: any) {
        const collector = message.createMessageComponentCollector({
            filter: (i: any) => i.customId === 'pg_play_again',
            componentType: ComponentType.Button,
            time: 60000,
            max: 1
        });

        collector.on('collect', async (i: any) => {
            await i.deferUpdate();
            if (GameManager.isGameActive(channel.id)) {
                return i.followUp({ content: '⚠️ A game is already active!', ephemeral: true });
            }
            // PIVOT: Use the ID of the person who clicked Play Again!
            await this.runGame(interactionOrMessage, isSlash, i.user.id, channel, true);
        });
    }

    private async pickAlbumFromDB(userId: string) {
        try {
            const count = await prisma.userAlbum.count({ where: { userId } });
            if (count === 0) return null;
            const item = await prisma.userAlbum.findFirst({
                where: { userId },
                skip: Math.floor(Math.random() * count)
            });
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
