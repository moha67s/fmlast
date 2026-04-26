// src/handlers/interactionHandler.ts
import { 
    Client, Events, Interaction, ButtonInteraction, ButtonStyle, 
    EmbedBuilder, Message, StringSelectMenuInteraction, ModalSubmitInteraction,
    CacheType
} from 'discord.js';
import { commands } from './commandHandler';
import { config } from '../../config';
import ChartCommand, { ChartOptions, DEFAULT_OPTIONS } from '../commands/stats/chart';
import { prisma } from '../database/client';
import { LastFM } from '../services/api/LastFM';
import { MusicPlayer } from '../services/music/MusicPlayer';
import { QueueManager } from '../services/music/QueueManager';
import { indexQueue } from '../services/bot/QueueWorker';
import { MusicBotService } from '../services/bot/MusicBotService';
import { ComponentsV2 } from '../utils/ComponentsV2';
import { MusicInteractionHandler } from './music/MusicInteractionHandler';
import { LoggerService } from '../services/bot/LoggerService';
import { randomBytes } from 'crypto';

// ==================== CHART EDIT STATE ====================
interface ChartEditState {
    userId: string;
    size: number;
    period: string;
    skipNoImage: boolean;
    sfwOnly: boolean;
    hideSingles: boolean;
    releaseFilter: string;
    username: string;
}

/** Encode full state (with period) into a custom_id fragment */
function encodeState(state: ChartEditState): string {
    const si = state.skipNoImage ? '1' : '0';
    const sfw = state.sfwOnly ? '1' : '0';
    const hs = state.hideSingles ? '1' : '0';
    const rf = state.releaseFilter || '_';
    return `${state.userId}:${state.size}:${state.period}:${si}:${sfw}:${hs}:${rf}:${state.username}`;
}

/** Encode state WITHOUT period (for the period select menu, where period comes from selected value) */
function encodeStateNoPeriod(state: ChartEditState): string {
    const si = state.skipNoImage ? '1' : '0';
    const sfw = state.sfwOnly ? '1' : '0';
    const hs = state.hideSingles ? '1' : '0';
    const rf = state.releaseFilter || '_';
    return `${state.userId}:${state.size}:${si}:${sfw}:${hs}:${rf}:${state.username}`;
}

/** Decode full state (with period) from a custom_id fragment */
function decodeState(stateStr: string): ChartEditState {
    const parts = stateStr.split(':');
    return {
        userId: parts[0],
        size: parseInt(parts[1]) || 3,
        period: parts[2] || 'weekly',
        skipNoImage: parts[3] === '1',
        sfwOnly: parts[4] === '1',
        hideSingles: parts[5] === '1',
        releaseFilter: (parts[6] === '_' || !parts[6]) ? '' : parts[6],
        username: parts[7] || '',
    };
}

/** Decode state WITHOUT period (period provided separately from select value) */
function decodeStateNoPeriod(stateStr: string, period: string): ChartEditState {
    const parts = stateStr.split(':');
    return {
        userId: parts[0],
        size: parseInt(parts[1]) || 3,
        period,
        skipNoImage: parts[2] === '1',
        sfwOnly: parts[3] === '1',
        hideSingles: parts[4] === '1',
        releaseFilter: (parts[5] === '_' || !parts[5]) ? '' : parts[5],
        username: parts[6] || '',
    };
}

// ==================== BUILD SETTINGS MESSAGE ====================
function buildSettingsMessage(state: ChartEditState): any {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    // Build period options
    const periodOptions: { label: string; value: string; default: boolean }[] = [
        { label: 'Day', value: 'daily', default: false },
        { label: 'Week', value: 'weekly', default: false },
        { label: 'Month', value: 'monthly', default: false },
        { label: 'Year', value: 'yearly', default: false },
        { label: 'Overall', value: 'overall', default: false },
    ];

    // Add dynamic months (2 months before current)
    for (let i = 2; i >= 1; i--) {
        let m = currentMonth - i;
        let y = currentYear;
        if (m < 0) { m += 12; y--; }
        const monthStr = String(m + 1).padStart(2, '0');
        periodOptions.push({
            label: `${monthNames[m]} ${y}`,
            value: `month-${y}-${monthStr}`,
            default: false
        });
    }

    // Add dynamic years
    periodOptions.push(
        { label: String(currentYear), value: `year-${currentYear}`, default: false },
        { label: String(currentYear - 1), value: `year-${currentYear - 1}`, default: false }
    );

    // Mark current period as default
    periodOptions.forEach(opt => { opt.default = opt.value === state.period; });
    if (!periodOptions.some(opt => opt.default)) {
        const weekOpt = periodOptions.find(opt => opt.value === 'weekly');
        if (weekOpt) weekOpt.default = true;
    }

    // Encode state for custom_ids
    const stateStr = encodeState(state);
    const stateStrNP = encodeStateNoPeriod(state);

    const periodInfo = ChartCommand.getPeriodInfoStatic(state.period);
    const filterLabel = state.releaseFilter ? state.releaseFilter : 'any';

    // Build the options summary line
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
                type: 1, // Action Row
                components: [{
                    type: 3, // String Select Menu
                    custom_id: `cp:${stateStrNP}`,
                    placeholder: 'Select time period',
                    options: periodOptions
                }]
            },
            {
                type: 1,
                components: [
                    {
                        type: 2, // Button
                        custom_id: `ct-si:${stateStr}`,
                        style: state.skipNoImage ? ButtonStyle.Success : ButtonStyle.Secondary,
                        label: 'Skip No Image',
                    },
                    {
                        type: 2,
                        custom_id: `ct-sfw:${stateStr}`,
                        style: state.sfwOnly ? ButtonStyle.Success : ButtonStyle.Secondary,
                        label: 'SFW Only',
                    },
                    {
                        type: 2,
                        custom_id: `ct-hs:${stateStr}`,
                        style: state.hideSingles ? ButtonStyle.Success : ButtonStyle.Secondary,
                        label: 'Hide Singles',
                    }
                ]
            },
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        custom_id: `cm:${stateStr}`,
                        style: ButtonStyle.Secondary,
                        label: '📐 Size & Filter'
                    },
                    {
                        type: 2,
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

export async function handleMessage(message: Message, client: Client) {
    if (message.author.bot) {
        await MusicBotService.handleMessage(message).catch(console.error);
        return;
    }

    if (!message.content.startsWith(config.PREFIX)) return;

    const args = message.content.slice(config.PREFIX.length).trim().split(/ +/);
    const commandName = args.shift()?.toLowerCase();

    if (!commandName) return;

    const command = commands.get(commandName);
    if (!command) return;

    try {
        await command.execute(message, false, args);
    } catch (error) {
        const traceId = randomBytes(4).toString('hex').toUpperCase();
        LoggerService.error(`Command Error [${commandName}] (Trace: ${traceId})`, error, 'CommandHandler');
        
        const errorEmbed = new ComponentsV2()
            .setAccent(0xFF0000)
            .addThumbnail(client.user?.displayAvatarURL() || '', `### ❌ Something went wrong\nThere was an error trying to execute that command.\n\n-# **Trace ID:** \`${traceId}\`\n-# If this persists, please report it in our support server.`)
            .build();
            
        message.reply(errorEmbed).catch(() => {});
    }
}

export async function handleInteraction(interaction: Interaction, client: Client) {
    if (interaction.isAutocomplete()) {
        const command = commands.get(interaction.commandName);
        if (command && command.autocomplete) {
            await command.autocomplete(interaction);
        }
        return;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('mp-')) {
            await MusicInteractionHandler.handleModal(interaction);
            return;
        }
    }

    if (interaction.isChatInputCommand()) {
        const command = commands.get(interaction.commandName);
        if (!command) return;
        try {
            await command.execute(interaction, true);
        } catch (error) {
            const traceId = randomBytes(4).toString('hex').toUpperCase();
            LoggerService.error(`Interaction Error [${interaction.commandName}] (Trace: ${traceId})`, error, 'InteractionHandler');
            
            const errorEmbed = new ComponentsV2()
                .setAccent(0xFF0000)
                .addThumbnail(client.user?.displayAvatarURL() || '', `### ❌ Something went wrong\nThere was an error executing this command.\n\n-# **Trace ID:** \`${traceId}\`\n-# If this persists, please report it in our support server.`)
                .build();

            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ ...errorEmbed, ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ ...errorEmbed, ephemeral: true }).catch(() => {});
            }
        }
        return;
    }

    // ── 0.1 Login Flow ──
    if (interaction.isButton() && interaction.customId === 'user-login') {
        try {
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
                            {
                                type: 10,
                                content: content
                            },
                            {
                                type: 1,
                                components: [
                                    {
                                        type: 2,
                                        style: 5,
                                        url: authUrl,
                                        label: "Connect Last.fm account",
                                        disabled: false
                                    },
                                    {
                                        type: 2,
                                        style: 3, // Success
                                        custom_id: "finish-login",
                                        label: "Finish Login",
                                        disabled: false
                                    }
                                ]
                            }
                        ]
                    }
                ],
                flags: 32768,
                ephemeral: true
            });
        } catch (err: any) {
            console.error("Login Error:", err);
            await interaction.reply({ content: `❌ Failed to generate login link: ${err.message}`, ephemeral: true });
        }
        return;
    }

    if (interaction.isButton() && (interaction.customId.startsWith('imp_leg:') || interaction.customId.startsWith('imp_std:'))) {
        const [type, jobId] = interaction.customId.split(':');
        const isLegacy = type === 'imp_leg';

        try {
            const job = await prisma.importJob.update({
                where: { id: jobId },
                data: { 
                    isLegacy,
                    status: 'PENDING'
                },
                include: { user: true }
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

            if (indexQueue) {
                await indexQueue.add(`import-${jobId}`, { 
                    type: 'HISTORY_IMPORT',
                    jobId: jobId,
                    discordId: interaction.user.id
                });
            }
        } catch (err: any) {
            console.error("Import Button Error:", err);
            await interaction.reply({ content: `❌ Could not start import: ${err.message}`, ephemeral: true });
        }
        return;
    }

    if (interaction.isButton() && interaction.customId === 'finish-login') {
        await interaction.deferUpdate().catch(() => {});
        try {
            const username = await LastFM.completeLogin(interaction.user.id);
            
            if (indexQueue) {
                await indexQueue.add('index-user', { discordId: interaction.user.id, type: 'FULL_SYNC' }, {
                    jobId: `full-${interaction.user.id}`,
                    removeOnComplete: true,
                    removeOnFail: true
                });
                console.log(`[Queue] Queued FULL_SYNC for ${username}`);
            }

            await interaction.editReply({
                components: [
                    {
                        type: 17,
                        accent_color: null,
                        spoiler: false,
                        components: [
                            {
                                type: 10,
                                content: `🎉 **Last.fm Linked!**\nSuccessfully connected as **${username}**\n\nYour private stats are now available!`
                            }
                        ]
                    }
                ],
                flags: 32768
            });
        } catch (err: any) {
            console.error("Finish Login Error:", err);
            await interaction.editReply({
                components: [{
                    type: 17,
                    components: [{
                        type: 10,
                        content: `❌ **Login Not Authorized**\nPlease make sure you clicked "Allow Access" on the Last.fm page before clicking Finish.`
                    }]
                }]
            });
        }
        return;
    }

    // ── 0.15 Friend Request Buttons ──
    if (interaction.isButton() && interaction.customId.startsWith('friend-')) {
        const parts = interaction.customId.split(':');
        const action = parts[0]; // 'friend-accept' or 'friend-deny'
        const requestId = parts[1];

        try {
            const req = await prisma.friend.findUnique({ where: { id: requestId }, include: { user: true, friend: true } });
            
            if (!req) {
                await interaction.reply({ content: '❌ Friend request not found or already processed.', ephemeral: true });
                return;
            }

            if (interaction.user.id !== req.friend.discordId) {
                await interaction.reply({ content: '❌ You cannot accept a friend request that is not meant for you.', ephemeral: true });
                return;
            }

            if (action === 'friend-accept') {
                await prisma.friend.update({ where: { id: req.id }, data: { status: 'ACCEPTED' } });
                
                const builder = new ComponentsV2()
                    .setAccent(0x43b581) // Discord Green
                    .addText(`### ✅ Request Accepted\n**${req.friend.lastfmUsername}** and **${req.user.lastfmUsername}** are now friends!`);
                
                await interaction.update({ ...builder.build(), content: '' });
            } else if (action === 'friend-deny') {
                await prisma.friend.delete({ where: { id: req.id } });
                
                const builder = new ComponentsV2()
                    .setAccent(0xf04747) // Discord Red
                    .addText(`### ❌ Request Denied\nYou declined the friend request from **${req.user.lastfmUsername}**.`);
                
                await interaction.update({ ...builder.build(), content: '' });
            }
        } catch (e: any) {
            console.error("Friend Request Interaction Error:", e);
            try { await (interaction as ButtonInteraction).reply({ content: '❌ Failed to process request.', ephemeral: true }); } catch {}
        }
        return;
    }

    // ── 0.16 User Settings Picker ──
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
                        type: 2, 
                        custom_id: `us-toggle-scrobbling:${!isEnabled}`, 
                        label: isEnabled ? 'Disable Scrobbling' : 'Enable Scrobbling', 
                        style: isEnabled ? 4 : 3 
                    },
                    { type: 2, custom_id: 'us-back-settings', label: 'Back', style: 2 }
                ]);
            
            await interaction.update(builder.build());
        } else if (selected === 'us-view-HistoryImport') {
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

            const builder = new ComponentsV2()
                .addText(`## 📥 History Import Status`)
                .addSeparator();

            if (recentJobs.length === 0) {
                builder.addText(`You haven't started any music history imports yet. Use \`/import\` to get started!`);
            } else {
                for (const job of recentJobs) {
                    const date = job.createdAt.toLocaleDateString();
                    const progress = Math.round((job.scrobbledTracks / job.totalTracks) * 100);
                    
                    let statusEmoji = '❌';
                    if (job.status === 'COMPLETED') statusEmoji = '✅';
                    else if (['PENDING', 'PROCESSING', 'AWAITING_CHOICE'].includes(job.status)) statusEmoji = '⏳';
                    else if (job.status === 'CANCELLED') statusEmoji = '🚫';
                    
                    builder.addText(`**${statusEmoji} ${job.source} Import** (${date})`);
                    builder.addText(`> Progress: ${job.scrobbledTracks.toLocaleString()} / ${job.totalTracks.toLocaleString()} tracks (${progress}%)`);
                    builder.addText(`> Status: *${job.status}* ${job.isLegacy ? '[Legacy Mode]' : ''}`);

                    if (['PENDING', 'PROCESSING'].includes(job.status)) {
                        const barSize = 12;
                        const filled = Math.round((job.scrobbledTracks / job.totalTracks) * barSize);
                        const bar = `\`${'#'.repeat(filled)}${'-'.repeat(barSize - filled)}\``;
                        builder.addText(`> ${bar}`);
                    }
                    builder.addSeparator();
                }
            }

            const activeJob = recentJobs.find(j => ['PENDING', 'PROCESSING', 'AWAITING_CHOICE'].includes(j.status));
            const controlButtons: any[] = [];
            
            if (activeJob) {
                controlButtons.push({ type: 2, custom_id: `us-import-cancel:${activeJob.id}`, label: 'Cancel Active Import', style: 4 });
            }
            
            controlButtons.push({ type: 2, custom_id: 'us-view-HistoryImport-refresh', label: 'Refresh', style: 3 });
            controlButtons.push({ type: 2, custom_id: 'us-back-settings', label: 'Back', style: 2 });
            
            builder.addRow(controlButtons);
            await interaction.update(builder.build());
        } else {
            await interaction.reply({ content: `The **${selected.replace('us-view-', '')}** setting module is coming soon!`, ephemeral: true });
        }
        return;
    }

    if (interaction.isButton() && (interaction.customId.startsWith('us-import-cancel:') || interaction.customId === 'us-view-HistoryImport-refresh')) {
        const jobId = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
        
        try {
            if (jobId) {
                await prisma.importJob.update({
                    where: { id: jobId },
                    data: { status: 'CANCELLED' }
                });
                await interaction.reply({ content: '✅ Your history import has been cancelled.', ephemeral: true });
            }

            const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
            if (!dbUser) return;

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

            const builder = new ComponentsV2()
                .addText(`## 📥 History Import Status`)
                .addSeparator();

            if (recentJobs.length === 0) {
                builder.addText(`You haven't started any music history imports yet. Use \`/import\` to get started!`);
            } else {
                for (const job of recentJobs) {
                    const date = job.createdAt.toLocaleDateString();
                    const progress = Math.round((job.scrobbledTracks / job.totalTracks) * 100);
                    
                    let statusEmoji = '❌';
                    if (job.status === 'COMPLETED') statusEmoji = '✅';
                    else if (['PENDING', 'PROCESSING', 'AWAITING_CHOICE'].includes(job.status)) statusEmoji = '⏳';
                    else if (job.status === 'CANCELLED') statusEmoji = '🚫';
                    
                    builder.addText(`**${statusEmoji} ${job.source} Import** (${date})`);
                    builder.addText(`> Progress: ${job.scrobbledTracks.toLocaleString()} / ${job.totalTracks.toLocaleString()} tracks (${progress}%)`);
                    builder.addText(`> Status: *${job.status}* ${job.isLegacy ? '[Legacy Mode]' : ''}`);

                    if (['PENDING', 'PROCESSING'].includes(job.status)) {
                        const barSize = 12;
                        const filled = Math.round((job.scrobbledTracks / job.totalTracks) * barSize);
                        const bar = `\`${'#'.repeat(filled)}${'-'.repeat(barSize - filled)}\``;
                        builder.addText(`> ${bar}`);
                    }
                    builder.addSeparator();
                }
            }

            const activeJob = recentJobs.find(j => ['PENDING', 'PROCESSING', 'AWAITING_CHOICE'].includes(j.status));
            const controlButtons: any[] = [];
            
            if (activeJob) {
                controlButtons.push({ type: 2, custom_id: `us-import-cancel:${activeJob.id}`, label: 'Cancel Active Import', style: 4 });
            }
            
            controlButtons.push({ type: 2, custom_id: 'us-view-HistoryImport-refresh', label: 'Refresh', style: 3 });
            controlButtons.push({ type: 2, custom_id: 'us-back-settings', label: 'Back', style: 2 });
            
            builder.addRow(controlButtons);
            
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(builder.build());
            } else {
                await interaction.update(builder.build());
            }
        } catch (err: any) {
            console.error("Import View Error:", err);
        }
        return;
    }

    if (interaction.isButton() && interaction.customId === 'us-back-settings') {
        const SettingsCmd = (await import('../commands/core/settings')).default;
        const cmd = new SettingsCmd();
        await (cmd as any).execute(interaction, true);
        return;
    }

    if (interaction.isButton() && interaction.customId === 'user-setting-botscrobbling-manage') {
        const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
        if (!dbUser) return;
        const settings = (dbUser.settings as any) || {};
        const isEnabled = settings.scrobbling !== false;
        const builder = new ComponentsV2()
            .addText(`## 🤖 Music bot scrobbling`)
            .addSeparator()
            .addText(`Current status: **${isEnabled ? 'Enabled' : 'Disabled'}**`)
            .addRow([
                { type: 2, custom_id: `us-toggle-scrobbling:${!isEnabled}`, label: isEnabled ? 'Disable Scrobbling' : 'Enable Scrobbling', style: isEnabled ? 4 : 3 }
            ]);
        await interaction.reply({ ...builder.build(), ephemeral: true });
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('us-toggle-scrobbling:')) {
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
                { type: 2, custom_id: `us-toggle-scrobbling:${!newVal}`, label: newVal ? 'Disable Scrobbling' : 'Enable Scrobbling', style: newVal ? 4 : 3 },
                { type: 2, custom_id: 'us-back-settings', label: 'Back', style: 2 }
            ]);
        await interaction.update(builder.build());
        return;
    }

    // ── Preview & Radio ──
    if (interaction.isButton() && interaction.customId.startsWith('preview:')) {
        const uniqueId = interaction.customId.substring('preview:'.length);
        const { previewMap, downloadAndConvert } = await import('../utils/downloader');
        const sendVoice = (await import('../utils/sendVoice')).default;
        const previewUrl = previewMap.get(uniqueId);
        if (!previewUrl) return interaction.reply({ content: '❌ Preview expired.', ephemeral: true });
        await interaction.deferUpdate();
        try {
            const oggPath = await downloadAndConvert(previewUrl, uniqueId);
            await sendVoice(interaction.channelId!, oggPath, interaction.message?.id);
        } catch (err) { console.error(err); }
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('radio-pre:')) {
        const query = interaction.customId.substring('radio-pre:'.length);
        const [art, track] = query.split('|');
        const { downloadAndConvert } = await import('../utils/downloader');
        const sendVoice = (await import('../utils/sendVoice')).default;
        const { TrackResolverService } = await import('../services/api/TrackResolverService');
        
        await interaction.deferUpdate();
        try {
            const resolved = await TrackResolverService.resolve(art, track);
            const previewUrl = resolved.previewUrl;
            
            if (!previewUrl) return interaction.followUp({ content: '❌ No preview found.', ephemeral: true });
            
            const oggPath = await downloadAndConvert(previewUrl, `radio_${Date.now()}`);
            const msg = await sendVoice(interaction.channelId!, oggPath, interaction.message.id);

            if (msg && msg.id) {
                const { LastFM } = await import('../services/api/LastFM');
                const { ComponentsV2 } = await import('../utils/ComponentsV2');
                
                const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
                
                let finalDuration = '';
                if (resolved.durationMs > 0) {
                    const totalSeconds = Math.floor(resolved.durationMs / 1000);
                    const minutes = Math.floor(totalSeconds / 60);
                    const seconds = totalSeconds % 60;
                    finalDuration = `${minutes}:${seconds.toString().padStart(2, '0')}`;
                }

                let statsText = '';
                try {
                    const lfmInfo = await LastFM.getTrackInfo(resolved.artist, resolved.title, dbUser?.lastfmUsername, dbUser?.lastfmSessionKey);
                    const listeners = lfmInfo?.listeners ? parseInt(lfmInfo.listeners).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;
                    const plays = lfmInfo?.playcount ? parseInt(lfmInfo.playcount).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;

                    const parts = [];
                    if (finalDuration) parts.push(finalDuration);
                    if (listeners) parts.push(`${listeners} listeners`);
                    if (plays) parts.push(`${plays} plays`);
                    if (parts.length > 0) statsText = `\n${parts.join(' • ')}`;
                } catch { }

                const embedBuilder = new ComponentsV2()
                    .addThumbnail(resolved.artworkUrl || 'https://i.imgur.com/Gis9d79.png', `### ${resolved.title}\n**${resolved.artist}**${resolved.album ? ` - ${resolved.album}` : ''}${statsText}`)
                    .addSeparator();

                const buttons: any[] = [];
                const links = resolved.links;
                const trackUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(resolved.artist)}/_/${encodeURIComponent(resolved.title)}`;
                if (links.spotify) buttons.push({ type: 2, style: 5, url: links.spotify, emoji: { id: "1496297132381048995", name: "sp" } });
                if (links.apple) buttons.push({ type: 2, style: 5, url: links.apple, emoji: { id: "1496297174869479548", name: "am" } });
                if (links.deezer) buttons.push({ type: 2, style: 5, url: links.deezer, emoji: { id: "1496297153717473311", name: "dez" } });
                if (trackUrlLastfm) buttons.push({ type: 2, style: 5, url: trackUrlLastfm, emoji: { id: "1496297104434270290", name: "las" } });
                if (links.youtube) buttons.push({ type: 2, style: 5, url: links.youtube, emoji: { id: "1496297072201040094", name: "yt" } });

                if (buttons.length > 0) {
                    embedBuilder.addRow(buttons);
                }

                const payload = embedBuilder.build();
                const channel = interaction.client.channels.cache.get(interaction.channelId!) as any;
                if (channel) {
                    await channel.send({ ...payload, reply: { messageReference: msg.id } });
                }
            }
        } catch (err) { console.error(err); }
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('radio-reroll')) {
        const { default: RadioCommand } = await import('../commands/media/radio');
        const radioCmd = new RadioCommand();
        await radioCmd.execute(interaction, true);
        return;
    }

    // ── Lyric Card ──
    if (interaction.isButton() && interaction.customId.startsWith('lc-nav:')) {
        await interaction.deferUpdate();
        try {
            const payload = interaction.customId.substring('lc-nav:'.length);
            const parts = payload.split('|');
            const artist = parts[0];
            const track = parts[1];
            const lineIdx = parseInt(parts[2] ?? '0', 10);
            const { buildLyricCardBuffer, buildLyricNavRow, getLyricCacheCover } = await import('../commands/media/lyriccard');
            const { LyricsService } = await import('../services/external/LyricsService');
            const { lines: lyricLines, source } = await LyricsService.fetchLyrics(artist, track);
            let coverUrl = getLyricCacheCover(artist, track);
            let previewUrl: string | null = null;
            if (coverUrl === undefined || coverUrl === null) {
                const { AppleMusic } = await import('../services/api/AppleMusic');
                const am = await AppleMusic.searchTrack(artist, track);
                coverUrl = am?.artworkUrl?.replace('{w}x{h}', '1000x1000') || null;
                previewUrl = am?.previewUrl || null;
            }
            // ── 1. CHECK RENDER CACHE ──
            const { RenderCacheService } = await import('../services/bot/RenderCacheService');
            let cdnUrl = await RenderCacheService.getCachedImage('lyriccard', artist, track + ':' + lineIdx);

            if (!cdnUrl) {
                const buf = await buildLyricCardBuffer({ artist, track, coverUrl, lyricLines, lineIdx, source });
                const { AttachmentBuilder } = await import('discord.js');
                const { config } = await import('../../config');
                const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
                
                if (stagingChannelId && interaction.client) {
                    const stagingChannel = await interaction.client.channels.fetch(stagingChannelId) as any;
                    const attachment = new AttachmentBuilder(buf as Buffer, { name: 'lyriccard.webp' });
                    const stagingMsg = await stagingChannel.send({ files: [attachment] });
                    cdnUrl = stagingMsg.attachments.first()?.url || null;
                    
                    if (cdnUrl) {
                        await RenderCacheService.setCachedImage('lyriccard', artist, track + ':' + lineIdx, cdnUrl);
                    }
                    setTimeout(() => stagingMsg.delete().catch(() => {}), 30000);
                }
            }

            const navRow = buildLyricNavRow(artist, track, lineIdx, lyricLines.length, previewUrl);
            const builder = new ComponentsV2()
                .addText(`### 🎵 Lyric Card: **${track}**`)
                .addFullImage((cdnUrl || coverUrl) as string);
            
            const msgPayload = builder.build();
            msgPayload.components.push(navRow);
            await interaction.editReply(msgPayload);
        } catch (e) { console.error(e); }
        return;
    }

    // ── Whatchosong buttons ──
    if (interaction.isButton() && interaction.customId.startsWith('wh-lyrics:')) {
        const data = interaction.customId.substring('wh-lyrics:'.length);
        const parts = data.split('|');
        const art = parts.length === 3 ? parts[1] : parts[0];
        const track = parts.length === 3 ? parts[2] : parts[1];
        const { default: LyricCardCommand } = await import('../commands/media/lyriccard');
        const lyricCmd = new LyricCardCommand();
        await interaction.deferReply({ ephemeral: false });
        await lyricCmd.execute(interaction, true, [`${track} by ${art}`]);
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('wh-youtube:')) {
        const data = interaction.customId.substring('wh-youtube:'.length);
        const parts = data.split('|');
        const { default: YoutubeCommand } = await import('../commands/shortcuts/youtube');
        const youtubeCmd = new YoutubeCommand();
        await interaction.deferReply({ ephemeral: false });
        await youtubeCmd.execute(interaction, true, [`${parts[0]} - ${parts[1]}`]);
        return;
    }

    // ==================== MUSIC CONTROLS (V2) ====================
    if ('customId' in interaction && (interaction as any).customId.startsWith('mp-')) {
        if (interaction.isButton()) {
            await MusicInteractionHandler.handleButton(interaction as ButtonInteraction, client);
        } else if (interaction.isStringSelectMenu()) {
            await MusicInteractionHandler.handleSelectMenu(interaction as StringSelectMenuInteraction);
        }
        return;
    }

    // ── Chart Edit ──
    if (interaction.isButton() && interaction.customId.startsWith('chart-edit:')) {
        const state = decodeState(interaction.customId.substring('chart-edit:'.length));
        if (interaction.user.id !== state.userId) return interaction.reply({ content: '❌ Not yours.', ephemeral: true });
        await interaction.reply(buildSettingsMessage(state));
        return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('cp:')) {
        const state = decodeStateNoPeriod(interaction.customId.substring(3), interaction.values[0]);
        if (interaction.user.id !== state.userId) return;
        await interaction.update(buildSettingsMessage(state));
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('ct-')) {
        const colonIndex = interaction.customId.indexOf(':', 3);
        const optionKey = interaction.customId.substring(3, colonIndex);
        const state = decodeState(interaction.customId.substring(colonIndex + 1));
        if (interaction.user.id !== state.userId) return;
        if (optionKey === 'si') state.skipNoImage = !state.skipNoImage;
        else if (optionKey === 'sfw') state.sfwOnly = !state.sfwOnly;
        else if (optionKey === 'hs') state.hideSingles = !state.hideSingles;
        await interaction.update(buildSettingsMessage(state));
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('cm:')) {
        const state = decodeState(interaction.customId.substring(3));
        if (interaction.user.id !== state.userId) return;
        const modal = { title: 'Edit Grid', custom_id: `cms:${interaction.customId.substring(3)}`, components: [
            { type: 1, components: [{ type: 4, custom_id: 'size', label: 'Grid Size', style: 1, value: `${state.size}x${state.size}` }] },
            { type: 1, components: [{ type: 4, custom_id: 'release_filter', label: 'Release filter', style: 1, value: state.releaseFilter, required: false }] }
        ] };
        await (interaction as ButtonInteraction).showModal(modal);
        return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('cms:')) {
        const state = decodeState(interaction.customId.substring(4));
        const sizeMatch = interaction.fields.getTextInputValue('size').match(/(\d+)/);
        state.size = sizeMatch ? Math.min(Math.max(parseInt(sizeMatch[1]), 1), 9) : 3;
        state.releaseFilter = interaction.fields.getTextInputValue('release_filter')?.trim() || '';
        await (interaction as any).update(buildSettingsMessage(state));
        return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('cs:')) {
        const state = decodeState(interaction.customId.substring(3));
        if (interaction.user.id !== state.userId) return;
        await interaction.update({ content: '⏳ Generating...', components: [] });
        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId: state.userId } });
            if (!dbUser?.lastfmSessionKey) throw new Error('Not linked.');
            const payload = await ChartCommand.createChartPayload(state.userId, dbUser.lastfmUsername!, dbUser.lastfmSessionKey, state.size, state.period, interaction.client, {
                skipNoImage: state.skipNoImage, sfwOnly: state.sfwOnly, hideSingles: state.hideSingles, releaseFilter: state.releaseFilter
            });
            await interaction.followUp(payload);
        } catch (err: any) { await interaction.followUp({ content: `❌ ${err.message}`, ephemeral: true }); }
        return;
    }

    // ── AT pagination ──
    if (interaction.isButton() && interaction.customId.startsWith('at-page:')) {
        const parts = interaction.customId.split(':');
        const action = parts[1];
        const currentPage = parseInt(parts[2], 10);
        const userId = parts[3];
        const artistQuery = decodeURIComponent(parts[4]);

        if (interaction.user.id !== userId) return interaction.reply({ content: '❌ Not yours.', ephemeral: true });

        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
            if (!dbUser) return;

            const tracks = await prisma.userTrack.findMany({
                where: { 
                    userId: dbUser.id,
                    artistName: { equals: artistQuery, mode: 'insensitive' },
                    playcount: { gt: 0 }
                },
                orderBy: { playcount: 'desc' },
                take: 75
            });

            const totalDifferentTracks = tracks.length;
            const totalPages = Math.ceil(totalDifferentTracks / 10);
            
            let targetPage = currentPage;
            if (action === 'first') targetPage = 1;
            else if (action === 'prev') targetPage = Math.max(1, currentPage - 1);
            else if (action === 'next') targetPage = Math.min(totalPages, currentPage + 1);
            else if (action === 'last') targetPage = totalPages;

            const safePage = Math.max(1, Math.min(targetPage, totalPages));
            const startIndex = (safePage - 1) * 10;
            const pageTracks = tracks.slice(startIndex, startIndex + 10);
            const trackLines = pageTracks.map((t, i) => `${startIndex + i + 1}. **${t.trackName}** - *${t.playcount} plays*`).join('\n');

            const artistTotal = await prisma.userArtist.findFirst({
                where: { userId: dbUser.id, artistName: { equals: artistQuery, mode: 'insensitive' } }
            });
            const totalArtistPlays = artistTotal ? artistTotal.playcount : 0;
            const displayName = interaction.user.globalName || interaction.user.displayName || interaction.user.username;

            const builder = new ComponentsV2()
                .setAccent(0xff0000)
                .addText(`### Your top tracks for '${tracks[0]?.artistName || artistQuery}'`)
                .addSeparator()
                .addText(trackLines)
                .addSeparator()
                .addText(`-# Page ${safePage}/${totalPages} — ${totalDifferentTracks} different tracks\n-# ${displayName} has ${totalArtistPlays} total artist plays`)
                .addRow([
                    { type: 2, custom_id: `at-page:first:${safePage}:${userId}:${encodeURIComponent(artistQuery)}`, style: 2, disabled: safePage === 1, emoji: { id: "883825508633182208", name: "pages_first" } },
                    { type: 2, custom_id: `at-page:prev:${safePage}:${userId}:${encodeURIComponent(artistQuery)}`, style: 2, disabled: safePage === 1, emoji: { id: "883825508507336704", name: "pages_previous" } },
                    { type: 2, custom_id: `at-page:next:${safePage}:${userId}:${encodeURIComponent(artistQuery)}`, style: 2, disabled: safePage === totalPages, emoji: { id: "883825508087922739", name: "pages_next" } },
                    { type: 2, custom_id: `at-page:last:${safePage}:${userId}:${encodeURIComponent(artistQuery)}`, style: 2, disabled: safePage === totalPages, emoji: { id: "883825508482183258", name: "pages_last" } }
                ]);

            await interaction.update(builder.build());
        } catch (err) { console.error(err); }
        return;
    }

    // ── Discogs pagination ──
    if (interaction.isButton() && interaction.customId.startsWith('discogs-page:')) {
        const parts = interaction.customId.split(':');
        const action = parts[1];
        const currentPage = parseInt(parts[2], 10);
        const discordId = parts[3];
        const username = parts[4];
        const listType = parts[5];

        if (interaction.user.id !== discordId) return interaction.reply({ content: '❌ Not yours.', ephemeral: true });

        try {
            let targetPage = currentPage;
            if (action === 'prev') targetPage = Math.max(1, currentPage - 1);
            else if (action === 'next') targetPage = currentPage + 1;

            const Discogs = (await import('../services/api/Discogs')).Discogs;
            const data = listType === 'collection' ? await Discogs.getCollection(username, targetPage, 10) : await Discogs.getWantlist(username, targetPage, 10);
            if (!data.items || data.items.length === 0) return interaction.reply({ content: '❌ No more found.', ephemeral: true });

            const total = data.pagination?.items || data.items.length;
            const totalPages = data.pagination?.pages || 1;
            const safePage = Math.max(1, Math.min(targetPage, totalPages));

            const trackLines = data.items.map((item: any, i: number) => {
                const r = item.basic_information;
                return `${(safePage - 1) * 10 + i + 1}. **${r.title}** - *${r.artists?.[0]?.name || 'Unknown Artist'}* (${r.year || '?'})`;
            }).join('\n');

            const titlePrefix = listType === 'collection' ? '### 💿' : '### ❤️';
            const listTitle = listType === 'collection' ? 'Vinyl Collection' : 'Vinyl Wantlist';
            const accentColor = listType === 'collection' ? 0x000000 : 0xff0000;

            const builder = new ComponentsV2()
                .setAccent(accentColor)
                .addThumbnail(interaction.user.displayAvatarURL(), `${titlePrefix} ${username}'s ${listTitle}\n${trackLines}\n-# Total records: ${total}`)
                .addRow([
                    { type: 2, style: 2, label: '⬅️', custom_id: `discogs-page:prev:${safePage}:${discordId}:${username}:${listType}`, disabled: safePage === 1 },
                    { type: 2, style: 2, label: `${safePage} / ${totalPages}`, custom_id: 'dummy', disabled: true },
                    { type: 2, style: 2, label: '➡️', custom_id: `discogs-page:next:${safePage}:${discordId}:${username}:${listType}`, disabled: safePage === totalPages }
                ]);

            await interaction.update(builder.build());
        } catch (err) { console.error(err); }
        return;
    }
}

export async function handleUpdate(oldMsg: Message, newMsg: Message) {
    if (!newMsg.author?.bot) return;
    await MusicBotService.handleMessage(newMsg as Message).catch(console.error);
}
