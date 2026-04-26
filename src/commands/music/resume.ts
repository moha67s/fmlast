import { BaseCommand } from '../../structures/BaseCommand';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder, ChatInputCommandInteraction, Message } from 'discord.js';
import { MusicPlayer } from '../../services/music/MusicPlayer';

export default class ResumeCommand extends BaseCommand {
    name = 'resume';
    description = 'Resume the paused music playback';

    slashData = new SlashCommandBuilder()
        .setName('resume')
        .setDescription('Resume the paused music playback');

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const guildId = interactionOrMessage.guildId;
        if (!guildId) return;

        const success = MusicPlayer.resume(guildId);
        const builder = new ComponentsV2().addText(success ? '▶️ Playback resumed.' : '❌ Nothing is paused or currently playing.');
        
        if (isSlash) await interactionOrMessage.reply(builder.build());
        else await interactionOrMessage.reply(builder.build());
    }
}
