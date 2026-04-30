import { SettingService } from '../../services/bot/SettingService';
import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { TextChannel, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { FriendService } from '../../services/bot/FriendService';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { resolveTargetUser } from '../../utils/userResolver';

interface LocalUser {
    id: string;
    discordId: string;
    lastfmUsername: string | null;
    displayName: string;
    playcount: number;
}

export default class FriendWhoKnowsCommand extends BaseCommand {
    name = 'fwk';
    description = 'Find out who listens to an artist the most among your friends';

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('fwk')
        .setDescription('Find out who listens to an artist the most among your friends')
        .addStringOption((o: any) => o.setName('artist').setDescription('Artist name to search').setRequired(false))
        .addUserOption((o: any) => o.setName('user').setDescription('Target user').setRequired(false));

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let artistName = args?.join(' ') || '';

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;
        
        
        // Remove mention from artistName if it was a message
        if (!isSlash && artistName) {
            artistName = artistName.replace(/<@!?\d+>/g, '').trim();

            // Check for streaming links
            if (artistName.startsWith('http')) {
                const resolved = await TrackResolverService.parseStreamingLink(artistName);
                if (resolved) {
                    artistName = resolved.artist;
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

        // Fire & Forget: Background sync
        triggerDeltaSync(authorId);

        if (!artistName) {
            try {
                const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey);
                if (tracks.length > 0) {
                    artistName = tracks[0].artist?.['#text'] || tracks[0].artist?.name;
                }
            } catch (e: any) {
                const reply = `❌ Error: ${e.message}`;
                return isSlash ? interactionOrMessage.editReply(reply) : interactionOrMessage.reply(reply);
            }
        }

        if (!artistName) {
            const reply = '❌ Could not determine artist. Are you currently playing anything?';
            return isSlash ? interactionOrMessage.editReply(reply) : interactionOrMessage.reply(reply);
        }

        const friends = await FriendService.getFriends(userId);
        const friendUserIds = friends.map((f: any) => f.id);
        friendUserIds.push(dbUser.id); // Include the target user

        const localResults = await prisma.userArtist.findMany({
            where: { 
                artistName: { equals: artistName, mode: 'insensitive' },
                userId: { in: friendUserIds } 
            },
            include: { user: true },
            orderBy: { playcount: 'desc' },
            take: 15
        });

        // Resolve capitalizing artistName to whatever the top DB result is
        if (localResults.length > 0) {
            artistName = localResults[0].artistName;
        }

        const localUsers: LocalUser[] = localResults.map(r => ({
            id: r.user.id,
            discordId: r.user.discordId,
            lastfmUsername: r.user.lastfmUsername,
            displayName: r.user.lastfmUsername || r.user.discordId,
            playcount: r.playcount
        }));

        // ── 1. GLOBAL RESOLUTION (UTR) ──
        const resolved = await TrackResolverService.resolveArtist(artistName);
        
        artistName = resolved.artist;
        const thumbnail = resolved.avatarUrl;
        const tagsText = resolved.tags.filter(n => n.toLowerCase() !== 'seen live').slice(0, 4).join(' - ').toLowerCase();

        if (localUsers.length === 0) {
            const builder = new ComponentsV2()
                .addText(`### [${artistName} among ${targetUser.displayName || targetUser.username}'s Friends](https://www.last.fm/music/${encodeURIComponent(artistName)})\n\n\u20051.\u2004\u2005**[${targetUser.displayName || targetUser.username}](https://last.fm/user/${encodeURIComponent(dbUser.lastfmUsername!)})\u200E** - **0** plays`);
            
            if (thumbnail) builder.addThumbnail(thumbnail);
            if (tagsText) builder.addFooter(tagsText);

            const payload = builder.build();
            return isSlash ? interactionOrMessage.editReply(payload) : interactionOrMessage.reply(payload);
        }

        let topDesc = '';
        for (let i = 0; i < localUsers.length; i++) {
            const u = localUsers[i];
            const isMe = u.discordId === authorId; // Highlight the command executor
            const prefix = `${i + 1}.`;
            const spacing = '\u2004\u2005';
            
            topDesc += `\u2005${prefix}${spacing}**[${u.displayName}](https://last.fm/user/${encodeURIComponent(u.lastfmUsername!)})\u200E** - **${u.playcount}** plays\n`;
        }

        let content = `### [${artistName} among ${targetUser.displayName || targetUser.username}'s Friends](https://www.last.fm/music/${encodeURIComponent(artistName)})\n${topDesc}`;
        
        if (tagsText) {
            content += `\n-# *${tagsText}*`;
        }

        const builder = new ComponentsV2()
            .setAccent(embedColor); // Custom accent for friends
            
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
