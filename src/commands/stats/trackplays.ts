import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { StatsService } from '../../services/bot/StatsService';
import { buildQuickChartUrl } from '../../utils/quickchart';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class TrackPlaysCommand extends BaseCommand {
    name = 'trackplays';
    description = 'View playcount over time for a track';
    aliases = ['tp'];

    slashData = new SlashCommandBuilder()
        .setName('trackplays')
        .setDescription('View playcount over time for a track')
        .addStringOption(opt => 
            opt.setName('track')
                .setDescription('The track name (leave blank for currently playing)')
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
        let trackQuery = '';
        let artistQuery = '';
        let grouping: 'year' | 'month' = 'month';
        let targetUserObj = null;

        if (isSlash) {
            trackQuery = interactionOrMessage.options.getString('track') || '';
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
                trackQuery = parts[0];
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
            if (!trackQuery) {
                if (!targetDbUser.lastfmUsername) {
                    throw new Error('No track provided, and Last.fm account not linked to check current track.');
                }
                const recent = await LastFM.getRecentTracks(targetDbUser.lastfmUsername, 1, targetDbUser.lastfmSessionKey);
                if (!recent || recent.length === 0) {
                    throw new Error('No track provided, and no recent track found to look up.');
                }
                trackQuery = recent[0].name;
                artistQuery = recent[0].artist?.['#text'] || recent[0].artist?.name;
            }

            if (!trackQuery) throw new Error('Could not resolve a track name.');

            // Fire & Forget background sync
            triggerDeltaSync(targetDbUser.discordId);

            const data = await StatsService.getPlaycountOverTime(targetDbUser.id, grouping, { track: trackQuery, artist: artistQuery || undefined });
            
            if (data.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no logged plays for **${trackQuery}**.`)
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

            const chartUrl = buildQuickChartUrl(`Plays for ${trackQuery}`, labels, values, userColorHex, 'bar');
            
            const totalPlays = values.reduce((a, b) => a + b, 0);

            const builder = new ComponentsV2()
                .setAccent(userColorInt)
                .addText(`## Playcount over time for ${trackQuery}\n${artistQuery ? `by **${artistQuery}**\n` : ''}**${userSettings.displayName}** has **${totalPlays.toLocaleString()}** total logged plays.`)
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
