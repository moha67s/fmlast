import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class LovedCommand extends BaseCommand {
    name = 'loved';
    description = 'View loved tracks for a user';
    aliases = ['lovedtracks'];

    slashData = new SlashCommandBuilder()
        .setName('loved')
        .setDescription('View loved tracks for a user')
        .addStringOption(opt => 
            opt.setName('query')
                .setDescription('User mention or username')
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

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            const data = await LastFM.getLovedTracks(targetDbUser.lastfmUsername, 10, 1, targetDbUser.lastfmSessionKey);
            
            if (!data.tracks || data.tracks.length === 0) {
                const payload = new ComponentsV2().addText(`**${userSettings.displayName}** has no loved tracks.`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            const builder = new ComponentsV2().setAccent(embedColor); // Last.fm Red
            
            const total = data.meta?.total || data.tracks.length;
            builder.addText(`### ❤️ Loved Tracks for ${userSettings.displayName}`);
            
            const list = data.tracks.map((t: any) => {
                const artist = t.artist?.name || t.artist?.['#text'] || 'Unknown';
                const track = t.name || 'Unknown';
                const uts = t.date?.uts;
                
                let timeStr = uts ? ` • <t:${uts}:R>` : '';
                
                const artistUrl = `https://www.last.fm/music/${encodeURIComponent(artist)}`;
                const trackUrl = `${artistUrl}/_/${encodeURIComponent(track)}`;
                
                return `**[${track}](${trackUrl})** by **[${artist}](${artistUrl})**${timeStr}`;
            }).join('\n');

            builder.addText(list);
            builder.addText(`-# Total loved tracks: **${total}**`);
            
            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to fetch loved tracks: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
