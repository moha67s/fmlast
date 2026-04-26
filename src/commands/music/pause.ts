import { BaseCommand } from '../../structures/BaseCommand';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder, ChatInputCommandInteraction, Message } from 'discord.js';
import { MusicPlayer } from '../../services/music/MusicPlayer';

export default class PauseCommand extends BaseCommand {
    name = 'pause';
    description = 'Pause the current music playback';

    slashData = new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pause the current music playback');

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const guildId = interactionOrMessage.guildId;
        if (!guildId) return;

        const success = MusicPlayer.pause(guildId);
        const builder = new ComponentsV2().addText(success ? '⏸️ Playback paused.' : '❌ Nothing is playing or it is already paused.');
        
        if (isSlash) await interactionOrMessage.reply(builder.build());
        else await interactionOrMessage.reply(builder.build());
    }
}
