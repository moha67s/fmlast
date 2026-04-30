import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

const PREMIUM_COLORS = [
    { label: 'Ruby Red', value: 'red', hex: '#FF4444', emoji: '🔴', description: 'Vibrant and energetic' },
    { label: 'Crimson', value: 'crimson', hex: '#DC143C', emoji: '🩸', description: 'Deep red' },
    { label: 'Sunset Orange', value: 'orange', hex: '#FF8C00', emoji: '🍊', description: 'Warm and bright' },
    { label: 'Amber', value: 'amber', hex: '#FFBF00', emoji: '🍯', description: 'Golden yellow-orange' },
    { label: 'Gold', value: 'gold', hex: '#FFD700', emoji: '⭐', description: 'Rich and luxurious' },
    { label: 'Lime Green', value: 'lime', hex: '#32CD32', emoji: '🍏', description: 'Bright and fresh' },
    { label: 'Emerald', value: 'emerald', hex: '#50C878', emoji: '💎', description: 'Deep jewel green' },
    { label: 'Teal', value: 'teal', hex: '#1ABC9C', emoji: '🌊', description: 'Balanced blue-green' },
    { label: 'Cyan', value: 'cyan', hex: '#00CED1', emoji: '🧊', description: 'Bright electric blue' },
    { label: 'Ocean Blue', value: 'blue', hex: '#0052FF', emoji: '🔵', description: 'Deep and calm' },
    { label: 'Navy', value: 'navy', hex: '#1A237E', emoji: '🌌', description: 'Dark and professional' },
    { label: 'Royal Blue', value: 'royal', hex: '#4169E1', emoji: '👑', description: 'Classic and rich' },
    { label: 'Purple', value: 'purple', hex: '#9B59B6', emoji: '🟣', description: 'Mystic and creative' },
    { label: 'Violet', value: 'violet', hex: '#8B00FF', emoji: '🔮', description: 'Deep and intense' },
    { label: 'Magenta', value: 'magenta', hex: '#FF00FF', emoji: '🌺', description: 'Vibrant pink-purple' },
    { label: 'Hot Pink', value: 'pink', hex: '#FF69B4', emoji: '🎀', description: 'Playful and bright' },
    { label: 'Rose', value: 'rose', hex: '#FF007F', emoji: '🌹', description: 'Romantic and soft' },
    { label: 'Coral', value: 'coral', hex: '#FF7F50', emoji: '🪸', description: 'Warm pink-orange' },
    { label: 'Snow White', value: 'white', hex: '#FFFFFF', emoji: '⚪', description: 'Clean and minimal' },
    { label: 'Midnight Black', value: 'black', hex: '#000000', emoji: '⚫', description: 'Sleek and dark' },
    { label: 'Silver', value: 'silver', hex: '#C0C0C0', emoji: '🪙', description: 'Cool and metallic' },
    { label: 'Blurple', value: 'blurple', hex: '#5865F2', emoji: '👾', description: 'Classic Discord' },
    { label: 'Spotify Green', value: 'spotify', hex: '#1DB954', emoji: '🎧', description: 'Music aesthetic' },
    { label: 'Last.fm Red', value: 'lastfm', hex: '#D51007', emoji: '🎵', description: 'Scrobbling aesthetic' },
    { label: 'Clear (Reset)', value: 'clear', hex: '#000000', emoji: '❌', description: 'Reset to default bot color' }
];

export default class ColorCommand extends BaseCommand {
    name = 'color';
    description = 'Set a custom embed color for your bot responses';
    aliases = ['setcolor', 'embedcolor'];

    slashData = new SlashCommandBuilder()
        .setName('color')
        .setDescription('Set a custom embed color for your bot responses')
        .addStringOption(opt => 
            opt.setName('color')
               .setDescription('Color name or hex code. Leave empty to open the interactive menu.')
               .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        let input = '';
        if (isSlash) {
            input = interactionOrMessage.options.getString('color') || '';
            await interactionOrMessage.deferReply();
        } else {
            input = (args || []).join(' ').trim();
            if (input) {
                try { await interactionOrMessage.channel.sendTyping(); } catch { }
            }
        }

        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        
        try {
            const dbUser = await prisma.user.findUnique({ where: { discordId: authorId } });
            if (!dbUser) {
                const reply = '❌ You must link your account first! Use `/login`.';
                return isSlash ? interactionOrMessage.editReply(reply) : interactionOrMessage.reply(reply);
            }

            // If no input provided, show the interactive menu
            if (!input) {
                return await this.showInteractiveMenu(interactionOrMessage, isSlash, dbUser);
            }

            // Direct input processing
            await this.processColorChange(interactionOrMessage, isSlash, dbUser, input);

        } catch (err: any) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to update color: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);
        }
    }

    private async showInteractiveMenu(interactionOrMessage: any, isSlash: boolean, dbUser: any) {
        const authorId = dbUser.discordId;
        const currentAccent = SettingService.resolveAccentColor(dbUser);
        
        const builder = new ComponentsV2()
            .setAccent(currentAccent)
            .addText('## 🎨 Theme Customization\nSelect a premium color from the dropdown below to customize your embeds. You can also type \`.color #HEX\` for a custom hex code.');
        
        builder.addRow([{
            type: 3,
            custom_id: 'color_select',
            placeholder: 'Pick a theme color...',
            options: PREMIUM_COLORS.map(c => ({
                label: c.label,
                value: c.value,
                description: c.description,
                emoji: { name: c.emoji }
            }))
        }]);

        const payload = builder.build();
        let message;
        if (isSlash) {
            message = await interactionOrMessage.editReply({ ...payload, fetchReply: true });
        } else {
            message = await interactionOrMessage.reply(payload);
        }

        const collector = message.createMessageComponentCollector({
            filter: (i: any) => i.customId === 'color_select' && i.user.id === authorId,
            time: 60000
        });

        collector.on('collect', async (i: any) => {
            const selected = i.values[0];
            await i.deferUpdate();
            
            // Re-fetch user to ensure latest settings
            const latestUser = await prisma.user.findUnique({ where: { discordId: authorId } });
            await this.processColorChange(interactionOrMessage, isSlash, latestUser, selected, true, i.message);
            collector.stop('selected');
        });

        collector.on('end', async (collected: any, reason: string) => {
            if (reason !== 'selected') {
                const disabledBuilder = new ComponentsV2()
                    .setAccent(currentAccent)
                    .addText('## 🎨 Theme Customization\n*Selection timed out.*');
                
                if (isSlash) await interactionOrMessage.editReply(disabledBuilder.build());
                else await message.edit(disabledBuilder.build());
            }
        });
    }

    private async processColorChange(interactionOrMessage: any, isSlash: boolean, dbUser: any, input: string, fromMenu = false, menuMessage?: any) {
        const authorId = dbUser.discordId;
        let newSettings = JSON.parse(JSON.stringify(dbUser.settings || {}));

        if (['clear', 'none', 'reset', 'default'].includes(input.toLowerCase())) {
            delete newSettings.embedColor;
            await prisma.user.update({
                where: { discordId: authorId },
                data: { settings: newSettings }
            });
            
            const payload = new ComponentsV2().addText('✅ Cleared your custom embed color (reset to default).').build();
            if (fromMenu && menuMessage) return await menuMessage.edit(payload);
            return isSlash ? interactionOrMessage.editReply(payload) : interactionOrMessage.reply(payload);
        }

        // Resolve color: preset name or hex code
        const preset = PREMIUM_COLORS.find(c => c.value === input.toLowerCase() || c.label.toLowerCase() === input.toLowerCase());
        let hex = preset?.hex || null;
        
        if (!hex) {
            // Try as hex code
            let raw = input.trim();
            if (!raw.startsWith('#')) raw = '#' + raw;
            if (/^#[0-9A-Fa-f]{6}$/i.test(raw)) {
                hex = raw;
            }
        }
        
        if (!hex) {
            const payload = new ComponentsV2().setAccent(0xff0000)
                .addText(`❌ Unknown color. Use a valid preset or hex code.`)
                .build();
            if (fromMenu && menuMessage) return await menuMessage.edit(payload);
            return isSlash ? interactionOrMessage.editReply(payload) : interactionOrMessage.reply(payload);
        }

        newSettings.embedColor = hex;

        await prisma.user.update({
            where: { discordId: authorId },
            data: { settings: newSettings }
        });

        const accentInt = parseInt(hex.replace('#', ''), 16);
        const displayName = preset ? preset.label : input;

        const payload = new ComponentsV2()
            .setAccent(accentInt)
            .addText(`✅ Set your embed color to **${displayName}** (${hex}).`)
            .build();
        
        if (fromMenu && menuMessage) {
            await menuMessage.edit(payload);
        } else {
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);
        }
    }
}
