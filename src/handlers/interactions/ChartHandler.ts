import { Interaction, Client, ComponentType, ButtonStyle, TextInputStyle, ButtonInteraction } from 'discord.js';
import { BaseInteractionHandler } from './BaseInteractionHandler';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import ChartCommand from '../../commands/stats/chart';
import { prisma } from '../../database/client';
import { LoggerService } from '../../services/bot/LoggerService';
import { ChartState, ChartEditState } from '../../utils/ChartState';


export class ChartHandler extends BaseInteractionHandler {
    
    canHandle(customId: string): boolean {
        return customId.startsWith('cp:') || 
               customId.startsWith('ct-') || 
               customId.startsWith('cm:') || 
               customId.startsWith('cms:') || 
               customId.startsWith('cs:') ||
               customId.startsWith('chart-edit:');
    }

    async handle(interaction: Interaction, client: Client): Promise<void> {
        if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;

        try {
            if (interaction.isStringSelectMenu() && interaction.customId.startsWith('cp:')) {
                const stateStr = interaction.customId.substring(3);
                const period = interaction.values[0];
                const state = ChartState.decodeNoPeriod(stateStr, period);
                if (interaction.user.id !== state.userId) return;
                await interaction.update(this.buildSettingsMessage(state));
                return;
            }

            if (interaction.isButton() && interaction.customId.startsWith('ct-')) {
                const colonIndex = interaction.customId.indexOf(':', 3);
                const optionKey = interaction.customId.substring(3, colonIndex);
                const state = ChartState.decode(interaction.customId.substring(colonIndex + 1));
                if (interaction.user.id !== state.userId) return;

                if (optionKey === 'si') state.skipNoImage = !state.skipNoImage;
                else if (optionKey === 'sfw') state.sfwOnly = !state.sfwOnly;
                else if (optionKey === 'hs') state.hideSingles = !state.hideSingles;

                await interaction.update(this.buildSettingsMessage(state));
                return;
            }

            if (interaction.isButton() && (interaction.customId.startsWith('cm:') || interaction.customId.startsWith('chart-edit:'))) {
                const prefix = interaction.customId.startsWith('cm:') ? 'cm:' : 'chart-edit:';
                const state = ChartState.decode(interaction.customId.substring(prefix.length));
                if (interaction.user.id !== state.userId) return;

                const modal = {
                    title: 'Edit Grid',
                    custom_id: `cms:${interaction.customId.substring(prefix.length)}`,
                    components: [
                        { 
                            type: ComponentType.ActionRow, 
                            components: [{ 
                                type: ComponentType.TextInput, 
                                custom_id: 'size', 
                                label: 'Grid Size', 
                                style: TextInputStyle.Short, 
                                value: `${state.size}x${state.size}` 
                            }] 
                        },
                        { 
                            type: ComponentType.ActionRow, 
                            components: [{ 
                                type: ComponentType.TextInput, 
                                custom_id: 'release_filter', 
                                label: 'Release filter', 
                                style: TextInputStyle.Short, 
                                value: state.releaseFilter, 
                                required: false 
                            }] 
                        }
                    ]
                };
                await (interaction as ButtonInteraction).showModal(modal as any);
                return;
            }

            if (interaction.isModalSubmit() && interaction.customId.startsWith('cms:')) {
                const state = ChartState.decode(interaction.customId.substring(4));
                const sizeMatch = interaction.fields.getTextInputValue('size').match(/(\d+)/);
                state.size = sizeMatch ? Math.min(Math.max(parseInt(sizeMatch[1]), 1), 9) : 3;
                state.releaseFilter = interaction.fields.getTextInputValue('release_filter')?.trim() || '';
                await (interaction as any).update(this.buildSettingsMessage(state));
                return;
            }

            if (interaction.isButton() && interaction.customId.startsWith('cs:')) {
                const state = ChartState.decode(interaction.customId.substring(3));
                if (interaction.user.id !== state.userId) return;

                await interaction.update({ content: '⏳ Generating...', components: [] });
                
                const dbUser = await prisma.user.findUnique({ where: { discordId: state.userId } });
                if (!dbUser?.lastfmSessionKey) throw new Error('Not linked.');
                
                const payload = await ChartCommand.createChartPayload(
                    dbUser.id, 
                    state.userId, 
                    dbUser.lastfmUsername!, 
                    dbUser.lastfmSessionKey, 
                    state.size, 
                    state.period, 
                    client, 
                    {
                        skipNoImage: state.skipNoImage, 
                        sfwOnly: state.sfwOnly, 
                        hideSingles: state.hideSingles, 
                        releaseFilter: state.releaseFilter
                    }
                );
                await interaction.followUp(payload);
                return;
            }
        } catch (err) {
            LoggerService.error('ChartHandler Error', err, 'ChartHandler');
            throw err; // Let the dispatcher/main handler catch it for trace reporting
        }
    }

    private buildSettingsMessage(state: ChartEditState): any {
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth();
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

        const periodOptions = [
            { label: 'Day', value: 'daily', default: false },
            { label: 'Week', value: 'weekly', default: false },
            { label: 'Month', value: 'monthly', default: false },
            { label: 'Year', value: 'yearly', default: false },
            { label: 'Overall', value: 'overall', default: false },
        ];

        for (let i = 2; i >= 1; i--) {
            let m = currentMonth - i;
            let y = currentYear;
            if (m < 0) { m += 12; y--; }
            periodOptions.push({
                label: `${monthNames[m]} ${y}`,
                value: `month-${y}-${String(m + 1).padStart(2, '0')}`,
                default: false
            });
        }

        periodOptions.push(
            { label: String(currentYear), value: `year-${currentYear}`, default: false },
            { label: String(currentYear - 1), value: `year-${currentYear - 1}`, default: false }
        );

        periodOptions.forEach(opt => { opt.default = opt.value === state.period; });
        if (!periodOptions.some(opt => opt.default)) {
            const weekOpt = periodOptions.find(opt => opt.value === 'weekly');
            if (weekOpt) weekOpt.default = true;
        }

        const stateStr = ChartState.encode(state);
        const stateStrNP = ChartState.encodeNoPeriod(state);
        const periodInfo = ChartCommand.getPeriodInfoStatic(state.period);
        const filterLabel = state.releaseFilter || 'any';

        const activeOpts: string[] = [];
        if (state.skipNoImage) activeOpts.push('Skip No Image');
        if (state.sfwOnly) activeOpts.push('SFW Only');
        if (state.hideSingles) activeOpts.push('Hide Singles');
        const optsText = activeOpts.length > 0 ? activeOpts.join(', ') : 'none';

        return {
            content: [
                `📊 **Edit Chart Settings**`,
                `Size: **${state.size}x${state.size}** · Period: **${periodInfo.display}** · Release: **${filterLabel}**`,
                `Options: ${optsText}`,
            ].join('\n'),
            components: [
                {
                    type: ComponentType.ActionRow,
                    components: [{
                        type: ComponentType.StringSelect,
                        custom_id: `cp:${stateStrNP}`,
                        placeholder: 'Select time period',
                        options: periodOptions
                    }]
                },
                {
                    type: ComponentType.ActionRow,
                    components: [
                        {
                            type: ComponentType.Button,
                            custom_id: `ct-si:${stateStr}`,
                            style: state.skipNoImage ? ButtonStyle.Success : ButtonStyle.Secondary,
                            label: 'Skip No Image',
                        },
                        {
                            type: ComponentType.Button,
                            custom_id: `ct-sfw:${stateStr}`,
                            style: state.sfwOnly ? ButtonStyle.Success : ButtonStyle.Secondary,
                            label: 'SFW Only',
                        },
                        {
                            type: ComponentType.Button,
                            custom_id: `ct-hs:${stateStr}`,
                            style: state.hideSingles ? ButtonStyle.Success : ButtonStyle.Secondary,
                            label: 'Hide Singles',
                        }
                    ]
                },
                {
                    type: ComponentType.ActionRow,
                    components: [
                        {
                            type: ComponentType.Button,
                            custom_id: `cm:${stateStr}`,
                            style: ButtonStyle.Secondary,
                            label: '📐 Size & Filter'
                        },
                        {
                            type: ComponentType.Button,
                            custom_id: `cs:${stateStr}`,
                            style: ButtonStyle.Primary,
                            label: '✅ Generate Chart'
                        }
                    ]
                }
            ],
            ephemeral: true
        };
    }

}
