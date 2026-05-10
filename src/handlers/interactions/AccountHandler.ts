import { Interaction, Client, ComponentType, ButtonStyle } from 'discord.js';
import { BaseInteractionHandler } from './BaseInteractionHandler';
import { prisma } from '../../database/client';
import { LastFM } from '../../services/api/LastFM';
import { fullQueue } from '../../services/bot/QueueWorker';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { LoggerService } from '../../services/bot/LoggerService';
import { config } from '../../../config';

export class AccountHandler extends BaseInteractionHandler {

    canHandle(customId: string): boolean {
        return customId === 'user-login' ||
            customId === 'finish-login' ||
            customId.startsWith('imp_leg:') ||
            customId.startsWith('imp_std:');
    }

    async handle(interaction: Interaction, client: Client): Promise<void> {
        if (!interaction.isButton()) return;

        try {
            // ── Login Flow ──
            if (interaction.customId === 'user-login') {
                const token = await LastFM.getToken();
                await prisma.user.upsert({
                    where: { discordId: interaction.user.id },
                    update: { lastfmRequestToken: token },
                    create: { discordId: interaction.user.id, lastfmRequestToken: token },
                });

                const authUrl = `https://www.last.fm/api/auth?api_key=${process.env.LASTFM_API_KEY}&token=${token}`;
                const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });

                let content = `1. Click the button below marked **Connect Last.fm account** and **Allow Access**\n2. After approving, click the **Finish Login** button below.`;
                if (dbUser?.lastfmSessionKey) {
                    content = `You have already connected a Last.fm account to the bot. If you want to change or reconnect your connected Last.fm account, click here. Note that this link will expire after 5 minutes. Also use this link if the bot says you have to re-login.`;
                }

                await interaction.reply({
                    components: [
                        {
                            type: 17,
                            accent_color: null,
                            spoiler: false,
                            components: [
                                { type: ComponentType.TextDisplay, content: content },
                                {
                                    type: ComponentType.ActionRow,
                                    components: [
                                        { type: ComponentType.Button, style: ButtonStyle.Link, url: authUrl, label: "Connect Last.fm account" },
                                        { type: ComponentType.Button, style: ButtonStyle.Success, custom_id: "finish-login", label: "Finish Login" }
                                    ]
                                }
                            ]
                        }
                    ],
                    flags: 32768,
                    ephemeral: true
                });
                return;
            }

            if (interaction.customId === 'finish-login') {
                await interaction.deferUpdate().catch(() => { });
                const username = await LastFM.completeLogin(interaction.user.id);

                let job: any = null;
                if (fullQueue) {
                    // Start the full sync immediately with a unique ID to avoid collisions
                    job = await fullQueue.add('index-user', { discordId: interaction.user.id, type: 'FULL_SYNC' }, {
                        jobId: `full-${interaction.user.id}-${Date.now()}`,
                        removeOnComplete: true,
                        removeOnFail: true
                    });
                }

                // Helper for progress bar
                const getBar = (pct: number) => {
                    const size = 10;
                    const filled = Math.floor(pct / 10);
                    return `\`${'█'.repeat(filled)}${'░'.repeat(size - filled)}\` **${pct}%**`;
                };

                const updateEmbed = async (pct: number, done = false) => {
                    const content = `🎉 **Last.fm Linked!**\nSuccessfully connected as **${username}**\n\n` +
                        (done ? `✅ **Data Download Complete!**\nYour private stats are now available!` :
                            `📥 **Downloading your data...**\n${getBar(pct)}\n*This may take a minute depending on your playcount.*`);

                    await interaction.editReply({
                        components: [{
                            type: 17,
                            components: [{
                                type: ComponentType.TextDisplay,
                                content: content
                            }]
                        }]
                    }).catch(() => { });
                };

                // Initial show
                await updateEmbed(0);

                // Polling loop
                if (job) {
                    let lastPct = 0;
                    let attempts = 0;

                    const checkProgress = async () => {
                        attempts++;
                        try {
                            const currentJob = await fullQueue!.getJob(job.id);

                            // If job is gone, it likely finished successfully (since we removeOnComplete)
                            // But we wait a few attempts to make sure it didn't just 'not start' yet
                            if (!currentJob) {
                                if (attempts > 2) {
                                    await updateEmbed(100, true);
                                    return true;
                                }
                                return false;
                            }

                            const progress = (currentJob.progress as number) || 0;
                            const state = await currentJob.getState();

                            if (state === 'completed' || progress >= 100) {
                                await updateEmbed(100, true);
                                return true;
                            } else if (progress > lastPct) {
                                lastPct = progress;
                                await updateEmbed(lastPct);
                            }
                            return false;
                        } catch (err) {
                            return attempts > 5; // Stop on persistent errors
                        }
                    };

                    const interval = setInterval(async () => {
                        if (await checkProgress()) clearInterval(interval);
                    }, 3000);

                    // Safety timeout (10 mins)
                    setTimeout(() => clearInterval(interval), 600000);
                }

                return;
            }

            // ── Import Flow ──
            if (interaction.customId.startsWith('imp_leg:') || interaction.customId.startsWith('imp_std:')) {
                const [type, jobId] = interaction.customId.split(':');
                const isLegacy = type === 'imp_leg';

                const job = await prisma.importJob.update({
                    where: { id: jobId },
                    data: { isLegacy, status: 'PENDING' }
                });

                const totalTracks = job.totalTracks;
                let estTime = '~1 minute';
                if (totalTracks > 2800) {
                    const days = Math.ceil((totalTracks - 2800) / 2800);
                    estTime = `~1 minute (initial) + ${days} day${days > 1 ? 's' : ''} (scheduled)`;
                }

                const updateBuilder = new ComponentsV2()
                    .setAccent(isLegacy ? 0x1DB954 : 0x5865F2)
                    .addText(`### ✅ Import Confirmed (${isLegacy ? 'Legacy' : 'Standard'})\nStarting import for **${totalTracks.toLocaleString()}** tracks for your account.`)
                    .addText(`> **Estimated Time**: ${estTime}`)
                    .addText(`The first batch is starting immediately. Subsequent batches will process every 24 hours.`);

                await interaction.update(updateBuilder.build());

                if (fullQueue) {
                    await fullQueue.add(`import-${jobId}`, {
                        type: 'HISTORY_IMPORT',
                        jobId: jobId,
                        discordId: interaction.user.id
                    });
                }
                return;
            }
        } catch (err) {
            LoggerService.error('AccountHandler Error', err, 'AccountHandler');
            throw err;
        }
    }
}
