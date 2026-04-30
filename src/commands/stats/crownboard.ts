import {
  BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder,
  TextChannel,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { Prisma } from '@prisma/client';
import { SettingService } from '../../services/bot/SettingService';

export default class CrownboardCommand extends BaseCommand {
    name = 'crownboard';
    description = 'View the ranking of who has the most crowns in this server.';
    aliases = ['cb', 'crownleaderboard'];

    slashData = new SlashCommandBuilder()
        .setName('crownboard')
        .setDescription('View the ranking of who has the most crowns in this server.');

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const guild = interactionOrMessage.guild;
        if (!guild) {
            const reply = '❌ This command can only be used in a server.';
            return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else { try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { } }

        try {
            // Group crowns by user in this guild natively
            const crownCounts: any[] = await prisma.$queryRaw`
                SELECT c.user_id as "userId", COUNT(c.id) as "totalCrowns", u.discord_id as "discordId", u.lastfm_username as "lastfmUsername"
                FROM crowns c
                JOIN users u ON c.user_id = u.id
                WHERE c.guild_id = ${guild.id}
                GROUP BY c.user_id, u.discord_id, u.lastfm_username
                ORDER BY "totalCrowns" DESC
            `;

            if (crownCounts.length === 0) {
                const msg = '❌ No one in this server has any crowns yet! Earn some by using `/whoknows`.';
                return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.reply(msg);
            }

            // We could have 100 users with crowns, so we should paginate.
            const perPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(crownCounts.length / perPage) || 1;

            // Pre-fetch all member names for the users we found
            const discordIds = crownCounts.map(c => c.discordId).filter(Boolean);
            let members;
            try {
                members = await guild.members.fetch({ user: discordIds });
            } catch (e) {
                // Ignore error, members will be missing and we'll fallback to LastFM name
            }

            const generatePayload = (page: number) => {
                const builder = new ComponentsV2().setAccent(embedColor); // Gold accent for crowns
                const start = (page - 1) * perPage;
                const slice = crownCounts.slice(start, start + perPage);

                const list = slice.map((c: any, i: number) => {
                    const rank = start + i + 1;
                    const member = members ? members.get(c.discordId) : null;
                    const name = member?.displayName || c.lastfmUsername || 'Unknown';
                    const crownWord = parseInt(c.totalCrowns) === 1 ? 'crown' : 'crowns';
                    return `**${rank}.** [${name}](https://last.fm/user/${c.lastfmUsername}) - **${parseInt(c.totalCrowns).toLocaleString()}** ${crownWord}`;
                }).join('\n');

                builder.addText(`### 👑 Crown Leaderboard for ${guild.name}\n${list}`);
                builder.addText(`-# Page ${page}/${totalPages} - ${crownCounts.length} crown holders`);

                if (totalPages > 1) {
                    builder.addRow([
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'cb_first', emoji: { id: '883825508633182208' }, disabled: page === 1 },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'cb_prev', emoji: { id: '883825508507336704' }, disabled: page === 1 },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'cb_next', emoji: { id: '883825508087922739' }, disabled: page === totalPages },
                        { type: ComponentType.Button, style: ButtonStyle.Secondary, custom_id: 'cb_last', emoji: { id: '883825508482183258' }, disabled: page === totalPages }
                    ]);
                }

                if (guild.iconURL()) {
                    builder.addThumbnail(guild.iconURL({ extension: 'png', size: 256 })!);
                }

                return builder.build();
            };

            const initialPayload = generatePayload(currentPage);
            const message = isSlash 
                ? await interactionOrMessage.editReply({ ...initialPayload, fetchReply: true })
                : await interactionOrMessage.reply(initialPayload);

            if (totalPages > 1) {
                const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
                const collector = message.createMessageComponentCollector({
                    filter: (i: any) => i.user.id === authorId,
                    time: 60000
                });

                collector.on('collect', async (i: any) => {
                    if (i.customId === 'cb_first') currentPage = 1;
                    else if (i.customId === 'cb_prev') currentPage = Math.max(1, currentPage - 1);
                    else if (i.customId === 'cb_next') currentPage = Math.min(totalPages, currentPage + 1);
                    else if (i.customId === 'cb_last') currentPage = totalPages;
                    
                    await i.update(generatePayload(currentPage));
                });
            }

        } catch (err: any) {
            console.error('[crownboard] error:', err);
            const msg = `❌ Failed to fetch crown leaderboard.`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
        }
    }
}
