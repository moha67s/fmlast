import {
  BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { MusicBrainz } from '../../services/api/MusicBrainz';
import { prisma } from '../../database/client';
import { AttachmentBuilder,
  SlashCommandBuilder,
  TextChannel,
  ButtonStyle,
  ComponentType,
  ActionRowBuilder,
  ButtonBuilder
} from "discord.js";
import { GameManager } from '../../utils/gameManager';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { TrackResolverService } from '../../services/api/TrackResolverService';

export default class ZoomGuessCommand extends BaseCommand {
    name = 'zoomguess';
    description = 'Guess the album from a highly zoomed-in crop! 🔍';
    aliases = ['zg', 'zoom'];

    slashData = new SlashCommandBuilder()
        .setName('zoomguess')
        .setDescription('Guess the album from a highly zoomed-in crop! 🔍');

    private zoomScales = [10, 5, 2.5, 1.25]; // Initial (tiny crop) -> 3 hints zooming out

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

            const mbInfo = await MusicBrainz.getArtistInfo(artistName);
            const tags = await LastFM.getArtistTopTags(artistName);
            const genres = tags.slice(0, 3).map(t => t.name).join(', ');

            // Metadata check (ensure game is interesting)
            if (!mbInfo?.origin && !mbInfo?.activeSince && (!genres || genres === 'Unknown')) {
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
                centerX: 25 + Math.random() * 50, // Pick a center area (not too close to edges)
                centerY: 25 + Math.random() * 50,
                hintsUsed: 0
            };

            if (!skipStartPrompt) {
                const startPayload = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`### 🔍 ZOOM GUESS\nReady to guess an album from <@${discordId}>'s collection?\n**The camera starts super close. Zoom out to win!**`)
                    .addAction("-# Zoom Level: 10x", {
                        type: ComponentType.Button,
                        custom_id: 'start_zoomguess',
                        label: 'Start Game',
                        emoji: { name: '🔍' },
                        style: ButtonStyle.Success
                    })
                    .build();

                const initialMsg = isSlash ? await interactionOrMessage.editReply(startPayload) : await channel.send(startPayload);
                const filter = (i: any) => i.customId === 'start_zoomguess';
                const collector = initialMsg.createMessageComponentCollector({ filter, componentType: ComponentType.Button, time: 60000, max: 1 });

                collector.on('collect', async (i: any) => {
                    try {
                        await i.deferUpdate();
                        await this.startGameLoop(i, channel, gameData, isSlash, interactionOrMessage, discordId);
                    } catch (err) {
                        console.error("[ZoomGuess] Interaction error:", err);
                        GameManager.endGame(channel.id);
                        try {
                            await i.followUp({ content: '⚠️ Failed to start the zoom loop.', ephemeral: true });
                        } catch { }
                    }
                });
            } else {
                await this.startGameLoop(null, channel, gameData, isSlash, interactionOrMessage, discordId);
            }

        } catch (err) {
            console.error('Zoom Guess Launch Error:', err);
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
            const buffer = await PuppeteerService.render('zoom', {
                artworkUrl: data.artworkUrl,
                centerX: data.centerX,
                centerY: data.centerY,
                scale: this.zoomScales[hintsUsed]
            }, { width: 800, height: 800 });

            const attachment = new AttachmentBuilder(buffer, { name: `zoom_${Date.now()}.webp` });

            let hintText = `### 🔍 ZOOM GUESS\nIdentify the album cover! (Current Zoom: **${this.zoomScales[hintsUsed]}x**)`;
            hintText += `\n- **Artist:** ${data.artistName}`;
            hintText += `\n- **Genre:** ${data.genres}`;

            if (hintsUsed >= 1) hintText += `\n- **Origin:** ${data.origin}`;
            if (hintsUsed >= 2) hintText += `\n- **Stage:** ${data.type} (Active since ${data.activeSince})`;
            if (hintsUsed >= 3) hintText += `\n- **Final Hint:** Album begins with \`${data.albumName[0].toUpperCase()}\``;

            const payload = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(hintText)
                .addFullImage(`attachment://${attachment.name}`);

            if (hintsUsed < 3) {
                payload.addAction("-# Need to zoom out?", {
                    type: ComponentType.Button,
                    custom_id: 'zg_hint',
                    label: `Zoom Out (${3 - hintsUsed} left)`,
                    emoji: { name: '➖' },
                    style: ButtonStyle.Secondary
                });
            }

            const messagePayload = { ...payload.build(), files: [attachment] };
            if (targetInteraction) return await targetInteraction.editReply(messagePayload);
            return await channel.send(messagePayload);
        };

        let gameMessage = await sendGameMessage(interaction);

        const hintCollector = gameMessage.createMessageComponentCollector({
            filter: (i: any) => i.customId === 'zg_hint',
            componentType: ComponentType.Button,
            time: 45000
        });

        hintCollector.on('collect', async (i: any) => {
            await i.deferUpdate();
            hintsUsed++;
            await sendGameMessage(i);
        });

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
            const isWinner = reason === 'solved' || solved;

            const resultPayload = new ComponentsV2()
                .setAccent(isWinner ? 0x4ade80 : 0xf04444)
                .addText(isWinner ? `🎉 **CORRECT!** **${winner.displayName}** identified **${data.albumName}**!` : `⏰ **TIME UP!** The album was **${data.albumName}** by **${data.artistName}**.`)
                .addFullImage(data.artworkUrl)
                .addAction("-# Keep going?", {
                    type: ComponentType.Button,
                    custom_id: 'zg_play_again',
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
            filter: (i: any) => i.customId === 'zg_play_again',
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

