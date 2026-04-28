import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { LastFM } from '../../services/api/LastFM';
import { resolveTargetUser } from '../../utils/userResolver';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class ArtistTopTracksCommand extends BaseCommand {
    name = 'at';
    description = 'View your top tracks for a specific artist';
    aliases = ['artisttop', 'artisttracks'];

    slashData = new SlashCommandBuilder()
        .setName('at')
        .setDescription('View your top tracks for a specific artist')
        .addStringOption(option =>
            option.setName('artist')
                .setDescription('The artist name')
                .setRequired(true)
        )
        .addUserOption(option =>
            option.setName('user')
                .setDescription('View another user\'s artist top tracks')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const isPrefix = !isSlash;
        if (!isPrefix && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;
        const userObj = targetUser;
        let artistQuery = isSlash ? interactionOrMessage.options.getString('artist') : args.join(' ').replace(/<@!?\d+>/g, '').trim();

        if (!artistQuery) {
            // Find current playing artist
            try {
                const dbUserCheck = await prisma.user.findUnique({ where: { discordId: userId } });
                if (dbUserCheck?.lastfmUsername) {
                    const tracks = await LastFM.getRecentTracks(dbUserCheck.lastfmUsername, 1, dbUserCheck.lastfmSessionKey || undefined);
                    if (tracks && tracks.length > 0) {
                        artistQuery = tracks[0].artist['#text'] || tracks[0].artist?.name;
                    }
                }
            } catch {}

            // Fire & Forget background sync
            triggerDeltaSync(userId);
            
            if (!artistQuery) {
                const msg = '❌ Please provide an artist name!';
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }
        }

        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
            if (!dbUser) {
                const isSelf = userId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
                const msg = isSelf 
                    ? '❌ You are not linked to Last.fm yet.\nRun `/login` or `!login` first!'
                    : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // Acknowledge typing
            if (isPrefix) {
                try {
                    interactionOrMessage.channel.sendTyping();
                } catch {}
            }

            // Find tracks locally
            let tracks = await prisma.userTrack.findMany({
                where: { 
                    userId: dbUser.id,
                    artistName: { equals: artistQuery, mode: 'insensitive' },
                    playcount: { gt: 0 }
                },
                orderBy: { playcount: 'desc' },
                take: 75
            });

            // Correct artist casing from DB if available
            const displayArtistName = tracks.length > 0 ? tracks[0].artistName : artistQuery;

            // Find total artist plays locally
            const artistTotal = await prisma.userArtist.findFirst({
                where: {
                    userId: dbUser.id,
                    artistName: { equals: artistQuery, mode: 'insensitive' }
                }
            });

            const totalArtistPlays = artistTotal ? artistTotal.playcount : 0;
            const totalDifferentTracks = tracks.length;

            if (tracks.length === 0) {
                // If local DB has no tracks, they might not be indexed. We can't fetch 75 tracks from Last.fm live easily
                // But we can fallback to lastFM artist.getTopTracks and check userplaycount (max 10-15 to not ratelimit)
                try {
                    const lfmArtists = await LastFM.searchAlbums(artistQuery, 1); // just to get precise name
                    if (lfmArtists?.length) {
                        artistQuery = lfmArtists[0].artist || artistQuery;
                    }
                } catch {}
                
                const msg = `😢 You don't have any tracked plays for **${displayArtistName}** or your library is currently importing.`;
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // Generate UI (Page 1)
            const pageTracks = tracks.slice(0, 10);
            const trackLines = pageTracks.map((t, i) => `${i + 1}. **${t.trackName}** - *${t.playcount} plays*`).join('\n');
            const totalPages = Math.ceil(totalDifferentTracks / 10);

            const displayName = userObj.globalName || userObj.displayName || userObj.username;

            const builder = new ComponentsV2()
                .setAccent(0xff0000)
                .addText(`### Your top tracks for '${displayArtistName}'`)
                .addSeparator()
                .addText(trackLines)
                .addSeparator()
                .addText(`-# Page 1/${totalPages} — ${totalDifferentTracks} different tracks\n-# ${displayName} has ${totalArtistPlays} total artist plays`)
                .addRow([
                    {
                        type: 2,
                        custom_id: `at-page:first:1:${userId}:${encodeURIComponent(displayArtistName)}`,
                        style: 2,
                        disabled: true,
                        emoji: { id: "883825508633182208", name: "pages_first" }
                    },
                    {
                        type: 2,
                        custom_id: `at-page:prev:1:${userId}:${encodeURIComponent(displayArtistName)}`,
                        style: 2,
                        disabled: true,
                        emoji: { id: "883825508507336704", name: "pages_previous" }
                    },
                    {
                        type: 2,
                        custom_id: `at-page:next:1:${userId}:${encodeURIComponent(displayArtistName)}`,
                        style: 2,
                        disabled: totalPages <= 1,
                        emoji: { id: "883825508087922739", name: "pages_next" }
                    },
                    {
                        type: 2,
                        custom_id: `at-page:last:1:${userId}:${encodeURIComponent(displayArtistName)}`,
                        style: 2,
                        disabled: totalPages <= 1,
                        emoji: { id: "883825508482183258", name: "pages_last" }
                    }
                ]);

            if (isSlash) await interactionOrMessage.editReply(builder.build());
            else await interactionOrMessage.reply(builder.build());

        } catch (err: any) {
            console.error('[at] Error:', err);
            const msg = `⚠️ Error: ${err.message || 'Something went wrong.'}`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
        }
    }
}
