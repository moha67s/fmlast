import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Spotify } from '../../services/api/Spotify';
import { AppleMusic } from '../../services/api/AppleMusic';
import { Deezer } from '../../services/api/Deezer';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, TextChannel, ButtonStyle, ComponentType } from 'discord.js';
import { GameManager } from '../../utils/gameManager';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class JumbleCommand extends BaseCommand {
    name = 'jumble';
    description = 'Unscramble the name of one of your top artists, albums, or tracks!';
    aliases = ['jmb'];

    slashData = new SlashCommandBuilder()
        .setName('jumble')
        .setDescription('Unscramble the name of one of your top artists, albums, or tracks!');

    // Utility to scramble words while preserving spaces and symbols
    private scrambleWord(word: string): string {
        const letters = word.split('').filter(c => /[a-zA-Z0-9]/.test(c));
        if (letters.length <= 1) return word;

        // Scramble letters deeply
        for (let i = letters.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [letters[i], letters[j]] = [letters[j], letters[i]];
        }

        let scrambledWord = '';
        let letterIdx = 0;
        for (let i = 0; i < word.length; i++) {
            if (/[a-zA-Z0-9]/.test(word[i])) {
                // Determine casing based on original character
                const char = word[i];
                const isUpper = char === char.toUpperCase() && /[a-zA-Z]/.test(char);
                const randomizedChar = letters[letterIdx++];
                
                if (/[a-zA-Z]/.test(randomizedChar)) {
                    scrambledWord += isUpper ? randomizedChar.toUpperCase() : randomizedChar.toLowerCase();
                } else {
                    scrambledWord += randomizedChar;
                }
            } else {
                scrambledWord += word[i];
            }
        }

        // If by chance it's exactly the same, swap random two
        if (scrambledWord.toLowerCase() === word.toLowerCase() && letters.length > 2) {
             const charArr = scrambledWord.split('');
             let i1 = -1, i2 = -1;
             for(let k=0; k<charArr.length; k++) {
                 if(/[a-zA-Z0-9]/.test(charArr[k])) {
                     if(i1 === -1) i1 = k;
                     else if(i2 === -1) { i2 = k; break; }
                 }
             }
             if(i1 !== -1 && i2 !== -1) {
                 [charArr[i1], charArr[i2]] = [charArr[i2], charArr[i1]];
                 scrambledWord = charArr.join('');
             }
        }
        return scrambledWord;
    }

    private scrambleString(str: string): string {
        return str.split(/(\s+)/).map(part => this.scrambleWord(part)).join('');
    }

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

        // Check if user exists at all
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

            // 1. Pick a target (DB first, then API)
            let target = await this.pickTargetFromDB(dbUser.id);
            if (!target) {
                target = await this.pickTargetFromAPI(dbUser.lastfmUsername!);
            }

            const { targetType, targetName, targetArtist } = target;
            let displaySub = target.displaySub;

            // Resolve EP/Single for albums via Spotify
            if (targetType === 'ALBUM') {
                const meta = await Spotify.getAlbumMetadata(targetName, targetArtist);
                if (meta.albumType === 'single') displaySub = `Single by ${targetArtist}`;
                else if (meta.albumType === 'compilation') displaySub = `Compilation by ${targetArtist}`;
                else displaySub = `Album by ${targetArtist}`;
            }

            const cleanActual = targetName.toLowerCase().replace(/[^a-z0-9]/g, '');
            if(cleanActual.length < 3) {
                 return this.runGame(interactionOrMessage, isSlash, discordId, channel, true);
            }

            const scrambled = this.scrambleString(targetName);

            // 2. Start Phase
            if (!skipStartButton) {
                const startContent = `### 🧩 JUMBLE WORD\n` +
                    `Ready to unscramble a top **${targetType.toLowerCase()}** for <@${discordId}>?\n` +
                    `**Click the button below to start.**`;

                const startPayload = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(startContent)
                    .addAction("-# Jumble Game", {
                        type: 2,
                        custom_id: 'start_jumble',
                        label: 'Start Game',
                        emoji: { name: '🧩' },
                        style: ButtonStyle.Primary
                    })
                    .build();

                const initialMsg = isSlash
                    ? await interactionOrMessage.editReply(startPayload)
                    : await channel.send(startPayload);

                const filter = (i: any) => i.customId === 'start_jumble';
                const collector = initialMsg.createMessageComponentCollector({
                    filter,
                    componentType: ComponentType.Button,
                    time: 60000,
                    max: 1
                });

                collector.on('collect', async (i: any) => {
                    await i.deferUpdate();
                    await this.startGameLoop(i, targetType, targetName, targetArtist, scrambled, cleanActual, channel, dbUser, isSlash, interactionOrMessage, discordId);
                });

                collector.on('end', async (collected: any) => {
                    if (collected.size === 0) {
                        const timeoutPayload = new ComponentsV2()
                            .setAccent(0x5865F2)
                            .addText(`### 🧩 JUMBLE WORD\n❌ **Game session timed out.**`)
                            .build();
                        if (isSlash) await interactionOrMessage.editReply(timeoutPayload);
                        else await initialMsg.edit(timeoutPayload).catch(() => { });
                    }
                });
            } else {
                await this.startGameLoop(null, targetType, targetName, targetArtist, scrambled, cleanActual, channel, dbUser, isSlash, interactionOrMessage, discordId);
            }

        } catch (err: any) {
            console.error('Jumble Error:', err);
            GameManager.endGame(channel.id);
            const msg = '⚠️ Failed to start game.';
            if (isSlash) await interactionOrMessage.editReply({ content: msg, components: [] });
            else await channel.send(msg);
        }
    }

    private async pickTargetFromDB(dbUserId: string): Promise<any> {
        const r = Math.random();
        let choice = 'TRACK';
        if (r < 0.25) choice = 'ARTIST';
        else if (r < 0.50) choice = 'ALBUM';

        try {
            if (choice === 'ARTIST') {
                const count = await prisma.userArtist.count({ where: { userId: dbUserId } });
                if (count === 0) return null;
                const item = await prisma.userArtist.findFirst({ where: { userId: dbUserId }, skip: Math.floor(Math.random() * count) });
                return { targetType: 'ARTIST', targetName: item!.artistName, targetArtist: '', displaySub: 'Top Artist' };
            } else if (choice === 'ALBUM') {
                const count = await prisma.userAlbum.count({ where: { userId: dbUserId } });
                if (count === 0) return null;
                const item = await prisma.userAlbum.findFirst({ where: { userId: dbUserId }, skip: Math.floor(Math.random() * count) });
                return { targetType: 'ALBUM', targetName: item!.albumName, targetArtist: item!.artistName, displaySub: `Album by ${item!.artistName}` };
            } else {
                const count = await prisma.userTrack.count({ where: { userId: dbUserId } });
                if (count === 0) return null;
                const item = await prisma.userTrack.findFirst({ where: { userId: dbUserId }, skip: Math.floor(Math.random() * count) });
                return { targetType: 'TRACK', targetName: item!.trackName, targetArtist: item!.artistName, displaySub: `Track by ${item!.artistName}` };
            }
        } catch { return null; }
    }

    private async pickTargetFromAPI(username: string): Promise<any> {
        const categories = ['artist', 'album', 'track'];
        // Weights: 50% track, 25% artist, 25% album
        const r = Math.random();
        const category = r < 0.5 ? 'track' : (r < 0.75 ? 'artist' : 'album');

        if (category === 'artist') {
            const items = await LastFM.getTopArtists(username, 'overall', 50);
            const item = items[Math.floor(Math.random() * items.length)];
            return { targetType: 'ARTIST', targetName: item.name, targetArtist: '', displaySub: 'Top Artist' };
        } else if (category === 'album') {
            const items = await LastFM.getTopAlbums(username, 'overall', 50);
            const item = items[Math.floor(Math.random() * items.length)];
            return { targetType: 'ALBUM', targetName: item.name, targetArtist: item.artist?.name || 'Unknown', displaySub: 'Album' };
        } else {
            const items = await LastFM.getTopTracks(username, 'overall', 50);
            const item = items[Math.floor(Math.random() * items.length)];
            return { targetType: 'TRACK', targetName: item.name, targetArtist: item.artist?.name || 'Unknown', displaySub: 'Track' };
        }
    }

    private async startGameLoop(interaction: any, targetType: string, targetName: string, targetArtist: string, scrambled: string, cleanActual: string, channel: TextChannel, dbUser: any, isSlash: boolean, interactionOrMessage: any, originalDiscordId: string): Promise<void> {
        GameManager.startGame(channel.id);

        const progressContent = `### 🧩 JUMBLE WORD\n` +
            `Guess the **${targetType}** for <@${originalDiscordId}>!\n\n` +
            `# ${scrambled}\n` +
            (targetArtist ? `*by ${targetArtist}*` : ``);

        const progressPayload = new ComponentsV2()
            .setAccent(0x5865F2)
            .addText(progressContent)
            .build();

        if (interaction) await interaction.editReply(progressPayload);
        else await channel.send(progressPayload);

        const guessCollector = channel.createMessageCollector({ filter: (m) => !m.author.bot, time: 45000 });
        let solved = false;
        let winner: any = null;

        guessCollector.on('collect', async (m) => {
            const clean = (s: string) => s.replace(/[^a-z0-9]/g, '');
            const guessedClean = clean(m.content.toLowerCase().trim());
            if (guessedClean === cleanActual || (cleanActual.includes(guessedClean) && guessedClean.length > 5 && guessedClean.length >= cleanActual.length - 2)) {
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
                    ? `🎉 **CORRECT!** Congratulations **${winner.username}**!\nIt was indeed **${targetName}**.` 
                    : `⏰ **Time is up!**\nThe correct answer was: **${targetName}**`)
                .addAction("-# Challenge yourself?", {
                    type: 2,
                    custom_id: 'jumble_play_again',
                    label: 'Play Again',
                    emoji: { name: '🔄' },
                    style: ButtonStyle.Secondary
                });
                
            const resultMsg = await channel.send(resultPayload.build());

            const playAgainCollector = resultMsg.createMessageComponentCollector({
                filter: (i: any) => i.customId === 'jumble_play_again',
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
