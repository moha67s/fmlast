import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class ScrobbleCommand extends BaseCommand {
    name = 'scrobble';
    description = 'Manually scrobble a track to Last.fm';
    aliases = [];

    slashData = new SlashCommandBuilder()
        .setName('scrobble')
        .setDescription('Manually scrobble a track to Last.fm')
        .addStringOption(opt => 
            opt.setName('track')
                .setDescription('The track name to scrobble')
                .setRequired(true)
        )
        .addStringOption(opt => 
            opt.setName('artist')
                .setDescription('The artist name')
                .setRequired(true)
        )
        .addStringOption(opt => 
            opt.setName('album')
                .setDescription('The album name (optional)')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        let trackName = '';
        let artistName = '';
        let albumName = '';

        if (isSlash) {
            trackName = interactionOrMessage.options.getString('track') || '';
            artistName = interactionOrMessage.options.getString('artist') || '';
            albumName = interactionOrMessage.options.getString('album') || '';
        } else {
            if (!args || args.length === 0) {
                return interactionOrMessage.reply('❌ You must provide a track and artist. Example: `.scrobble track | artist [| album]`');
            }
            const input = args.join(' ');
            const parts = input.split('|').map(s => s.trim());
            if (parts.length < 2) {
                return interactionOrMessage.reply('❌ Please separate track and artist with a pipe (`|`). Example: `.scrobble Track Name | Artist Name | Optional Album`');
            }
            trackName = parts[0];
            artistName = parts[1];
            if (parts.length > 2) {
                albumName = parts[2];
            }
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbUser || !dbUser.lastfmSessionKey) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ You must be logged in to Last.fm to manually scrobble tracks. Use `/login`.').build();
            return isSlash ? interactionOrMessage.reply({ ...payload, ephemeral: true }) : interactionOrMessage.reply(payload);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            const extra: Record<string, string> = {};
            if (albumName) extra.album = albumName;
            
            // Use current timestamp
            const timestamp = Math.floor(Date.now() / 1000);
            
            await LastFM.scrobble(artistName, trackName, timestamp, dbUser.lastfmSessionKey, extra);
            const payload = new ComponentsV2()
                .setAccent(embedColor) // Greenish
                .addText(`✅ Successfully scrobbled **${trackName}** by **${artistName}**${albumName ? ` from *${albumName}*` : ''}!`)
                .build();
                
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to scrobble track: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
