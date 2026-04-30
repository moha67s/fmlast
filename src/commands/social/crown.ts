import {
  SettingService } from '../../services/bot/SettingService';
import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { CrownService } from '../../services/bot/CrownService';
import { LastFM } from '../../services/api/LastFM';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { TextChannel,
  ComponentType,
  ButtonStyle
} from "discord.js";

export default class CrownCommand extends BaseCommand {
    name = 'crown';
    description = 'View the crown status and history for a specific artist';
    aliases = ['cr'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('crown')
        .setDescription('View the crown status and history for a specific artist')
        .addStringOption((opt: any) => opt.setName('artist').setDescription('The artist to check').setRequired(true));

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const guildId = interactionOrMessage.guild?.id;
        if (!guildId) {
            const err = new ComponentsV2().setAccent(0xff0000).addText('❌ This command can only be used in a server.').build();
            if (isSlash) await interactionOrMessage.reply({ ...err, ephemeral: true });
            else await interactionOrMessage.channel.send(err);
            return;
        }

        let artistName = isSlash ? interactionOrMessage.options.getString('artist') : args?.join(' ');
        
        // Fallback to "np" artist if no name provided
        if (!artistName) {
            const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
            const user = await prisma.user.findUnique({ where: { discordId: authorId } });
            if (user?.lastfmUsername) {
                const tracks = await LastFM.getRecentTracks(user.lastfmUsername, 1, user.lastfmSessionKey);
                if (tracks.length > 0) artistName = tracks[0].artist?.['#text'] || tracks[0].artist?.name;
            }
        }

        if (!artistName) {
            const err = new ComponentsV2().setAccent(0xff0000).addText('❌ Please specify an artist name or be listening to one.').build();
            if (isSlash) await interactionOrMessage.reply({ ...err, ephemeral: true });
            else await interactionOrMessage.channel.send(err);
            return;
        }

        const crown = await CrownService.getArtistCrown(guildId, artistName);
        const history = await CrownService.getHistory(guildId, artistName);

        const builder = new ComponentsV2().setAccent(embedColor);
        
        if (!crown) {
            builder.addText(`### Crown for ${artistName}!\n❌ No one in this server has claimed the crown for **${artistName}** yet (20 plays required).`);
        } else {
            const holderName = crown.user.lastfmUsername || 'Unknown';
            const startUts = Math.floor(crown.claimedAt.getTime() / 1000);
            const nowUts = Math.floor(Date.now() / 1000);
            
            // Format: **<t:start:D>** to **<t:end:D>** — **[name](link)** — *plays to plays*
            const lfmLink = `https://last.fm/user/${holderName}/library/music/${encodeURIComponent(artistName)}`;
            const isMe = crown.user.discordId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
            const holderValue = `**<t:${startUts}:D>** to **<t:${nowUts}:D>** — **[${isMe ? 'you' : holderName}](${lfmLink})** — *${crown.initialPlaycount} to ${crown.playcount} plays*`;

            builder.addText(`### Crown for ${crown.artistName}!`);
            
            // Current Holder Field
            builder.addText(`**Current crown holder**\n${holderValue}`);

            // History Section
            if (history.length > 0) {
                const historyList = history.map(h => {
                    const hStart = Math.floor(h.claimedAt.getTime() / 1000);
                    const hEnd = Math.floor(h.lostAt.getTime() / 1000);
                    const hHolder = h.user.lastfmUsername || 'Unknown';
                    const hLink = `https://last.fm/user/${hHolder}/library/music/${encodeURIComponent(artistName)}`;
                    return `**<t:${hStart}:D>** to **<t:${hEnd}:D>** — **[${hHolder}](${hLink})** — *${h.playcountAtClaim} to ${h.playcountAtLoss} plays*`;
                }).join('\n');
                
                builder.addSeparator();
                builder.addText(`**History**\n${historyList}`);
            }

            // WhoKnows Button (Action Row)
            builder.addRow([{
                type: ComponentType.Button,
                style: ButtonStyle.Secondary,
                label: 'WhoKnows',
                emoji: { name: '📋' },
                custom_id: `wk_shortcut:${artistName}`
            }]);
        }

        const payload = builder.build();
        if (isSlash) await interactionOrMessage.reply(payload);
        else await interactionOrMessage.channel.send(payload);
    }
}
