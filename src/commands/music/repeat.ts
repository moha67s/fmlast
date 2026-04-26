import { BaseCommand } from '../../structures/BaseCommand';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder, ChatInputCommandInteraction, Message } from 'discord.js';
import { QueueManager, RepeatMode } from '../../services/music/QueueManager';

export default class RepeatCommand extends BaseCommand {
    name = 'repeat';
    description = 'Toggle repeat mode (Off, One, All)';
    aliases = ['loop', 'rp'];

    slashData = new SlashCommandBuilder()
        .setName('repeat')
        .setDescription('Toggle repeat mode')
        .addStringOption(option =>
            option.setName('mode')
                .setDescription('Repeat mode')
                .addChoices(
                    { name: 'Off', value: 'off' },
                    { name: 'One', value: 'one' },
                    { name: 'All', value: 'all' }
                ));

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const guildId = interactionOrMessage.guildId;
        if (!guildId) return;

        const queue = QueueManager.getQueue(guildId);
        if (!queue) {
            const builder = new ComponentsV2().addText('❌ No active music queue found.');
            if (isSlash) await interactionOrMessage.reply({ ...builder.build(), ephemeral: true });
            else await interactionOrMessage.reply(builder.build());
            return;
        }

        let newMode: RepeatMode;

        if (isSlash) {
            const modeArg = interactionOrMessage.options.getString('mode');
            if (modeArg) {
                newMode = modeArg as RepeatMode;
            } else {
                // Cycle
                if (queue.repeatMode === 'off') newMode = 'one';
                else if (queue.repeatMode === 'one') newMode = 'all';
                else newMode = 'off';
            }
        } else {
            // Cycle
            if (queue.repeatMode === 'off') newMode = 'one';
            else if (queue.repeatMode === 'one') newMode = 'all';
            else newMode = 'off';
        }

        QueueManager.setRepeatMode(guildId, newMode);

        let statusText = '';
        if (newMode === 'off') statusText = 'Repeat is now **Off**.';
        else if (newMode === 'one') statusText = 'Repeat mode set to **🔂 Single Track**.';
        else if (newMode === 'all') statusText = 'Repeat mode set to **🔁 All Tracks**.';

        const builder = new ComponentsV2().addText(`✅ ${statusText}`);
        await interactionOrMessage.reply(builder.build());
    }
}
