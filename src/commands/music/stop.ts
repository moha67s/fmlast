import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder } from 'discord.js';

export default class StopCommand extends BaseCommand {
    name = 'stop';
    description = 'Stop music and leave the voice channel';
    aliases = ['leave', 'dc', 'disconnect'];

    slashData = new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop music and leave the voice channel');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const guildId = interactionOrMessage.guildId!;
        const success = MusicPlayer.stop(guildId);

        const msg = success ? '🛑 Music stopped and disconnected.' : '⚠️ I am not playing anything!';
        
        if (isSlash) await interactionOrMessage.reply({ content: msg });
        else await interactionOrMessage.reply(msg);
    }
}
