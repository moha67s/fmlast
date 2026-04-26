import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder, TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class VolumeCommand extends BaseCommand {
    name = 'volume';
    description = 'Set the player volume (0-1000)';
    aliases = ['v', 'vol'];

    slashData = new SlashCommandBuilder()
        .setName('volume')
        .setDescription('Set the player volume (0-1000)')
        .addIntegerOption(option => 
            option.setName('level')
                .setDescription('The volume level (0-1000)')
                .setRequired(true)
                .setMinValue(0)
                .setMaxValue(1000)
        );

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const guildId = interactionOrMessage.guildId!;
        const textChannel = interactionOrMessage.channel as TextChannel;

        let level: number;
        if (isSlash) {
            level = interactionOrMessage.options.getInteger('level', true);
        } else {
            if (args.length === 0) {
                const msg = '❌ Please provide a volume level (0-1000).';
                await interactionOrMessage.reply(msg);
                return;
            }
            level = parseInt(args[0]);
            if (isNaN(level) || level < 0 || level > 1000) {
                const msg = '❌ Volume level must be a number between 0 and 1000.';
                await interactionOrMessage.reply(msg);
                return;
            }
        }

        try {
            await MusicPlayer.setVolume(guildId, level);
            const msg = `🔊 Volume set to **${level}**.`;
            if (isSlash) await interactionOrMessage.reply(msg);
            else await interactionOrMessage.reply(msg);
        } catch (err: any) {
            console.error('[VolumeCommand] Error:', err);
            const msg = `⚠️ Error setting volume: ${err.message || 'Unknown error'}`;
            if (isSlash) await interactionOrMessage.reply({ content: msg, ephemeral: true });
            else await interactionOrMessage.reply(msg);
        }
    }
}
