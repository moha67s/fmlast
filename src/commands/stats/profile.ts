import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { resolveTargetUser } from '../../utils/userResolver';
import { ProfileService } from '../../services/bot/ProfileService';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';

export default class ProfileCommand extends BaseCommand {
    name = 'profile';
    description = 'View your Last.fm profile stats';
    aliases = ['user', 'stats', 'me'];

    slashData = new SlashCommandBuilder()
        .setName('profile')
        .setDescription('View your Last.fm profile stats')
        .addUserOption((opt: any) =>
            opt.setName('user')
                .setDescription("View another user's profile")
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        if (isSlash) {
            await interactionOrMessage.deferReply();
        } else {
            try { interactionOrMessage.channel.sendTyping(); } catch {}
        }

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const invokerDiscordId = isSlash
            ? interactionOrMessage.user.id
            : interactionOrMessage.author.id;

        const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });

        if (!dbUser?.lastfmUsername) {
            const isSelf = targetUser.id === invokerDiscordId;
            const msg = isSelf
                ? '❌ You are not linked to Last.fm yet.\nRun `/login` first!'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;

            const payload = new ComponentsV2().addText(msg).build();
            if (isSlash) await interactionOrMessage.editReply({ ...payload, ephemeral: true });
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        // Fire & Forget background sync
        triggerDeltaSync(targetUser.id);

        try {
            const payload = await ProfileService.buildProfilePayload(dbUser, invokerDiscordId);
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        } catch (err: any) {
            console.error('[profile] error:', err);
            const msg = `❌ Failed to fetch profile: ${err.message}`;
            if (isSlash) await interactionOrMessage.editReply({ content: msg });
            else await interactionOrMessage.channel.send(msg);
        }
    }
}
