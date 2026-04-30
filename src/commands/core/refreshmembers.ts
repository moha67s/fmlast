import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class RefreshMembersCommand extends BaseCommand {
    name = 'refreshmembers';
    description = 'Refreshes the cached member list that the bot has for your server';
    aliases = [];

    slashData = new SlashCommandBuilder()
        .setName('refreshmembers')
        .setDescription('Refreshes the cached member list for your server')
        .setDMPermission(false);

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const guild = interactionOrMessage.guild;
        if (!guild) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ This command can only be used in a server.').build();
            return isSlash ? interactionOrMessage.reply({ ...payload, ephemeral: true }) : interactionOrMessage.reply(payload);
        }

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();
        else if (!isSlash) await interactionOrMessage.channel.sendTyping();

        try {
            // Fetch all members
            const members = await guild.members.fetch();
            
            // First, ensure the guild exists in our DB
            const dbGuild = await prisma.guild.upsert({
                where: { guildId: guild.id },
                create: { guildId: guild.id },
                update: {}
            });

            // Find all registered users in this server
            const dbUsers = await prisma.user.findMany({
                where: {
                    discordId: {
                        in: Array.from(members.keys())
                    }
                }
            });

            let registeredCount = 0;

            // Update GuildMember link for all registered users found
            for (const dbUser of dbUsers) {
                await prisma.guildMember.upsert({
                    where: {
                        guildId_userId: {
                            guildId: dbGuild.id,
                            userId: dbUser.id
                        }
                    },
                    create: {
                        guildId: dbGuild.id,
                        userId: dbUser.id
                    },
                    update: {}
                });
                registeredCount++;
            }

            const builder = new ComponentsV2()
                .setAccent(embedColor)
                .addText(`✅ Cached memberlist for server has been updated.\n\nThis server has a total of **${registeredCount}** registered bot members.`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error('Refresh members error:', err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText(`❌ Failed to refresh members: ${err.message}`).build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }
}
