import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { TextChannel } from 'discord.js';

export default class UpdateCommand extends BaseCommand {
    name = 'update';
    description = 'Force a sync and heal database playcount gaps';
    aliases = ['up', 'refresh', 'heal'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('update')
        .setDescription('Force a sync and heal database playcount gaps');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {

        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        if (!dbUser?.lastfmUsername) {
            const payload = new ComponentsV2()
                .setAccent(0xff0000)
                .addText('❌ You are not linked to Last.fm yet.')
                .build();
            if (isSlash) await interactionOrMessage.reply({ ...payload, ephemeral: true });
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        // 1. Initial response
        const builder = new ComponentsV2().setAccent(0x8050ff);
        builder.addText(`🔄 **Syncing & Healing Database...**\nFetching your latest music and correcting playcount gaps.`);
        
        const responseMsg = isSlash 
            ? await interactionOrMessage.reply({ ...builder.build(), fetchReply: true })
            : await interactionOrMessage.channel.send(builder.build());

        try {
            // 2. Trigger Delta Sync (forced)
            await triggerDeltaSync(userId, true);

            // 3. Perform Healing (Artist & Track Reconciliation)
            console.log(`[update] Healing ${dbUser.lastfmUsername}...`);
            
            // A. Top Artists (Overall)
            const topArtists = await LastFM.getTopArtists(dbUser.lastfmUsername, 'overall', 100, dbUser.lastfmSessionKey);
            if (topArtists.length > 0) {
                await prisma.$transaction(async (tx) => {
                    for (const a of topArtists) {
                        await tx.userArtist.upsert({
                            where: { userId_artistName: { userId: dbUser.id, artistName: a.name } },
                            update: { playcount: parseInt(a.playcount) },
                            create: { userId: dbUser.id, artistName: a.name, playcount: parseInt(a.playcount) }
                        });
                    }
                }, { maxWait: 20000, timeout: 60000 });
            }

            // B. Top Tracks (Overall)
            const topTracks = await LastFM.getTopTracks(dbUser.lastfmUsername, 'overall', 100, dbUser.lastfmSessionKey);
            if (topTracks.length > 0) {
                await prisma.$transaction(async (tx) => {
                    for (const t of topTracks) {
                        await tx.userTrack.upsert({
                            where: { userId_artistName_trackName: { 
                                userId: dbUser.id, 
                                artistName: t.artist?.name || t.artist?.['#text'], 
                                trackName: t.name 
                            } },
                            update: { playcount: parseInt(t.playcount) },
                            create: { 
                                userId: dbUser.id, 
                                artistName: t.artist?.name || t.artist?.['#text'], 
                                trackName: t.name, 
                                playcount: parseInt(t.playcount) 
                            }
                        });
                    }
                }, { maxWait: 20000, timeout: 60000 });
            }

            // 4. Update Success
            const successBuilder = new ComponentsV2().setAccent(0x8050ff);
            successBuilder.addText(`✅ **Sync & Healing Complete**\n\n- Triggered background indexing for the last 24h.\n- Reconciled **${topArtists.length}** artists and **${topTracks.length}** tracks.\n- Playcount gaps for your top music have been repaired.`);
            
            if (isSlash) await interactionOrMessage.editReply(successBuilder.build());
            else await responseMsg.edit(successBuilder.build());

        } catch (err: any) {
            console.error('[update] Error:', err);
            const errBuilder = new ComponentsV2().setAccent(0xff0000);
            errBuilder.addText(`❌ **Healing Failed**\n${err.message || 'An unknown error occurred during sync.'}`);
            
            if (isSlash) await interactionOrMessage.editReply(errBuilder.build());
            else await responseMsg.edit(errBuilder.build());
        }
    }
}
