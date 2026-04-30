import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { StatsService } from '../../services/bot/StatsService';
import { buildQuickChartUrl } from '../../utils/quickchart';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class AlbumPlaysCommand extends BaseCommand {
    name = 'albumplays';
    description = 'View playcount over time for an album';
    aliases = ['alp'];

    slashData = new SlashCommandBuilder()
        .setName('albumplays')
        .setDescription('View playcount over time for an album')
        .addStringOption(opt => 
            opt.setName('album')
                .setDescription('The album name (leave blank for currently playing)')
                .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('artist')
                .setDescription('The artist name')
                .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('grouping')
                .setDescription('Group by month or year (default: month)')
                .setRequired(false)
                .addChoices(
                    { name: 'Year', value: 'year' },
                    { name: 'Month', value: 'month' }
                )
        )
        .addUserOption(opt => 
            opt.setName('user')
                .setDescription('View for another user')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        let albumQuery = '';
        let artistQuery = '';
        let grouping: 'year' | 'month' = 'month';
        let targetUserObj = null;

        if (isSlash) {
            albumQuery = interactionOrMessage.options.getString('album') || '';
            artistQuery = interactionOrMessage.options.getString('artist') || '';
            grouping = (interactionOrMessage.options.getString('grouping') as 'year' | 'month') || 'month';
            targetUserObj = interactionOrMessage.options.getUser('user');
        } else {
            if (args && args.length > 0) {
                const str = args.join(' ');
                let cleanStr = str;
                if (str.toLowerCase().startsWith('month ')) {
                    grouping = 'month';
                    cleanStr = str.substring(6);
                } else if (str.toLowerCase().startsWith('year ')) {
                    grouping = 'year';
                    cleanStr = str.substring(5);
                }
                const parts = cleanStr.split('|').map(s => s.trim());
                albumQuery = parts[0];
                if (parts.length > 1) artistQuery = parts[1];
            }
        }

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        const lookupUser = targetUserObj || author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        const userSettings = await SettingService.getUser(lookupUser.id !== author.id ? `<@${lookupUser.id}>` : '', dbAuthor);
        const targetDbUser = userSettings.targetUser;

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            if (!albumQuery) {
                // 1. Try currently playing track in voice channel
                const { QueueManager } = await import('../../services/music/QueueManager');
                const queue = QueueManager.getQueue(interactionOrMessage.guildId || '');
                if (queue?.currentTrack) {
                    // Try to get album from trackTitle if it's "Album - Track" or similar, 
                    // but the music player usually has metadata
                    // Wait, YoutubeResult has artistName and trackTitle, but usually not albumName
                    // However, MetadataService might have enriched it.
                }

                // 2. Try Last.fm
                if (!targetDbUser.lastfmUsername) {
                    throw new Error('No album provided, and Last.fm account not linked to check current track.');
                }

                const recent = await LastFM.getRecentTracks(targetDbUser.lastfmUsername, 1, targetDbUser.lastfmSessionKey);
                if (recent && recent.length > 0) {
                    const track = recent[0];
                    albumQuery = track.album?.['#text'] || '';
                    artistQuery = track.artist?.['#text'] || track.artist?.name || '';

                    // 3. Deeper lookup if album is missing from recent scrobble
                    if (!albumQuery) {
                        try {
                            const info = await LastFM.getTrackInfo(artistQuery, track.name, targetDbUser.lastfmUsername, targetDbUser.lastfmSessionKey);
                            if (info?.album?.title) {
                                albumQuery = info.album.title;
                                if (!artistQuery) artistQuery = info.artist?.name || '';
                            }
                        } catch {}
                    }
                }

                if (!albumQuery) {
                    throw new Error('No album provided, and no recent album found to look up.');
                }
            }

            if (!albumQuery) throw new Error('Could not resolve an album name.');

            // Fire & Forget background sync
            triggerDeltaSync(targetDbUser.discordId);

            const data = await StatsService.getPlaycountOverTime(targetDbUser.id, grouping, { album: albumQuery, artist: artistQuery || undefined });
            
            if (data.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no logged plays for **${albumQuery}**.`)
                    .build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const labels = data.map(d => {
                const date = new Date(d.period_start);
                return grouping === 'year' 
                    ? date.getFullYear().toString() 
                    : `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
            });
            const values = data.map(d => d.playcount);

            const userColorHex = (targetDbUser.settings as any)?.embedColor || '#1DB954';
            const userColorInt = parseInt(userColorHex.replace('#', ''), 16);

            const chartUrl = buildQuickChartUrl(`Plays for ${albumQuery}`, labels, values, userColorHex, 'bar');
            
            const totalPlays = values.reduce((a, b) => a + b, 0);

            const builder = new ComponentsV2()
                .setAccent(userColorInt)
                .addText(`## Playcount over time for ${albumQuery}\n${artistQuery ? `by **${artistQuery}**\n` : ''}**${userSettings.displayName}** has **${totalPlays.toLocaleString()}** total logged plays.`)
                .setImage(chartUrl);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
