import { SettingService } from '../../services/bot/SettingService';
import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { TextChannel, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { FriendService } from '../../services/bot/FriendService';
import { resolveTargetUser } from '../../utils/userResolver';
import { TrackResolverService } from '../../services/api/TrackResolverService';

interface LocalUser {
    id: string;
    discordId: string;
    lastfmUsername: string | null;
    displayName: string;
    playcount: number;
}

export default class FriendWhoKnowsAlbumCommand extends BaseCommand {
    name = 'fwka';
    description = 'Find out who listens to an album the most among your friends';

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('fwka')
        .setDescription('Find out who listens to an album the most among your friends')
        .addStringOption((o: any) => o.setName('query').setDescription('Album name (or "album by artist")').setRequired(false))
        .addUserOption((o: any) => o.setName('user').setDescription('Target user').setRequired(false));

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let searchQuery = args?.join(' ') || '';
        let artistName = '';
        let albumName = '';

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;
        
        
        // Remove mention from searchQuery if it was a message
        if (!isSlash && searchQuery) {
            searchQuery = searchQuery.replace(/<@!?\d+>/g, '').trim();

            // Check for streaming links
            if (searchQuery.startsWith('http')) {
                const resolved = await TrackResolverService.parseStreamingLink(searchQuery);
                if (resolved) {
                    artistName = resolved.artist;
                    albumName = resolved.track;
                    searchQuery = ''; // Skip manual parsing logic below
                }
            }
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser || !dbUser.lastfmUsername) {
            const isSelf = userId === authorId;
            const msg = isSelf 
                ? '❌ You must link your Last.fm account first! Use `/login`.'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
        }

        triggerDeltaSync(authorId);

        if (artistName && albumName) {
            // Already resolved from link, skip Last.fm search
        } else if (!searchQuery) {
            try {
                const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey);
                if (tracks.length > 0) {
                    artistName = tracks[0].artist?.['#text'] || tracks[0].artist?.name || '';
                    albumName = tracks[0].album?.['#text'] || tracks[0].album?.name || '';
                }
            } catch (e: any) {
                const reply = `❌ Error: ${e.message}`;
                return isSlash ? interactionOrMessage.editReply(reply) : interactionOrMessage.reply(reply);
            }
        } else {
            const byIndex = searchQuery.toLowerCase().lastIndexOf(' by ');
            if (byIndex !== -1) {
                albumName = searchQuery.substring(0, byIndex).trim();
                artistName = searchQuery.substring(byIndex + 4).trim();
            } else {
                let foundMatch = false;
                const lowerQuery = searchQuery.toLowerCase();
                try {
                    const recent = await LastFM.getRecentTracks(dbUser.lastfmUsername, 200, dbUser.lastfmSessionKey);
                    const exactMatch = recent.find((t: any) => t.album?.['#text']?.toLowerCase() === lowerQuery);
                    const partialMatch = !exactMatch ? recent.find((t: any) => t.album?.['#text']?.toLowerCase().includes(lowerQuery)) : null;
                    const match = exactMatch || partialMatch;

                    if (match) {
                        albumName = match.album?.['#text'];
                        artistName = match.artist?.name || match.artist?.['#text'] || '';
                        foundMatch = true;
                    }
                } catch {}

                if (!foundMatch) {
                    try {
                        const lfmAlbums = await LastFM.searchAlbums(searchQuery, 1);
                        if (lfmAlbums && lfmAlbums.length > 0) {
                            albumName = lfmAlbums[0].name;
                            artistName = lfmAlbums[0].artist;
                        } else {
                            albumName = searchQuery;
                        }
                    } catch {
                        albumName = searchQuery;
                    }
                }
            }
        }

        if (!albumName) {
            const reply = '❌ Could not determine album. Are you currently playing anything?';
            return isSlash ? interactionOrMessage.editReply(reply) : interactionOrMessage.reply(reply);
        }

        const friends = await FriendService.getFriends(userId);
        const friendUserIds = friends.map((f: any) => f.id);
        friendUserIds.push(dbUser.id);

        const localResults = await prisma.userAlbum.findMany({
            where: { 
                albumName: { equals: albumName, mode: 'insensitive' },
                ...(artistName ? { artistName: { equals: artistName, mode: 'insensitive' } } : {}),
                userId: { in: friendUserIds }
            },
            include: { user: true },
            orderBy: { playcount: 'desc' },
            take: 15
        });

        if (localResults.length > 0) {
            albumName = localResults[0].albumName;
            artistName = localResults[0].artistName;
        }

        const localUsers: LocalUser[] = localResults.map(r => ({
            id: r.user.id,
            discordId: r.user.discordId,
            lastfmUsername: r.user.lastfmUsername,
            displayName: r.user.lastfmUsername || r.user.discordId,
            playcount: r.playcount
        }));

        let thumbnail = null;
        try {
            const { Spotify } = await import('../../services/api/Spotify');
            const { Deezer } = await import('../../services/api/Deezer');

            const spInfo = await Spotify.getAlbumInfo(albumName, artistName);
            let url = spInfo.coverUrl;
            
            if (!url) {
                url = await Deezer.getAlbumCover(albumName, artistName);
            }
            
            thumbnail = url || null;
        } catch {
            thumbnail = null;
        }

        if (localUsers.length === 0) {
            const titleStr = artistName ? `${albumName} by ${artistName}` : albumName;
            const builder = new ComponentsV2()
                .addText(`### [${titleStr} among ${targetUser.displayName || targetUser.username}'s Friends](https://www.last.fm/music/${encodeURIComponent(artistName)}/${encodeURIComponent(albumName)})\n\n\u20051.\u2004\u2005**[${targetUser.displayName || targetUser.username}](https://last.fm/user/${encodeURIComponent(dbUser.lastfmUsername!)})\u200E** - **0** plays`);
            
            if (thumbnail) builder.addThumbnail(thumbnail);
            
            const payload = builder.build();
            return isSlash ? interactionOrMessage.editReply(payload) : interactionOrMessage.reply(payload);
        }

        let topDesc = '';
        for (let i = 0; i < localUsers.length; i++) {
            const u = localUsers[i];
            const isMe = u.discordId === authorId;
            const prefix = `${i + 1}.`;
            const spacing = '\u2004\u2005';
            
            topDesc += `\u2005${prefix}${spacing}**[${u.displayName}](https://last.fm/user/${encodeURIComponent(u.lastfmUsername!)})\u200E** - **${u.playcount}** plays\n`;
        }

        const titleDisplay = artistName ? `${albumName} by ${artistName}` : albumName;
        const fmLink = artistName ? `https://www.last.fm/music/${encodeURIComponent(artistName)}/${encodeURIComponent(albumName)}` : `https://www.last.fm/search?q=${encodeURIComponent(albumName)}`;
        
        let content = `### [${titleDisplay} among ${targetUser.displayName || targetUser.username}'s Friends](${fmLink})\n${topDesc}`;
        
        const builder = new ComponentsV2()
            .setAccent(embedColor);
            
        if (thumbnail) {
            builder.addThumbnail(thumbnail, content);
        } else {
            builder.addText(content);
        }

        const componentPayload = builder.build();

        if (isSlash) {
            await interactionOrMessage.editReply(componentPayload);
        } else {
            await interactionOrMessage.reply(componentPayload);
        }
    }
}
