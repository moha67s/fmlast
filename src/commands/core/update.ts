import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { triggerDeltaSync, fullQueue } from '../../services/bot/QueueWorker';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';
import { SlashCommandBuilder, TextChannel } from 'discord.js';

export default class UpdateCommand extends BaseCommand {
    name = 'update';
    description = 'Update your Last.fm index with your latest scrobbles';
    aliases = ['up', 'refresh', 'index'];

    slashData = new SlashCommandBuilder()
        .setName('update')
        .setDescription('Update your Last.fm index with your latest scrobbles');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        const embedColor = dbUser ? SettingService.resolveAccentColor(dbUser) : 0x8050ff;

        if (!dbUser?.lastfmUsername) {
            const payload = new ComponentsV2()
                .setAccent(0xff4444)
                .addText('❌ You are not linked to Last.fm yet. Use `/login` to connect your account.')
                .build();
            if (isSlash) await interactionOrMessage.reply({ ...payload, ephemeral: true });
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch {} }

        try {
            // Fetch Last.fm live data + local DB count in parallel
            const [lfmInfo, localCount] = await Promise.all([
                LastFM.getUserInfo(dbUser.lastfmUsername, dbUser.lastfmSessionKey),
                prisma.userPlay.count({ where: { userId: dbUser.id } })
            ]);

            const lfmTotal = parseInt(lfmInfo?.playcount || '0', 10);
            const gap = Math.max(0, lfmTotal - localCount);

            const settings = (dbUser.settings as any) || {};
            const lastSyncUts: number = settings.lastSyncTimestamp || 0;

            // Route to FULL_SYNC if gap is too large for a delta (> 1000 plays missing)
            // This mirrors FMBot's behaviour: big gaps → full reindex, small gaps → delta
            const needsFullSync = gap > 1000;

            if (needsFullSync) {
                await fullQueue.add(`full-${userId}`, { discordId: userId, type: 'FULL_SYNC' }, {
                    jobId: `full-${userId}`,
                    removeOnComplete: true,
                    removeOnFail: true
                });
            } else {
                await triggerDeltaSync(userId, true);
            }

            // Build response — mirrors FMBot's /update output
            const builder = new ComponentsV2().setAccent(embedColor);
            builder.addText(`### Last.fm Indexing Update for ${dbUser.lastfmUsername}`);

            builder.addText(
                `📊 **Last.fm:** ${lfmTotal.toLocaleString()} plays\n` +
                `💾 **Local DB:** ${localCount.toLocaleString()} plays`
            );

            if (gap > 0) {
                if (needsFullSync) {
                    builder.addText(`🔄 **Full re-index queued** — ${gap.toLocaleString()} missing plays will be imported. This may take a few minutes.`);
                } else {
                    builder.addText(`⏳ **${gap.toLocaleString()} play${gap === 1 ? '' : 's'}** will be indexed in the background.`);
                }
            } else {
                builder.addText(`✅ Your index is already **up to date!**`);
            }

            if (lastSyncUts > 0) {
                builder.addText(`-# Last synced <t:${lastSyncUts}:R>`);
            }

            builder.addSeparator();
            if (needsFullSync) {
                builder.addText(`-# ⚡ Full sync queued — wipe & re-import all plays.`);
            } else {
                builder.addText(`-# 🔄 Delta sync queued — your stats will update shortly.`);
            }

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            const errPayload = new ComponentsV2()
                .setAccent(0xff4444)
                .addText(`❌ **Update failed:** ${err.message || 'An unknown error occurred.'}`)
                .build();
            if (isSlash) await interactionOrMessage.editReply(errPayload);
            else await interactionOrMessage.channel.send(errPayload);
        }
    }
}
