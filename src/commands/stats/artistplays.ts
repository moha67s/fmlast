import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { StatsService } from '../../services/bot/StatsService';
import { buildQuickChartUrl } from '../../utils/quickchart';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class ArtistPlaysCommand extends BaseCommand {
    name = 'artistplays';
    description = 'View playcount over time for an artist';
    aliases = ['ap'];

    slashData = new SlashCommandBuilder()
        .setName('artistplays')
        .setDescription('View playcount over time for an artist')
        .addStringOption(opt => 
            opt.setName('artist')
                .setDescription('The artist name (leave blank for currently playing)')
                .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('grouping')
                .setDescription('Group by month or year (default: year)')
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
        let artistQuery = '';
        let grouping: 'year' | 'month' = 'year';
        let targetUserObj = null;

        if (isSlash) {
            artistQuery = interactionOrMessage.options.getString('artist') || '';
            grouping = (interactionOrMessage.options.getString('grouping') as 'year' | 'month') || 'year';
            targetUserObj = interactionOrMessage.options.getUser('user');
        } else {
            if (args && args.length > 0) {
                // simple arg parsing
                const str = args.join(' ');
                if (str.toLowerCase().startsWith('month ')) {
                    grouping = 'month';
                    artistQuery = str.substring(6);
                } else if (str.toLowerCase().startsWith('year ')) {
                    grouping = 'year';
                    artistQuery = str.substring(5);
                } else {
                    artistQuery = str;
                }
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
            if (!artistQuery) {
                if (!targetDbUser.lastfmUsername) {
                    throw new Error('No artist provided, and Last.fm account not linked to check current track.');
                }
                const recent = await LastFM.getRecentTracks(targetDbUser.lastfmUsername, 1, targetDbUser.lastfmSessionKey);
                if (!recent || recent.length === 0) {
                    throw new Error('No artist provided, and no recent track found to look up.');
                }
                artistQuery = recent[0].artist?.['#text'] || recent[0].artist?.name;
            }

            if (!artistQuery) throw new Error('Could not resolve an artist name.');

            // Fire & Forget background sync
            triggerDeltaSync(targetDbUser.discordId);

            const data = await StatsService.getPlaycountOverTime(targetDbUser.id, grouping, { artist: artistQuery });
            
            if (data.length === 0) {
                const payload = new ComponentsV2()
                    .addText(`**${userSettings.displayName}** has no plays for **${artistQuery}**.`)
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

            const userColorHex = (userSettings.targetUser.settings as any)?.embedColor || '#1DB954';
            const userColorInt = parseInt(userColorHex.replace('#', ''), 16);

            const chartUrl = buildQuickChartUrl(`Plays for ${artistQuery}`, labels, values, userColorHex, 'bar');
            
            const totalPlays = values.reduce((a, b) => a + b, 0);

            const builder = new ComponentsV2()
                .setAccent(userColorInt)
                .addText(`## Playcount over time for ${artistQuery}\n**${userSettings.displayName}** has **${totalPlays.toLocaleString()}** total logged plays.`)
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
