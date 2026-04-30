import { Interaction, Client, ComponentType, ButtonStyle } from 'discord.js';
import { BaseInteractionHandler } from './BaseInteractionHandler';
import { prisma } from '../../database/client';
import { LoggerService } from '../../services/bot/LoggerService';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export class SettingsHandler extends BaseInteractionHandler {
    
    canHandle(customId: string): boolean {
        return customId === 'user-setting-picker' || 
               customId === 'us-back-settings' || 
               customId === 'user-setting-botscrobbling-manage' || 
               customId.startsWith('us-toggle-scrobbling:') ||
               customId === 'us-view-HistoryImport-refresh' ||
               customId.startsWith('us-import-cancel:');
    }

    async handle(interaction: Interaction, client: Client): Promise<void> {
        if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;

        try {
            if (interaction.isStringSelectMenu() && interaction.customId === 'user-setting-picker') {
                const selected = interaction.values[0];
                const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
                if (!dbUser) return;
                const settings = (dbUser.settings as any) || {};

                if (selected === 'us-view-BotScrobbling') {
                    const isEnabled = settings.scrobbling !== false;
                    const builder = new ComponentsV2()
                        .addText(`## 🤖 Music bot scrobbling`)
                        .addSeparator()
                        .addText(`When enabled, the bot will automatically scrobble tracks played by other music bots in your voice channel.`)
                        .addText(`Current status: **${isEnabled ? 'Enabled' : 'Disabled'}**`)
                        .addRow([
                            { 
                                type: ComponentType.Button, 
                                custom_id: `us-toggle-scrobbling:${!isEnabled}`, 
                                label: isEnabled ? 'Disable Scrobbling' : 'Enable Scrobbling', 
                                style: isEnabled ? 4 : 3 
                            },
                            { type: ComponentType.Button, custom_id: 'us-back-settings', label: 'Back', style: ButtonStyle.Secondary }
                        ]);
                    await interaction.update(builder.build());
                } else if (selected === 'us-view-HistoryImport') {
                    await this.renderHistoryImport(interaction, dbUser);
                } else {
                    await interaction.reply({ content: `The **${selected.replace('us-view-', '')}** module is coming soon!`, ephemeral: true });
                }
                return;
            }

            if (interaction.isButton()) {
                if (interaction.customId === 'us-back-settings') {
                    const SettingsCmd = (await import('../../commands/core/settings')).default;
                    const cmd = new SettingsCmd();
                    await (cmd as any).execute(interaction, true);
                    return;
                }

                if (interaction.customId === 'user-setting-botscrobbling-manage') {
                    const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
                    if (!dbUser) return;
                    const settings = (dbUser.settings as any) || {};
                    const isEnabled = settings.scrobbling !== false;
                    const builder = new ComponentsV2()
                        .addText(`## 🤖 Music bot scrobbling`)
                        .addSeparator()
                        .addText(`Current status: **${isEnabled ? 'Enabled' : 'Disabled'}**`)
                        .addRow([
                            { type: ComponentType.Button, custom_id: `us-toggle-scrobbling:${!isEnabled}`, label: isEnabled ? 'Disable Scrobbling' : 'Enable Scrobbling', style: isEnabled ? 4 : 3 }
                        ]);
                    await interaction.reply({ ...builder.build(), ephemeral: true });
                    return;
                }

                if (interaction.customId.startsWith('us-toggle-scrobbling:')) {
                    const newVal = interaction.customId.split(':')[1] === 'true';
                    const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
                    if (!dbUser) return;
                    const settings = (dbUser.settings as any) || {};
                    settings.scrobbling = newVal;
                    await prisma.user.update({ where: { discordId: interaction.user.id }, data: { settings } });
                    const builder = new ComponentsV2()
                        .addText(`## 🤖 Music bot scrobbling`)
                        .addSeparator()
                        .addText(`✅ Successfully **${newVal ? 'Enabled' : 'Disabled'}** scrobbling.`)
                        .addRow([
                            { type: ComponentType.Button, custom_id: `us-toggle-scrobbling:${!newVal}`, label: newVal ? 'Disable Scrobbling' : 'Enable Scrobbling', style: newVal ? 4 : 3 },
                            { type: ComponentType.Button, custom_id: 'us-back-settings', label: 'Back', style: ButtonStyle.Secondary }
                        ]);
                    await interaction.update(builder.build());
                    return;
                }

                if (interaction.customId.startsWith('us-import-cancel:') || interaction.customId === 'us-view-HistoryImport-refresh') {
                    const jobId = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
                    if (jobId) {
                        await prisma.importJob.update({ where: { id: jobId }, data: { status: 'CANCELLED' } });
                        await interaction.reply({ content: '✅ Your history import has been cancelled.', ephemeral: true });
                    }
                    const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
                    if (dbUser) await this.renderHistoryImport(interaction, dbUser);
                    return;
                }
            }
        } catch (err) {
            LoggerService.error('SettingsHandler Error', err, 'SettingsHandler');
            throw err;
        }
    }

    private async renderHistoryImport(interaction: any, dbUser: any) {
        const recentJobs = await prisma.importJob.findMany({
            where: {
                OR: [
                    { userId: dbUser.id },
                    { user: { lastfmUsername: dbUser.lastfmUsername } }
                ]
            },
            orderBy: { createdAt: 'desc' },
            take: 10
        });

        const builder = new ComponentsV2().addText(`## 📥 History Import Status`).addSeparator();

        if (recentJobs.length === 0) {
            builder.addText(`You haven't started any music history imports yet. Use \`/import\` to get started!`);
        } else {
            for (const job of recentJobs) {
                const date = job.createdAt.toLocaleDateString();
                const progress = Math.round((job.scrobbledTracks / job.totalTracks) * 100);
                let statusEmoji = job.status === 'COMPLETED' ? '✅' : (['PENDING', 'PROCESSING', 'AWAITING_CHOICE'].includes(job.status) ? '⏳' : '❌');
                if (job.status === 'CANCELLED') statusEmoji = '🚫';
                
                builder.addText(`**${statusEmoji} ${job.source} Import** (${date})`);
                builder.addText(`> Progress: ${job.scrobbledTracks.toLocaleString()} / ${job.totalTracks.toLocaleString()} tracks (${progress}%)`);
                builder.addText(`> Status: *${job.status}* ${job.isLegacy ? '[Legacy Mode]' : ''}`);
                if (['PENDING', 'PROCESSING'].includes(job.status)) {
                    const barSize = 12;
                    const filled = Math.round((job.scrobbledTracks / job.totalTracks) * barSize);
                    builder.addText(`> \`${'#'.repeat(filled)}${'-'.repeat(barSize - filled)}\``);
                }
                builder.addSeparator();
            }
        }

        const activeJob = recentJobs.find(j => ['PENDING', 'PROCESSING', 'AWAITING_CHOICE'].includes(j.status));
        const controlButtons: any[] = [];
        if (activeJob) controlButtons.push({ type: ComponentType.Button, custom_id: `us-import-cancel:${activeJob.id}`, label: 'Cancel Active Import', style: 4 });
        controlButtons.push({ type: ComponentType.Button, custom_id: 'us-view-HistoryImport-refresh', label: 'Refresh', style: 3 });
        controlButtons.push({ type: ComponentType.Button, custom_id: 'us-back-settings', label: 'Back', style: ButtonStyle.Secondary });
        builder.addRow(controlButtons);

        if (interaction.deferred || interaction.replied) await interaction.editReply(builder.build());
        else await interaction.update(builder.build());
    }
}
