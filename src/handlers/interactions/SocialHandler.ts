import { Interaction, Client } from 'discord.js';
import { BaseInteractionHandler } from './BaseInteractionHandler';
import { prisma } from '../../database/client';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { LoggerService } from '../../services/bot/LoggerService';

export class SocialHandler extends BaseInteractionHandler {
    
    canHandle(customId: string): boolean {
        return customId.startsWith('friend-');
    }

    async handle(interaction: Interaction, client: Client): Promise<void> {
        if (!interaction.isButton()) return;

        try {
            const parts = interaction.customId.split(':');
            const action = parts[0]; // 'friend-accept' or 'friend-deny'
            const requestId = parts[1];

            const req = await prisma.friend.findUnique({ 
                where: { id: requestId }, 
                include: { user: true, friend: true } 
            });
            
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
        } catch (err) {
            LoggerService.error('SocialHandler Error', err, 'SocialHandler');
            throw err;
        }
    }
}
