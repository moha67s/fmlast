import { Interaction, Client, ComponentType, ButtonStyle } from 'discord.js';
import { BaseInteractionHandler } from './BaseInteractionHandler';
import { Discogs } from '../../services/api/Discogs';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { LoggerService } from '../../services/bot/LoggerService';

export class DiscogsHandler extends BaseInteractionHandler {
    
    canHandle(customId: string): boolean {
        return customId.startsWith('discogs-page:');
    }

    async handle(interaction: Interaction, client: Client): Promise<void> {
        if (!interaction.isButton()) return;

        try {
            const parts = interaction.customId.split(':');
            const direction = parts[1];
            const currentPage = parseInt(parts[2]);
            const discordId = parts[3];
            const username = parts[4];
            const type = parts[5]; // 'collection' or 'wantlist'

            if (interaction.user.id !== discordId) return;

            const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
            await interaction.deferUpdate();

            const data = type === 'collection' 
                ? await Discogs.getCollection(username, newPage, 10)
                : await Discogs.getWantlist(username, newPage, 10);

            if (!data.items || data.items.length === 0) return;

            const total = data.pagination?.items || data.items.length;
            const totalPages = data.pagination?.pages || 1;

            const trackLines = data.items.map((item: any, i: number) => {
                const r = item.basic_information;
                return `${(newPage - 1) * 10 + i + 1}. **${r.title}** - *${r.artists?.[0]?.name || 'Unknown Artist'}* (${r.year || '?'})`;
            }).join('\n');

            const title = type === 'collection' ? `💿 ${username}'s Vinyl Collection` : `❤️ ${username}'s Vinyl Wantlist`;
            const builder = new ComponentsV2()
                .addThumbnail(interaction.user.displayAvatarURL(), `### ${title}\n${trackLines}\n-# Total records: ${total}`)
                .addRow([
                    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '⬅️', custom_id: `discogs-page:prev:${newPage}:${discordId}:${username}:${type}`, disabled: newPage === 1 },
                    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: `${newPage} / ${totalPages}`, custom_id: 'dummy', disabled: true },
                    { type: ComponentType.Button, style: ButtonStyle.Secondary, label: '➡️', custom_id: `discogs-page:next:${newPage}:${discordId}:${username}:${type}`, disabled: newPage === totalPages }
                ]);

            await interaction.editReply(builder.build());
        } catch (err) {
            LoggerService.error('DiscogsHandler Error', err, 'DiscogsHandler');
            throw err;
        }
    }
}
