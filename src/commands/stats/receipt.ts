import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, AttachmentBuilder, ChannelType, TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { LastFM } from '../../services/api/LastFM';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { config } from '../../../config';
import { resolveTargetUser } from '../../utils/userResolver';
import { SettingService } from '../../services/bot/SettingService';

export default class ReceiptCommand extends BaseCommand {
    name = 'receipt';
    description = 'Generate a shopping receipt of your top music';
    aliases = ['receipts'];

    slashData = new SlashCommandBuilder()
        .setName('receipt')
        .setDescription('Generate a shopping receipt of your top music')
        .addStringOption(opt => 
            opt.setName('type')
               .setDescription('What to show on the receipt')
               .addChoices(
                   { name: 'Top Tracks', value: 'tracks' },
                   { name: 'Top Artists', value: 'artists' }
               )
               .setRequired(false)
        )
        .addStringOption(opt => 
            opt.setName('period')
               .setDescription('Time period')
               .addChoices(
                   { name: 'Weekly', value: '7day' },
                   { name: 'Monthly', value: '1month' },
                   { name: 'Yearly', value: '12month' },
                   { name: 'All Time', value: 'overall' }
               )
               .setRequired(false)
        )
        .addUserOption(opt => 
            opt.setName('user')
               .setDescription('View receipt for another user')
               .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        let type = 'tracks';
        let period = '1month';

        if (isSlash) {
            type = interactionOrMessage.options.getString('type') || 'tracks';
            period = interactionOrMessage.options.getString('period') || '1month';
            await interactionOrMessage.deferReply();
        } else {
            try { await interactionOrMessage.channel.sendTyping(); } catch { }
            if (args && args.length > 0) {
                const joinedArgs = args.join(' ').toLowerCase();
                if (joinedArgs.includes('artist')) type = 'artists';
                
                if (joinedArgs.includes('overall') || joinedArgs.includes('all')) period = 'overall';
                else if (joinedArgs.includes('year') || joinedArgs.includes('12m')) period = '12month';
                else if (joinedArgs.includes('week') || joinedArgs.includes('7d')) period = '7day';
            }
        }

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        
        
        const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
        if (!dbUser || !dbUser.lastfmUsername) {
            const isSelf = targetUser.id === authorId;
            const msg = isSelf 
                ? '❌ You must link your Last.fm account first! Use `/login`.'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;
            return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
        }

        try {
            triggerDeltaSync(targetUser.id);

            let items: any[] = [];
            let totalScrobbles = 0;

            if (type === 'tracks') {
                const tracks = await LastFM.getTopTracks(dbUser.lastfmUsername, period, 10, dbUser.lastfmSessionKey);
                items = tracks.map((t: any, i: number) => ({
                    rank: i + 1,
                    name: `${t.name} - ${t.artist?.name || t.artist?.['#text']}`.substring(0, 30),
                    playcount: parseInt(t.playcount || '0')
                }));
            } else {
                const artists = await LastFM.getTopArtists(dbUser.lastfmUsername, period, 10, dbUser.lastfmSessionKey);
                items = artists.map((a: any, i: number) => ({
                    rank: i + 1,
                    name: (a.name || a['#text'] || 'Unknown Artist').substring(0, 30),
                    playcount: parseInt(a.playcount || '0')
                }));
            }

            if (items.length === 0) {
                const reply = `❌ No data found for ${targetUser.username} in this period.`;
                return isSlash ? interactionOrMessage.editReply(reply) : interactionOrMessage.reply(reply);
            }

            totalScrobbles = items.reduce((acc, val) => acc + val.playcount, 0);

            const periodMap: Record<string, string> = {
                '7day': 'WEEKLY',
                '1month': 'MONTHLY',
                '12month': 'YEARLY',
                'overall': 'ALL TIME'
            };

            const renderData = {
                username: dbUser.lastfmUsername.toUpperCase(),
                orderNumber: Math.floor(Math.random() * 9000) + 1000,
                date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).toUpperCase(),
                periodLabel: periodMap[period],
                typeLabel: type === 'tracks' ? 'TOP TRACKS' : 'TOP ARTISTS',
                items: items,
                totalScrobbles: totalScrobbles.toLocaleString()
            };

            const buffer = await PuppeteerService.render('receipt', renderData, { width: 400, height: 750 });

            // Upload to staging channel
            let cdnUrl: string | null = null;
            const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
            if (stagingChannelId && interactionOrMessage.client) {
                try {
                    const stagingChannel = await interactionOrMessage.client.channels.fetch(stagingChannelId) as TextChannel;
                    if (stagingChannel?.type === ChannelType.GuildText) {
                        const att = new AttachmentBuilder(buffer, { name: 'receipt.webp' });
                        const msg = await stagingChannel.send({ files: [att] });
                        cdnUrl = msg.attachments.first()?.url || null;
                    }
                } catch (e) {
                    console.warn('⚠️ Receipt staging failed:', e);
                }
            }

            const builder = new ComponentsV2().setAccent(embedColor);

            if (cdnUrl) {
                builder.setImage(cdnUrl);
                const payload = builder.build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.reply(payload);
            } else {
                const payload: any = builder.build();
                payload.files = [new AttachmentBuilder(buffer, { name: 'receipt.webp' })];
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.reply(payload);
            }

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to generate receipt: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);
        }
    }
}
