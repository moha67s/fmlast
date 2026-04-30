import {
  BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { AppleMusic } from '../../services/api/AppleMusic';
import { Deezer } from '../../services/api/Deezer';
import { Spotify } from '../../services/api/Spotify';
import { prisma } from '../../database/client';
import { SlashCommandBuilder,
  TextChannel,
  ButtonStyle,
  ComponentType
} from "discord.js";
import { GameManager } from '../../utils/gameManager';
import { downloadAndConvert } from '../../utils/downloader';
import sendVoice from '../../utils/sendVoice';

import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class BlindGuessCommand extends BaseCommand {
    name = 'blindguess';
    description = 'Play a snippet of one of your top tracks and guess which one it is!';
    // ... rest of class remains same until execute ...
    aliases = ['bg', 'guess'];

    slashData = new SlashCommandBuilder()
        .setName('blindguess')
        .setDescription('Play a snippet of one of your top tracks and guess which one it is!');

    private generateHint(original: string, percentReveal: number): string {
        let text = '';
        for (let i = 0; i < original.length; i++) {
            const char = original[i];
            // Use Unicode-aware letter/number check to support non-Latin scripts (Cyrillic, Arabic, etc.)
            if (/\p{L}|\p{N}/u.test(char)) {
                text += Math.random() < percentReveal ? char : '_';
            } else {
                text += char;
            }
        }
        return text;
    }

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

        await this.runGame(interactionOrMessage, isSlash, userId, channel);
    }

    private async runGame(interactionOrMessage: any, isSlash: boolean, discordId: string, channel: TextChannel, skipStartButton = false): Promise<void> {
        if (!skipStartButton) {
            if (isSlash && !interactionOrMessage.deferred && !interactionOrMessage.replied) await interactionOrMessage.deferReply();
            else if (!isSlash) {
                try { channel.sendTyping(); } catch { }
            }
        }

        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId } });
            if (!dbUser) throw new Error("User not found");

            // 1. Pick a track (DB first, then API)
            let target = await this.pickTrackFromDB(dbUser.id);
            if (!target) {
                target = await this.pickTrackFromAPI(dbUser.lastfmUsername!);
            }

            if (!target) throw new Error("Could not find any tracks");

            const { targetName, targetArtist } = target;

            // Find preview and artwork
            let previewUrl: string | null = null;
            let artworkUrl: string | null = null;

            artworkUrl = await Spotify.getTrackCover(targetName, targetArtist);

            const am = await AppleMusic.searchTrack(targetArtist, targetName);
            previewUrl = am?.previewUrl || null;
            if (!artworkUrl) artworkUrl = am?.artworkUrl || null;

            if (!previewUrl) {
                const dz = await Deezer.searchTrack(targetArtist, targetName);
                previewUrl = dz?.previewUrl || null;
                if (!artworkUrl) artworkUrl = artworkUrl || dz?.artworkUrl || null;
            }

            if (!previewUrl) {
                const msg = '😢 Could not find a playable snippet for this track. Skipping...';
                return this.runGame(interactionOrMessage, isSlash, discordId, channel, true);
            }

            // 2. Start Phase
            if (!skipStartButton) {
                const startContent = `### 🎧 BLIND GUESS\n` +
                    `Ready to test your memory on <@${discordId}>'s library?\n` +
                    `**Click the button below to start.**`;

                const startPayload = new ComponentsV2()
                    .setAccent(0x5865F2) // Blurple
                    .addText(startContent)
                    .addAction("-# Snippet Guess Game", {
                        type: ComponentType.Button,
                        custom_id: 'start_blindguess',
                        label: 'Play Snippet',
                        emoji: { name: '▶️' },
                        style: ButtonStyle.Success
                    })
                    .build();

                const initialMsg = isSlash
                    ? await interactionOrMessage.editReply(startPayload)
                    : await channel.send(startPayload);

                const filter = (i: any) => i.customId === 'start_blindguess';
                const collector = initialMsg.createMessageComponentCollector({
                    filter,
                    componentType: ComponentType.Button,
                    time: 60000,
                    max: 1
                });

                collector.on('collect', async (i: any) => {
                    await i.deferUpdate();
                    await this.startGameLoop(i, targetName, targetArtist, previewUrl!, artworkUrl, channel, dbUser, isSlash, interactionOrMessage, discordId);
                });

                collector.on('end', async (collected: any) => {
                    if (collected.size === 0) {
                        const timeoutPayload = new ComponentsV2()
                            .setAccent(0x5865F2)
                            .addText(`### 🎧 BLIND GUESS\n❌ **Game session timed out.**`)
                            .build();
                        if (isSlash) await interactionOrMessage.editReply(timeoutPayload);
                        else await initialMsg.edit(timeoutPayload).catch(() => { });
                    }
                });
            } else {
                await this.startGameLoop(null, targetName, targetArtist, previewUrl!, artworkUrl, channel, dbUser, isSlash, interactionOrMessage, discordId);
            }

        } catch (err: any) {
            console.error('Blind Guess Error:', err);
            GameManager.endGame(channel.id);
            const msg = '⚠️ Failed to start game.';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
        }
    }

    private async pickTrackFromDB(dbUserId: string): Promise<any> {
        try {
            const count = await prisma.userTrack.count({ where: { userId: dbUserId } });
            if (count === 0) return null;
            const item = await prisma.userTrack.findFirst({
                where: { userId: dbUserId },
                skip: Math.floor(Math.random() * count)
            });
            return { targetName: item!.trackName, targetArtist: item!.artistName };
        } catch { return null; }
    }

    private async pickTrackFromAPI(username: string): Promise<any> {
        try {
            const tracks = await LastFM.getTopTracks(username, 'overall', 100);
            if (!tracks?.length) return null;
            const item = tracks[Math.floor(Math.random() * tracks.length)];
            return { targetName: item.name, targetArtist: item.artist?.name || 'Unknown' };
        } catch { return null; }
    }

    private async startGameLoop(interaction: any, targetName: string, targetArtist: string, previewUrl: string, artworkUrl: string | null, channel: TextChannel, dbUser: any, isSlash: boolean, interactionOrMessage: any, originalDiscordId: string): Promise<void> {
        GameManager.startGame(channel.id);

        const progressContent = `### 🎧 BLIND GUESS\n` +
            `A track from <@${originalDiscordId}> is playing in voice.\n` +
            `**Guess the name to win.**`;

        const progressPayload = new ComponentsV2()
            .setAccent(0x5865F2)
            .addText(progressContent)
            .build();

        if (interaction) await interaction.editReply(progressPayload);
        else await channel.send(progressPayload);

        // Audio Logic
        const uniqueId = `bg_${Date.now()}`;
        const oggPath = await downloadAndConvert(previewUrl, uniqueId, 10);
        await sendVoice(channel.id, oggPath);

        // Guess Collector
        const guessCollector = channel.createMessageCollector({
            filter: (m) => !m.author.bot,
            time: 45000,
        });

        let solved = false;
        let winner: any = null;

        guessCollector.on('collect', async (m) => {
            const clean = (s: string) => s.replace(/[^a-z0-9]/g, '');
            const guessedClean = clean(m.content.toLowerCase().trim());
            const actualClean = clean(targetName.toLowerCase().trim());
            
            if (guessedClean === actualClean || (actualClean.includes(guessedClean) && guessedClean.length > 5 && guessedClean.length >= actualClean.length - 2)) {
                solved = true;
                winner = m.author;
                guessCollector.stop('solved');
            }
        });

        const hint1Timer = setTimeout(() => {
            if (!solved && GameManager.isGameActive(channel.id)) {
               channel.send(`💡 **Hint (30s left):** \`${this.generateHint(targetName, 0.25)}\``).catch(()=>{});
            }
        }, 15000);

        const hint2Timer = setTimeout(() => {
            if (!solved && GameManager.isGameActive(channel.id)) {
               channel.send(`💡 **Hint (15s left):** \`${this.generateHint(targetName, 0.50)}\``).catch(()=>{});
            }
        }, 30000);

        guessCollector.on('end', async () => {
            clearTimeout(hint1Timer);
            clearTimeout(hint2Timer);
            GameManager.endGame(channel.id);
            
            const resultPayload = new ComponentsV2()
                .setAccent(solved ? 0x4ade80 : 0xf04444)
                .addText(solved 
                    ? `🎉 **CORRECT!** Congratulations **${winner.username}**!\nIt was **${targetName}** by **${targetArtist}**.` 
                    : `⏰ **Time is up!**\nThe track was: **${targetName}** by **${targetArtist}**`)
                .addAction("-# Test your knowledge?", {
                    type: ComponentType.Button,
                    custom_id: 'blindguess_play_again',
                    label: 'Play Again',
                    emoji: { name: '🔄' },
                    style: ButtonStyle.Secondary
                });
                
            const resultMsg = await channel.send(resultPayload.build());

            // Play Again Collector
            const playAgainCollector = resultMsg.createMessageComponentCollector({
                filter: (i: any) => i.customId === 'blindguess_play_again',
                componentType: ComponentType.Button,
                time: 60000,
                max: 1
            });

            playAgainCollector.on('collect', async (i: any) => {
                await i.deferUpdate();
                if (GameManager.isGameActive(channel.id)) {
                    return i.followUp({ content: '⚠️ A game is already active!', ephemeral: true });
                }
                // PIVOT: Use the ID of the person who clicked Play Again!
                await this.runGame(interactionOrMessage, isSlash, i.user.id, channel, true);
            });
        });
    }
}
