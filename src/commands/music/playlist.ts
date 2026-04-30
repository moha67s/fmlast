import {
  BaseCommand } from '../../structures/BaseCommand';
import { SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Interaction,
  ComponentType
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { Playlist } from '../../models/Playlist';
import { MongoService } from '../../database/mongo';
import { QueueManager } from '../../services/music/QueueManager';
import { SettingService } from '../../services/bot/SettingService';

export default class PlaylistCommand extends BaseCommand {
    name = 'playlist';
    description = 'Manage your custom music playlists (MongoDB)';

    slashData = new SlashCommandBuilder()
        .setName(this.name)
        .setDescription(this.description)
        .addSubcommand(sub => sub.setName('menu').setDescription('Open the interactive playlist menu'))
        .addSubcommand(sub => sub.setName('create').setDescription('Create a new playlist'))
        .addSubcommand(sub => sub.setName('list').setDescription('List your playlists'));

    async execute(interaction: any, isSlash = false, args: string[] = []) {

        if (!MongoService.isConnected) {
            return interaction.reply({ content: '❌ MongoDB is not connected. Please ask the owner to provide `MONGODB_URL` in `.env`.', ephemeral: true });
        }

        const subcommand = isSlash ? interaction.options.getSubcommand(false) : args[0];

        if (subcommand === 'create') {
            if (!isSlash) {
                return interaction.reply({ content: '❌ Please use the **Slash Command** `/playlist create` to open the creation menu.', ephemeral: true });
            }
            // Show creation modal directly
            const plModal = {
                title: 'Create Playlist',
                custom_id: `mp-modal-pl-create:${interaction.guildId}`,
                components: [{
                    type: ComponentType.ActionRow,
                    components: [{
                        type: 4,
                        custom_id: 'pl_name',
                        label: 'Playlist Name',
                        style: ButtonStyle.Primary,
                        placeholder: 'e.g. My Chill Mix',
                        required: true
                    }]
                }]
            };
            return interaction.showModal(plModal);
        }

        if (subcommand === 'list') {
            // Use the interaction handler logic by spoofing a button click or just calling it
            // For now, I'll just show the main menu or a list
        }

        const menu = new ComponentsV2()
            .setAccent(0x5865F2)
            .addText('### 📁 Playlist Manager\nManage your personal music library. Create custom playlists and play them anytime.')
            .addRow([
                { type: ComponentType.Button, style: ButtonStyle.Success, custom_id: 'mp-pl-create', label: 'Create New', emoji: '➕' },
                { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: 'mp-pl-view-all', label: 'My Playlists', emoji: '📚' }
            ]);

        await interaction.reply(menu.build());
    }
}
