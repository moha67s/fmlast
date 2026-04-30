import {
  SettingService } from '../../services/bot/SettingService';
import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { CrownService } from '../../services/bot/CrownService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { TextChannel,
  ComponentType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder
} from "discord.js";

type CrownView = 'Playcount' | 'Recent' | 'Stolen';

export default class CrownsCommand extends BaseCommand {
    name = 'crowns';
    description = 'View the artists you have the most plays for in this server';
    aliases = ['crown', 'cw'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('crowns')
        .setDescription('View artists you have the most plays for in this server')
        .addUserOption((opt: any) => opt.setName('user').setDescription('The user to view crowns for'));

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const guildId = interactionOrMessage.guild?.id;
        if (!guildId) {
            const err = new ComponentsV2().setAccent(0xff0000).addText('❌ This command can only be used in a server.').build();
            if (isSlash) await interactionOrMessage.reply({ ...err, ephemeral: true });
            else await interactionOrMessage.channel.send(err);
            return;
        }

        // Determine target user
        let targetDiscordId: string;
        let targetDisplayName: string;
        if (isSlash) {
            const user = interactionOrMessage.options.getUser('user') || interactionOrMessage.user;
            targetDiscordId = user.id;
            targetDisplayName = user.globalName || user.username;
        } else {
            const mention = interactionOrMessage.mentions.users.first();
            const user = mention || interactionOrMessage.author;
            targetDiscordId = user.id;
            targetDisplayName = user.globalName || user.username;
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: targetDiscordId } });
        if (!dbUser) {
            const err = new ComponentsV2().setAccent(0xff0000).addText('❌ This user is not registered with the bot.').build();
            if (isSlash) await interactionOrMessage.reply({ ...err, ephemeral: true });
            else await interactionOrMessage.channel.send(err);
            return;
        }

        // State
        let currentPage = 1;
        let currentView: CrownView = 'Playcount';
        const perPage = 10;

        const generatePayload = (crowns: any[], page: number, view: CrownView) => {
            const builder = new ComponentsV2().setAccent(embedColor);
            const totalPages = Math.ceil(crowns.length / perPage) || 1;
            const start = (page - 1) * perPage;
            const slice = crowns.slice(start, start + perPage);

            if (crowns.length === 0) {
                builder.addText(`👑 **${targetDisplayName}** does not have any crowns in this server yet.`);
                return builder.build();
            }

            const list = slice.map((c: any, i: number) => {
                const uts = Math.floor(c.claimedAt.getTime() / 1000);
                return `${start + i + 1}. **${c.artistName}** — *${c.playcount.toLocaleString()} plays* — Claimed <t:${uts}:R>`;
            }).join('\n');

            builder.addText(`### Crowns for ${targetDisplayName}\n${list}`);
            builder.addText(`-# Page ${page}/${totalPages} - ${crowns.length} total crowns`);

            // Row 1: Paginator Buttons
            builder.addRow([
                { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'paginator_first', emoji: { id: '883825508633182208' }, disabled: page === 1 },
                { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'paginator_prev', emoji: { id: '883825508507336704' }, disabled: page === 1 },
                { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'paginator_next', emoji: { id: '883825508087922739' }, disabled: page === totalPages },
                { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'paginator_last', emoji: { id: '883825508482183258' }, disabled: page === totalPages }
            ]);

            // Row 2: Select Menu
            builder.addRow([{
                type: ComponentType.StringSelect,
                custom_id: 'user-crownpicker',
                placeholder: 'Select crown view',
                options: [
                    { label: 'Active crowns ordered by playcount', value: 'Playcount', default: view === 'Playcount' },
                    { label: 'Recently obtained crowns', value: 'Recent', default: view === 'Recent' },
                    { label: 'Recently stolen crowns', value: 'Stolen', default: view === 'Stolen' }
                ]
            }]);

            return builder.build();
        };

        // Initial Fetch
        let crowns = await CrownService.getUserCrowns(guildId, targetDiscordId, currentView);
        const initialPayload = generatePayload(crowns, currentPage, currentView);

        let message: any;
        if (isSlash) message = await interactionOrMessage.reply({ ...initialPayload, fetchReply: true });
        else message = await interactionOrMessage.channel.send(initialPayload);

        // Collector
        const collector = message.createMessageComponentCollector({
            filter: (i: any) => i.user.id === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id),
            time: 120000 // 2 minutes
        });

        collector.on('collect', async (i: any) => {
            if (i.customId.startsWith('paginator_')) {
                const totalPages = Math.ceil(crowns.length / perPage);
                if (i.customId === 'paginator_first') currentPage = 1;
                else if (i.customId === 'paginator_prev') currentPage = Math.max(1, currentPage - 1);
                else if (i.customId === 'paginator_next') currentPage = Math.min(totalPages, currentPage + 1);
                else if (i.customId === 'paginator_last') currentPage = totalPages;
            } else if (i.customId === 'user-crownpicker') {
                currentView = i.values[0] as CrownView;
                currentPage = 1;
                crowns = await CrownService.getUserCrowns(guildId, targetDiscordId, currentView);
            }

            await i.update(generatePayload(crowns, currentPage, currentView));
        });

        collector.on('end', () => {
            // Disable buttons on timeout
            try {
                const disabledBuilder = new ComponentsV2().setAccent(embedColor);
                const totalPages = Math.ceil(crowns.length / perPage) || 1;
                const start = (currentPage - 1) * perPage;
                const slice = crowns.slice(start, start + perPage);

                if (crowns.length > 0) {
                    const list = slice.map((c: any, i: number) => {
                        const uts = Math.floor(c.claimedAt.getTime() / 1000);
                        return `${start + i + 1}. **${c.artistName}** — *${c.playcount.toLocaleString()} plays* — Claimed <t:${uts}:R>`;
                    }).join('\n');
                    disabledBuilder.addText(`### Crowns for ${targetDisplayName}\n${list}`);
                    disabledBuilder.addText(`-# Page ${currentPage}/${totalPages} - ${crowns.length} total crowns`);
                } else {
                    disabledBuilder.addText(`👑 **${targetDisplayName}** does not have any crowns in this server yet.`);
                }

                message.edit(disabledBuilder.build()).catch(() => {});
            } catch (err) {}
        });
    }
}
