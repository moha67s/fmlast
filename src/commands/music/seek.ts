import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder, TextChannel } from 'discord.js';

export default class SeekCommand extends BaseCommand {
    name = 'seek';
    description = 'Jump to a specific time in the current track';
    aliases = ['jump'];

    slashData = new SlashCommandBuilder()
        .setName('seek')
        .setDescription('Jump to a specific time in the current track')
        .addStringOption(option => 
            option.setName('time')
                .setDescription('The time to jump to (e.g. 1:30 or 90)')
                .setRequired(true)
        );

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const guildId = interactionOrMessage.guildId!;
        
        let timeStr: string;
        if (isSlash) {
            timeStr = interactionOrMessage.options.getString('time', true);
        } else {
            if (args.length === 0) {
                await interactionOrMessage.reply('❌ Please provide a time to seek to (e.g. `1:30` or `90` seconds).');
                return;
            }
            timeStr = args[0];
        }

        const ms = this.parseTimeToMs(timeStr);
        if (ms === null) {
            await interactionOrMessage.reply('❌ Invalid time format. Use seconds (e.g. `90`) or `mm:ss` (e.g. `1:30`).');
            return;
        }

        try {
            await MusicPlayer.seek(guildId, ms);
            await interactionOrMessage.reply(`⏩ Seeked to **${timeStr}**.`);
        } catch (err: any) {
            console.error('[SeekCommand] Error:', err);
            await interactionOrMessage.reply(`⚠️ Error seeking: ${err.message || 'Unknown error'}`);
        }
    }

    private parseTimeToMs(time: string): number | null {
        if (!time) return null;
        
        // Handle mm:ss or hh:mm:ss
        if (time.includes(':')) {
            const parts = time.split(':').reverse();
            let seconds = 0;
            if (parts[0]) seconds += parseInt(parts[0]);
            if (parts[1]) seconds += parseInt(parts[1]) * 60;
            if (parts[2]) seconds += parseInt(parts[2]) * 3600;
            
            if (isNaN(seconds)) return null;
            return seconds * 1000;
        }
        
        // Handle raw seconds
        const seconds = parseInt(time);
        if (isNaN(seconds)) return null;
        return seconds * 1000;
    }
}
