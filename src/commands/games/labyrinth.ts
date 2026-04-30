import {
  BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { prisma } from '../../database/client';
import { AttachmentBuilder,
  SlashCommandBuilder,
  TextChannel,
  ButtonStyle,
  ComponentType
} from "discord.js";
import { GameManager } from '../../utils/gameManager';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { LyricsService } from '../../services/external/LyricsService';
import { TrackResolverService } from '../../services/api/TrackResolverService';

export default class LabyrinthCommand extends BaseCommand {
    name = 'labyrinth';
    description = 'Identify the song from a cinematic lyric card! 🎤🧩';
    aliases = ['lyricguess', 'lab'];

    slashData = new SlashCommandBuilder()
        .setName('labyrinth')
        .setDescription('Identify the song from a cinematic lyric card! 🎤🧩');

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
            const msg = '⚠️ Could not find a track with available lyrics. Try again later!';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
            return;
        }

        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId } });
            if (!dbUser) throw new Error("User not found");

            // Pick a random track from recent or top albums
            const topAlbums = await LastFM.getTopAlbums(dbUser.lastfmUsername!, 'overall', 50);
            if (!topAlbums || topAlbums.length === 0) throw new Error("No tracks found.");

            const randomAlbum = topAlbums[Math.floor(Math.random() * topAlbums.length)];
            const albumInfo = await LastFM.getAlbumInfo(randomAlbum.artist.name, randomAlbum.name);
            const tracks = albumInfo?.tracks?.track;
            const trackList = Array.isArray(tracks) ? tracks : (tracks ? [tracks] : []);

            if (trackList.length === 0) return this.runGame(interactionOrMessage, isSlash, discordId, channel, true, retries - 1);

            const targetTrack = trackList[Math.floor(Math.random() * trackList.length)];
            const { lines, source } = await LyricsService.fetchLyrics(randomAlbum.artist.name, targetTrack.name);

            if (!lines || lines.length < 3) {
                return this.runGame(interactionOrMessage, isSlash, discordId, channel, true, retries - 1);
            }

            const res = await TrackResolverService.resolveAlbum(randomAlbum.artist.name, randomAlbum.name);
            const artworkUrl = res.artworkUrl;
            if (!artworkUrl || LastFM.isDefaultImage(artworkUrl)) {
                return this.runGame(interactionOrMessage, isSlash, discordId, channel, true, retries - 1);
            }

            const snippet = LyricsService.getGameSnippet(lines, 3);
            const gameData = {
                trackName: targetTrack.name,
                artistName: randomAlbum.artist.name,
                albumName: randomAlbum.name,
                artworkUrl,
                snippet,
                solved: false
            };

            if (!skipStartPrompt) {
                const startPayload = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`### 🎤 LYRIC LABYRINTH\nReady to guess a song from <@${discordId}>'s universe?\n**I'll show you a cinematic lyric card—you identify the track!**`)
                    .addAction("-# Objective: Guess the Track Name", {
                        type: ComponentType.Button,
                        custom_id: 'start_labyrinth',
                        label: 'Enter the Labyrinth',
                        emoji: { name: '🔮' },
                        style: ButtonStyle.Danger
                    })
                    .build();

                const initialMsg = isSlash ? await interactionOrMessage.editReply(startPayload) : await channel.send(startPayload);
                const filter = (i: any) => i.customId === 'start_labyrinth';
                const collector = initialMsg.createMessageComponentCollector({ filter, componentType: ComponentType.Button, time: 60000, max: 1 });

                collector.on('collect', async (i: any) => {
                    try {
                        await i.deferUpdate();
                        await this.startGameLoop(i, channel, gameData, isSlash, interactionOrMessage, discordId);
                    } catch (err) {
                        console.error("[Labyrinth] Collector Error:", err);
                        GameManager.endGame(channel.id);
                    }
                });
            } else {
                await this.startGameLoop(null, channel, gameData, isSlash, interactionOrMessage, discordId);
            }

        } catch (err) {
            console.error('Labyrinth Launch Error:', err);
            GameManager.endGame(channel.id);
            const msg = '⚠️ Failed to start the labyrinth.';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
        }
    }

    private async startGameLoop(interaction: any, channel: TextChannel, data: any, isSlash: boolean, interactionOrMessage: any, originalId: string): Promise<void> {
        GameManager.startGame(channel.id);
        let solved = false;
        let winner: any = null;
        let hintStage = 0; // 0 = None, 1 = Artist, 2 = Album/Year, 3 = End

        let lastMessage: any = null;

        const sendGameMessage = async (targetInteraction?: any) => {
            let hintLabel = "";
            let hintValue = "";

            if (hintStage === 1) {
                hintLabel = "Artist";
                hintValue = data.artistName;
            } else if (hintStage === 2) {
                hintLabel = "Album";
                hintValue = data.albumName;
            }

            const buffer = await PuppeteerService.render('labyrinth', {
                artworkUrl: data.artworkUrl,
                lines: data.snippet,
                showHint: hintStage > 0,
                hintLabel,
                hintValue
            }, { width: 1080, height: 1080 });

            const attachment = new AttachmentBuilder(buffer, { name: `labyrinth_${Date.now()}.webp` });

            let header = `### 🎤 LYRIC LABYRINTH\nCan you identify this track? ⏳ The labyrinth is shifting...`;
            if (hintStage >= 1) header += `\n- **Hint:** Revealed the Artist!`;
            if (hintStage >= 2) header += `\n- **Hint:** Revealed the Album!`;

            const payload = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(header)
                .addFullImage(`attachment://${attachment.name}`);

            const messagePayload = { ...payload.build(), files: [attachment] };

            if (targetInteraction) return await targetInteraction.editReply(messagePayload);
            if (lastMessage) {
                try { return await lastMessage.edit(messagePayload); } catch { return await channel.send(messagePayload); }
            }
            return await channel.send(messagePayload);
        };

        lastMessage = await sendGameMessage(interaction);

        const guessCollector = channel.createMessageCollector({
            filter: (m) => !m.author.bot,
            time: 60000
        });

        const revealTimer = setInterval(async () => {
            try {
                if (solved || hintStage >= 2) {
                    clearInterval(revealTimer);
                    return;
                }
                hintStage++;
                const updatedMsg = await sendGameMessage();
                if (updatedMsg) lastMessage = updatedMsg;
            } catch (err) {
                console.error("[Labyrinth] Timer Error:", err);
                clearInterval(revealTimer);
                GameManager.endGame(channel.id);
            }
        }, 20000);

        guessCollector.on('collect', async (m) => {
            const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
            const guess = clean(m.content);
            const actual = clean(data.trackName);

            // Fuzzy match for track names
            if (guess === actual || (actual.includes(guess) && guess.length > 5 && guess.length >= actual.length - 2)) {
                solved = true;
                winner = m.author;
                clearInterval(revealTimer);
                guessCollector.stop('solved');
            }
        });

        guessCollector.on('end', async (_, reason) => {
            clearInterval(revealTimer);
            GameManager.endGame(channel.id);

            const isWinner = reason === 'solved' || solved;
            const resultPayload = new ComponentsV2()
                .setAccent(isWinner ? 0x4ade80 : 0xf04444)
                .addText(isWinner ? `🎉 **LABYRINTH SOLVED!** **${winner.displayName}** escaped the maze! The track was **${data.trackName}**.` : `⏰ **LOST IN THE MAZE!** The track was **${data.trackName}** by **${data.artistName}**.`)
                .addFullImage(data.artworkUrl)
                .addAction("-# Keep exploring?", {
                    type: ComponentType.Button,
                    custom_id: 'lab_play_again',
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
            filter: (i: any) => i.customId === 'lab_play_again',
            componentType: ComponentType.Button,
            time: 60000,
            max: 1
        });

        collector.on('collect', async (i: any) => {
            try {
                await i.deferUpdate();
                if (GameManager.isGameActive(channel.id)) return i.followUp({ content: '⚠️ Game active!', ephemeral: true });
                await this.runGame(interactionOrMessage, isSlash, i.user.id, channel, true);
            } catch { }
        });
    }
}

