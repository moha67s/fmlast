import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder } from 'discord.js';

export default class SkipCommand extends BaseCommand {
    name = 'skip';
    description = 'Skip the current track';
    aliases = ['s', 'next'];

    slashData = new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Skip the current track');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const guildId = interactionOrMessage.guildId!;
        const success = MusicPlayer.skip(guildId);

        const msg = success ? '⏭️ Skipped current track.' : '⚠️ Nothing is playing!';
        
        if (isSlash) await interactionOrMessage.reply({ content: msg });
        else await interactionOrMessage.reply(msg);
    }
}
