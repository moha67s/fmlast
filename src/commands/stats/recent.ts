import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { LastfmHealthTracker } from '../../services/bot/LastfmHealthTracker';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class RecentTracksCommand extends BaseCommand {
    name = 'recent';
    description = 'View your recently played tracks';
    aliases = ['rt', 'recenttracks'];

    slashData = new SlashCommandBuilder()
        .setName('recent')
        .setDescription('View recently played tracks')
        .addStringOption((opt: any) => 
            opt.setName('query')
                .setDescription('User mention/username or amount (e.g. "@user 10")')
                .setRequired(false)
        )
        .addStringOption((opt: any) => 
            opt.setName('artist')
                .setDescription('Filter by artist name')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const query = isSlash 
            ? interactionOrMessage.options.getString('query') || '' 
            : (args ? args.join(' ') : '');

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        // 1. Resolve User (Phase 2 SettingService)
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        const userSettings = await SettingService.getUser(query, dbAuthor);
        const targetDbUser = userSettings.targetUser;

        if (!targetDbUser.lastfmUsername) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Target user has no Last.fm linked.').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        // 2. Resolve Amount (Phase 2 SettingService)
        const { amount } = SettingService.getAmount(userSettings.searchValue, 10, 50);

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // Check for filters
            let rawQuery = userSettings.searchValue;
            const artistMatch = rawQuery.match(/artist:("([^"]+)"|'([^']+)'|(\S+))/i);
            const albumMatch = rawQuery.match(/album:("([^"]+)"|'([^']+)'|(\S+))/i);
            const trackMatch = rawQuery.match(/track:("([^"]+)"|'([^']+)'|(\S+))/i);
            const yearMatch = rawQuery.match(/year:(\d{4})/i);

            let filterArtist = artistMatch ? (artistMatch[2] || artistMatch[3] || artistMatch[4]) : null;
            if (isSlash) {
                const slashArtist = interactionOrMessage.options.getString('artist');
                if (slashArtist) filterArtist = slashArtist;
            }

            const filterAlbum = albumMatch ? (albumMatch[2] || albumMatch[3] || albumMatch[4]) : null;
            const filterTrack = trackMatch ? (trackMatch[2] || trackMatch[3] || trackMatch[4]) : null;
            const filterYear = yearMatch ? parseInt(yearMatch[1]) : null;

            let isFiltered = filterArtist || filterAlbum || filterTrack || filterYear;

            let recentList: any[] = [];
            let headerText = `### Recent Tracks for ${userSettings.displayName}`;

            if (isFiltered) {
                // FILTERED: Read from Native Database
                let whereClause: any = { userId: targetDbUser.id };
                if (filterArtist) whereClause.artistName = { contains: filterArtist, mode: 'insensitive' };
                if (filterAlbum) whereClause.albumName = { contains: filterAlbum, mode: 'insensitive' };
                if (filterTrack) whereClause.trackName = { contains: filterTrack, mode: 'insensitive' };
                if (filterYear) {
                    whereClause.timePlayed = {
                        gte: new Date(`${filterYear}-01-01T00:00:00.000Z`),
                        lt: new Date(`${filterYear + 1}-01-01T00:00:00.000Z`)
                    };
                }

                // Fire background sync first
                triggerDeltaSync(targetDbUser.discordId);

                const dbPlays = await prisma.userPlay.findMany({
                    where: whereClause,
                    orderBy: { timePlayed: 'desc' },
                    take: amount
                });

                if (dbPlays.length === 0) {
                    const payload = new ComponentsV2().addText(`**${userSettings.displayName}** has no tracks matching those filters.`).build();
                    if (isSlash) await interactionOrMessage.editReply(payload);
                    else await interactionOrMessage.channel.send(payload);
                    return;
                }

                recentList = dbPlays.map(p => ({
                    artist: { name: p.artistName },
                    name: p.trackName,
                    album: { '#text': p.albumName || '' },
                    date: { uts: Math.floor(p.timePlayed.getTime() / 1000) },
                    '@attr': {}
                }));

                // Build filter header text
                let filterStrs = [];
                if (filterArtist) filterStrs.push(`Artist: ${filterArtist}`);
                if (filterAlbum) filterStrs.push(`Album: ${filterAlbum}`);
                if (filterTrack) filterStrs.push(`Track: ${filterTrack}`);
                if (filterYear) filterStrs.push(`Year: ${filterYear}`);
                headerText = `### Recent Tracks for ${userSettings.displayName}\n-# Filters: ${filterStrs.join(' | ')}`;

            } else {
                // UNFILTERED: Use LastFM API to get 'Now Playing'
                const recent = await LastFM.getRecentTracksPaginated(
                    targetDbUser.lastfmUsername, 
                    amount, 
                    1, 
                    targetDbUser.lastfmSessionKey
                );

                if (!recent.tracks || recent.tracks.length === 0) {
                    const payload = new ComponentsV2().addText(`**${userSettings.displayName}** has no recent tracks.`).build();
                    if (isSlash) await interactionOrMessage.editReply(payload);
                    else await interactionOrMessage.channel.send(payload);
                    return;
                }
                recentList = recent.tracks.slice(0, amount);
            }

            // 4. Build Embed
            const builder = new ComponentsV2().setAccent(embedColor);
            
            // Check health status (Phase 1 HealthTracker)
            const healthStatus = await LastfmHealthTracker.getStatusLine();
            if (healthStatus) builder.addText(healthStatus);

            const list = recentList.map((t: any) => {
                const artist = t.artist?.['#text'] || t.artist?.name || 'Unknown';
                const track = t.name || 'Unknown';
                const album = t.album?.['#text'] || '';
                const uts = t.date?.uts;
                
                let timeStr = t['@attr']?.nowplaying === 'true' ? ' **(Now Playing)**' : (uts ? ` • <t:${uts}:R>` : '');
                
                const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
                const trackUrl = `${artistUrl}/_/${encodeURIComponent(track)}`;
                
                return `**[${track}](${trackUrl})** by **[${artist}](${artistUrl})**${album ? ` from *${album}*` : ''}${timeStr}`;
            }).join('\n');

            builder.addText(`${headerText}\n${list}`);
            
            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch recent tracks.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
