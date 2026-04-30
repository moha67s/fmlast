import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, TextChannel, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { resolveTargetUser } from '../../utils/userResolver';
import { Spotify } from '../../services/api/Spotify';
import { Deezer } from '../../services/api/Deezer';
import { SettingService } from '../../services/bot/SettingService';

export default class ComboCommand extends BaseCommand {
    name = 'combo';
    description = 'View your current listening streak (consecutive plays of an artist or track).';
    aliases = ['streak'];

    slashData = new SlashCommandBuilder()
        .setName('combo')
        .setDescription('View your current listening streak.')
        .addUserOption((opt: any) =>
            opt.setName('user')
                .setDescription('Check another user\'s streak')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser || !dbUser.lastfmUsername) {
            const isSelf = userId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
            const msg = isSelf 
                ? '❌ You are not linked to Last.fm yet. Run `/login` first!'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            
            if (isSlash) await interactionOrMessage.reply({ content: msg, ephemeral: true });
            else await interactionOrMessage.channel.send(msg);
            return;
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { } }

        try {
            // We need to fetch recent tracks until the artist changes.
            // A combo is defined as consecutive plays of the SAME artist.
            let comboCount = 0;
            let comboArtist = '';
            let comboTrack = '';
            let trackComboCount = 0;
            let page = 1;
            let keepChecking = true;

            while (keepChecking && page <= 5) { // Max 1000 tracks back (5 pages of 200) to prevent infinite loops
                const recent = await LastFM.getRecentTracksPaginated(dbUser.lastfmUsername, 200, page, dbUser.lastfmSessionKey);
                
                if (!recent.tracks || recent.tracks.length === 0) {
                    break;
                }

                for (const t of recent.tracks) {
                    const artist = t.artist?.['#text'] || t.artist?.name || 'Unknown';
                    const track = t.name || 'Unknown';

                    if (comboCount === 0) {
                        // Initialize combo on the very first track
                        comboArtist = artist;
                        comboTrack = track;
                        comboCount = 1;
                        trackComboCount = 1;
                    } else {
                        // Check if it matches
                        if (artist === comboArtist) {
                            comboCount++;
                            if (track === comboTrack && trackComboCount === comboCount - 1) {
                                trackComboCount++;
                            }
                        } else {
                            // Streak broken
                            keepChecking = false;
                            break;
                        }
                    }
                }

                if (!keepChecking) break;
                
                // If we went through all 200 tracks and the combo is still going, fetch next page
                if (recent.tracks.length < 200) {
                    break; // Reached end of library
                }
                
                page++;
            }

            if (comboCount <= 1) {
                const msg = `**${targetUser.globalName || targetUser.username}** doesn't have an active combo right now.`;
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // Resolve Cover
            let coverUrl = await Spotify.getArtistCover(comboArtist);
            if (!coverUrl) coverUrl = await Deezer.getArtistCover(comboArtist);

            const builder = new ComponentsV2()
                .setAccent(embedColor) // Orange/Red for "Fire" combo
                .addText(`### 🔥 Listening Combo for ${targetUser.globalName || targetUser.username}`)
                .addText(`**${comboCount}** consecutive plays of **[${comboArtist}](https://www.last.fm/music/${encodeURIComponent(comboArtist)})**`);

            if (trackComboCount > 1) {
                builder.addText(`*(Including a streak of **${trackComboCount}** plays of the track **${comboTrack}**!)*`);
            }

            if (comboCount >= 50) builder.addText(`\n-# 🏆 Incredible streak! You are on fire.`);
            else if (comboCount >= 20) builder.addText(`\n-# 🌟 Great dedication!`);

            if (coverUrl) builder.addThumbnail(coverUrl);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);

        } catch (err: any) {
            console.error('[combo] error:', err);
            const msg = `❌ Failed to fetch listening combo.`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
        }
    }
}
