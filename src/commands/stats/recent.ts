import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { LastfmHealthTracker } from '../../services/bot/LastfmHealthTracker';

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
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
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
            // 3. Fetch Data
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

            // 4. Build Embed
            const builder = new ComponentsV2().setAccent(0x5d010b);
            
            // Check health status (Phase 1 HealthTracker)
            const healthStatus = await LastfmHealthTracker.getStatusLine();
            if (healthStatus) builder.addText(healthStatus);

            const list = recent.tracks.slice(0, amount).map((t: any) => {
                const artist = t.artist?.['#text'] || t.artist?.name || 'Unknown';
                const track = t.name || 'Unknown';
                const album = t.album?.['#text'] || '';
                const uts = t.date?.uts;
                
                let timeStr = t['@attr']?.nowplaying === 'true' ? ' **(Now Playing)**' : (uts ? ` • <t:${uts}:R>` : '');
                
                const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
                const trackUrl = `${artistUrl}/_/${encodeURIComponent(track)}`;
                
                return `**[${track}](${trackUrl})** by **[${artist}](${artistUrl})**${album ? ` from *${album}*` : ''}${timeStr}`;
            }).join('\n');

            builder.addText(`### Recent Tracks for ${userSettings.displayName}\n${list}`);
            
            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch recent tracks from Last.fm.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
