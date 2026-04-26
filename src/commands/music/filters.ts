import { BaseCommand } from '../../structures/BaseCommand';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { SlashCommandBuilder, TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class FiltersCommand extends BaseCommand {
    name = 'filters';
    description = 'Apply audio filters to the current track';
    aliases = ['f', 'fx'];

    slashData = new SlashCommandBuilder()
        .setName('filters')
        .setDescription('Apply audio filters to the current track')
        .addStringOption(option => 
            option.setName('type')
                .setDescription('The filter type to apply')
                .setRequired(false)
                .addChoices(
                    { name: 'Reset (Clear all)', value: 'reset' },
                    { name: 'Bass Boost', value: 'bassboost' },
                    { name: 'Nightcore', value: 'nightcore' },
                    { name: 'Vaporwave', value: 'vaporwave' },
                    { name: 'Daycore', value: 'daycore' },
                    { name: 'Tremolo', value: 'tremolo' },
                    { name: 'Vibrato', value: 'vibrato' },
                    { name: 'Distortion', value: 'distortion' },
                    { name: '8D Audio', value: '8d' }
                )
        );

    static FILTER_MAP: Record<string, any> = {
        'reset': {},
        'bassboost': { equalizers: Array(6).fill(0).map((_, i) => ({ band: i, gain: 0.2 })) },
        'nightcore': { timescale: { speed: 1.2, pitch: 1.2, rate: 1.0 } },
        'vaporwave': { timescale: { speed: 0.85, pitch: 0.8 } },
        'daycore': { timescale: { speed: 0.85, pitch: 0.8, rate: 1.0 }, equalizers: [{ band: 0, gain: 0.3 }, { band: 1, gain: 0.2 }] },
        'tremolo': { tremolo: { frequency: 4.0, depth: 0.5 } },
        'vibrato': { vibrato: { frequency: 4.0, depth: 0.5 } },
        'distortion': { distortion: { sinOffset: 0.0, sinScale: 1.0, cosOffset: 0.0, cosScale: 1.0, tanOffset: 0.0, tanScale: 1.0, offset: 0.0, scale: 1.0 } },
        '8d': { channelMix: { leftToLeft: 0.5, leftToRight: 0.5, rightToLeft: 0.5, rightToRight: 0.5 } },
        'pop': { equalizers: [{ band: 0, gain: 0.65 }, { band: 1, gain: 0.45 }, { band: 2, gain: -0.45 }, { band: 3, gain: -0.65 }, { band: 4, gain: 0.35 }] },
        'treble': { equalizers: [{ band: 0, gain: -0.2 }, { band: 1, gain: -0.1 }, { band: 2, gain: 0.1 }, { band: 3, gain: 0.3 }, { band: 4, gain: 0.5 }] },
    };

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const guildId = interactionOrMessage.guildId!;
        
        let type: string | null = null;
        if (isSlash) {
            type = interactionOrMessage.options.getString('type');
        } else {
            type = args[0]?.toLowerCase() || null;
        }

        if (!type) {
            // Show menu
            const builder = new ComponentsV2()
                .setAccent(0x1DB954)
                .addText(`### 🎛️ Audio Filters\nSelect a filter from the menu below to apply it to the current track.`)
                .addRow([{
                    type: 3,
                    custom_id: `mp-filter-select:${guildId}`,
                    placeholder: 'Choose a filter...',
                    options: [
                        { label: 'Reset (Clear all)', value: 'reset', emoji: '❌', description: 'Clear all active filters' },
                        { label: 'Bass Boost', value: 'bassboost', emoji: '🔊', description: 'Boost the bass frequencies' },
                        { label: 'Nightcore', value: 'nightcore', emoji: '⚡', description: 'High speed and high pitch effect' },
                        { label: 'Vaporwave', value: 'vaporwave', emoji: '🌊', description: 'Slow and retro aesthetic' },
                        { label: 'Daycore', value: 'daycore', emoji: '🕰️', description: 'Slowed and slightly bass boosted' },
                        { label: 'Tremolo', value: 'tremolo', emoji: '📳', description: 'Wavy volume effect' },
                        { label: 'Vibrato', value: 'vibrato', emoji: '〰️', description: 'Wavy pitch effect' },
                        { label: 'Distortion', value: 'distortion', emoji: '💢', description: 'Aggressive distorted sound' },
                        { label: '8D Audio', value: '8d', emoji: '🎧', description: '360 degree rotating sound' },
                    ]
                }]);
            
            await interactionOrMessage.reply(builder.build());
            return;
        }

        const filters = FiltersCommand.FILTER_MAP[type === 'reset' ? 'reset' : type];
        if (filters === undefined) {
            await interactionOrMessage.reply(`❌ Unknown filter type: \`${type}\`.`);
            return;
        }

        try {
            await MusicPlayer.setFilters(guildId, filters);
            const msg = type === 'reset' ? '✅ **Filters cleared.**' : `✅ **${type}** filter applied.`;
            const builder = new ComponentsV2().addText(msg).build();
            await interactionOrMessage.reply(builder);
        } catch (err: any) {
            console.error('[FiltersCommand] Error:', err);
            const errorBuilder = new ComponentsV2().addText(`⚠️ Error applying filters: ${err.message || 'Unknown error'}`).build();
            await interactionOrMessage.reply(errorBuilder);
        }
    }
}
