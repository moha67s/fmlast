import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Deezer } from '../../services/api/Deezer';
import { prisma } from '../../database/client';
import { TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { CrownService } from '../../services/bot/CrownService';
import { config } from '../../../config';
import { resolveTargetUser } from '../../utils/userResolver';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { SettingService } from '../../services/bot/SettingService';

interface LocalUser {
    id: string;
    discordId: string;
    lastfmUsername: string | null;
    displayName: string;
    playcount: number;
}

export default class WhoKnowsCommand extends BaseCommand {
    name = 'whoknows';
    description = 'Find out who listens to an artist the most in this server';
    aliases = ['w', 'wk'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('whoknows')
        .setDescription('Find out who listens to an artist the most in this server')
        .addStringOption((o: any) => o.setName('artist').setDescription('Artist name to search').setRequired(false))
        .addUserOption((o: any) => o.setName('user').setDescription('Target user to get artist from').setRequired(false));

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        let artistName = args?.join(' ') || '';

        if (isSlash) {
            artistName = interactionOrMessage.options.getString('artist') || '';
            await interactionOrMessage.deferReply();
        } else {
            try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { }
        }

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const targetUserId = targetUser.id;
        
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

        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const guild = interactionOrMessage.guild;

        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        if (!guild) {
            const reply = '❌ This command can only be used in a server.';
            return isSlash ? interactionOrMessage.editReply(reply) : interactionOrMessage.reply(reply);
        }

        // Get user session to fetch now playing if needed
        const dbUser = await prisma.user.findUnique({ where: { discordId: targetUserId } });
        if (!dbUser || !dbUser.lastfmUsername) {
            const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
            const isSelf = targetUserId === authorId;
            const msg = isSelf 
                ? '❌ You must link your Last.fm account first! Use `/login`.'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
        }

        // Fire & Forget: Background sync their local DB if > 15 mins since last
        triggerDeltaSync(targetUserId);

        if (artistName) {
            // Already resolved from link, skip Last.fm search
        } else if (!artistName) {
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
            const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
            const isSelf = targetUserId === authorId;
            const msg = isSelf
                ? '❌ Could not determine artist. Are you currently playing anything?'
                : `❌ Could not determine artist. **${targetUser.username}** is not currently playing anything.`;
            return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
        }

        // Fetch Global Users from DB natively in milliseconds
        const globalResults = await prisma.userArtist.findMany({
            where: { artistName },
            include: { user: true },
            orderBy: { playcount: 'desc' }
        });

        // Map them locally safely avoiding Opcode 8 Rate Limits
        const globalIds = globalResults.map(r => r.user.discordId);
        let cachedMembers;
        try {
            cachedMembers = await guild.members.fetch({ user: globalIds });
        } catch (e) {
            console.error("Failed to fetch guild members:", e);
        }

        const localUsers: LocalUser[] = [];
        for (const row of globalResults) {
            const isBot = row.user.discordId === config.BOT_DISCORD_ID;
            const isAuthor = row.user.discordId === authorId;
            const inGuild = cachedMembers && cachedMembers.has(row.user.discordId);

            if (inGuild || isBot) {
                const member = inGuild ? cachedMembers.get(row.user.discordId) : null;
                localUsers.push({
                    id: row.user.id,
                    discordId: row.user.discordId,
                    lastfmUsername: row.user.lastfmUsername,
                    displayName: member?.displayName || row.user.lastfmUsername,
                    playcount: row.playcount
                });
            } else if (!cachedMembers && isAuthor) {
                // Fallback if fetch fails: at least include the author
                localUsers.push({
                    id: row.user.id,
                    discordId: row.user.discordId,
                    lastfmUsername: row.user.lastfmUsername,
                    displayName: (interactionOrMessage.guild?.members.cache.get(dbUser.discordId)?.displayName as string) || (dbUser.lastfmUsername as string),
                    playcount: row.playcount
                });
            }
        }

        // Parallel fetch Metadata
        let tagsText = '';
        let thumbnail = null;

        await Promise.all([
            LastFM.getArtistTopTags(artistName).then(tags => {
                const validTags = tags.map((t: any) => t.name).filter((n: string) => n.toLowerCase() !== 'seen live');
                tagsText = validTags.slice(0, 4).join(' - ').toLowerCase();
            }).catch(() => { }),
            (async () => {
                try {
                    const { Spotify } = await import('../../services/api/Spotify');
                    let url = await Spotify.getArtistCover(artistName);

                    if (!url) {
                        url = await Deezer.getArtistCover(artistName);
                    }

                    thumbnail = url || null;
                } catch {
                    thumbnail = null;
                }
            })()
        ]);

        if (localUsers.length === 0) {
            const builder = new ComponentsV2()
                .addText(`### [${artistName} in ${interactionOrMessage.guild?.name || 'this server'}](https://www.last.fm/music/${encodeURIComponent(artistName)})\n\n\u20051.\u2004\u2005**[${targetUser.displayName || targetUser.username}](https://last.fm/user/${encodeURIComponent(dbUser.lastfmUsername!)})\u200E** - **0** plays`);
            
            if (thumbnail) builder.addThumbnail(thumbnail);
            if (tagsText) builder.addFooter(tagsText);

            const payload = builder.build();
            return isSlash ? interactionOrMessage.editReply(payload) : interactionOrMessage.reply(payload);
        }

        // Ensure sorted cleanly
        localUsers.sort((a, b) => b.playcount - a.playcount);

        // ── Crown Logic ──
        const topUser = localUsers[0];
        const initialCrownHolder = await CrownService.getArtistCrown(guild.id, artistName);
        let crownHolder = initialCrownHolder;
        let crownMessage = '';
        let wasNewlyClaimed = false;

        // Case 1: #1 qualifies for a NEW crown or a REASSIGNMENT
        if (topUser && topUser.playcount >= 20) {
            if (!crownHolder || crownHolder.userId !== topUser.id || crownHolder.playcount !== topUser.playcount) {
                await CrownService.claimCrown(guild.id, artistName, topUser.id, topUser.playcount);
                crownHolder = await CrownService.getArtistCrown(guild.id, artistName); // Refresh

                // Only announce if the ACTUAL USER holding the crown changed (not just a playcount update)
                if (!initialCrownHolder || initialCrownHolder.userId !== crownHolder?.userId) {
                    wasNewlyClaimed = true;
                }
            }
        }

        let topDesc = '';
        for (let i = 0; i < Math.min(localUsers.length, 10); i++) {
            const u = localUsers[i];
            const isCrownHolder = crownHolder?.userId === u.id;
            const prefix = isCrownHolder ? '👑' : `${i + 1}.`;
            const spacing = isCrownHolder ? '\u200A\u2005' : '\u2004\u2005';

            topDesc += `\u2005${prefix}${spacing}**[${u.displayName}](https://last.fm/user/${encodeURIComponent(u.lastfmUsername!)})\u200E** - **${u.playcount}** plays\n`;
        }

        if (wasNewlyClaimed && crownHolder && crownHolder.user?.discordId) {
            const member = await guild.members.fetch(crownHolder.user.discordId).catch(() => null);
            const holderName = member?.displayName || crownHolder.user.lastfmUsername || 'Unknown';
            crownMessage = `\n**Crown claimed by ${holderName}!**`;
        }

        let content = `### [${artistName} in ${guild.name}](https://www.last.fm/music/${encodeURIComponent(artistName)})\n${topDesc}${crownMessage}`;

        if (tagsText) {
            content += `\n-# *${tagsText}*`;
        }

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
