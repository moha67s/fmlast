import { Client, Events, Interaction, ButtonInteraction, ButtonStyle, EmbedBuilder, Message, StringSelectMenuInteraction, ModalSubmitInteraction, CacheType, ComponentType, TextInputStyle } from "discord.js";
import { commands } from './commandHandler';
import { config } from '../../config';
import { MusicInteractionHandler } from './music/MusicInteractionHandler';
import { LoggerService } from '../services/bot/LoggerService';
import { randomBytes } from 'crypto';
import { InteractionDispatcher } from './interactions/InteractionDispatcher';
import { MusicBotService } from '../services/bot/MusicBotService';
import { ComponentsV2 } from '../utils/ComponentsV2';

// Initialize the dispatcher
InteractionDispatcher.init();

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
    // ── 1. Autocomplete ──
    if (interaction.isAutocomplete()) {
        const command = commands.get(interaction.commandName);
        if (command && command.autocomplete) {
            await command.autocomplete(interaction);
        }
        return;
    }

    // ── 2. Slash Commands ──
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

    // ── 3. Legacy Music Handler (Special Case) ──
    if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
        const customId = interaction.customId;
        if (customId.startsWith('mp-')) {
            if (interaction.isButton()) await MusicInteractionHandler.handleButton(interaction, client);
            else if (interaction.isModalSubmit()) await MusicInteractionHandler.handleModal(interaction);
            else if (interaction.isStringSelectMenu()) await MusicInteractionHandler.handleSelectMenu(interaction);
            return;
        }
    }

    // ── 4. Dispatcher for everything else ──
    try {
        const handled = await InteractionDispatcher.dispatch(interaction, client);
        if (!handled) {
            // Optional: Log unhandled interactions
            // console.log(`Unhandled interaction: ${interaction.customId}`);
        }
    } catch (error) {
        const traceId = randomBytes(4).toString('hex').toUpperCase();
        LoggerService.error(`Dispatcher Error (Trace: ${traceId})`, error, 'InteractionHandler');
        
        const errorEmbed = new ComponentsV2()
            .setAccent(0xFF0000)
            .addThumbnail(client.user?.displayAvatarURL() || '', `### ❌ Interaction Failed\nThere was an error processing this interaction.\n\n-# **Trace ID:** \`${traceId}\``)
            .build();

        if (interaction.isRepliable()) {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ ...errorEmbed, ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ ...errorEmbed, ephemeral: true }).catch(() => {});
            }
        }
    }
}

export async function handleUpdate(oldMsg: Message, newMsg: Message) {
    if (newMsg.author.bot) {
        await MusicBotService.handleMessage(newMsg).catch(() => {});
    }
}
