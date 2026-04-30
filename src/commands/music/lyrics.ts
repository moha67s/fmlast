import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder, TextChannel, EmbedBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class LyricsCommand extends BaseCommand {
    name = 'lyrics';
    description = 'Get lyrics for the currently playing track';
    aliases = ['ly', 'l'];

    slashData = new SlashCommandBuilder()
        .setName('lyrics')
        .setDescription('Get lyrics for the currently playing track');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {

        const guildId = interactionOrMessage.guildId!;
        const textChannel = interactionOrMessage.channel as TextChannel;

        if (!isSlash) await textChannel.sendTyping();
        else if (!interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        try {
            const data = await MusicPlayer.getLyrics(guildId);

            if (!data) {
                const msg = '❌ No lyrics found for the current track or no track is playing.';
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // data.lines = [{timestamp, line}, ...] for synced lyrics
            // data.text = plain string for unsynced
            
            const builder = new ComponentsV2()
                .setAccent(0x5865F2);

            if (data.lines && data.lines.length > 0) {
                // Synced lyrics
                const lyricsText = data.lines.map((l: any) => l.line).join('\n');
                
                // Truncate if too long (Discord embed limit is 4096 for description)
                const truncatedText = lyricsText.length > 4000 ? lyricsText.substring(0, 3997) + '...' : lyricsText;
                
                builder.addText(`### 🎤 Synced Lyrics\n${truncatedText}`);
            } else if (data.text) {
                // Unsynced lyrics
                const truncatedText = data.text.length > 4000 ? data.text.substring(0, 3997) + '...' : data.text;
                builder.addText(`### 🎤 Lyrics\n${truncatedText}`);
            } else {
                const msg = '❌ Lyrics are available but empty.';
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);

        } catch (err: any) {
            console.error('[LyricsCommand] Error:', err);
            const msg = `⚠️ Error fetching lyrics: ${err.message || 'Unknown error'}`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
        }
    }
}
