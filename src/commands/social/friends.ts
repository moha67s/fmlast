import {
  BaseCommand } from '../../structures/BaseCommand';
import { FriendService } from '../../services/bot/FriendService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";

export default class FriendsCommand extends BaseCommand {
    name = 'friends';
    description = 'Manage your Last.fm friends';
    aliases = ['friend'];

    slashData = new SlashCommandBuilder()
        .setName('friends')
        .setDescription('Manage your Last.fm friends')
        .addSubcommand(subcmd =>
            subcmd.setName('add')
            .setDescription('Send a friend request to a user')
            .addUserOption(opt => opt.setName('user').setDescription('The user to add').setRequired(true))
        )
        .addSubcommand(subcmd =>
            subcmd.setName('remove')
            .setDescription('Remove a friend')
            .addUserOption(opt => opt.setName('user').setDescription('The user to remove').setRequired(true))
        )
        .addSubcommand(subcmd =>
            subcmd.setName('list')
            .setDescription('List your accepted friends')
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {

        let subcommand = '';
        let targetUser: any = null;

        if (isSlash) {
            subcommand = interactionOrMessage.options.getSubcommand();
            if (subcommand === 'add' || subcommand === 'remove') {
                targetUser = interactionOrMessage.options.getUser('user');
            }
        } else {
            subcommand = args?.[0]?.toLowerCase() || '';
            const mentionStr = args?.[1] || '';
            const mentionMatch = mentionStr.match(/<@!?(\d+)>/);
            const targetId = mentionMatch ? mentionMatch[1] : mentionStr;

            if ((subcommand === 'add' || subcommand === 'remove') && targetId) {
                targetUser = await interactionOrMessage.client.users.fetch(targetId).catch(() => null);
            }
        }

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;

        if (!subcommand || (subcommand !== 'add' && subcommand !== 'remove' && subcommand !== 'list')) {
            const reply = '❌ Invalid subcommand. Use `add`, `remove`, or `list` (`/friends add @user`).';
            return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
        }

        try {
            if (subcommand === 'add') {
                if (!targetUser) throw new Error("Please specify a valid user to add.");
                
                const req = await FriendService.sendRequest(author.id, targetUser.id);
                
                // Send the interactive request to the channel with ping, or defer reply if slash
                const builder = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`### ✉️ Friend Request\n<@${targetUser.id}>, **${author.username}** wants to be your friend on Last.fm!`)
                    .addRow([
                        { type: ComponentType.Button, custom_id: 'friend-accept:' + req.id, label: 'Accept', style: ButtonStyle.Success },
                        { type: ComponentType.Button, custom_id: 'friend-deny:' + req.id, label: 'Decline', style: ButtonStyle.Danger }
                    ]);

                const payload = builder.build();
                
                if (isSlash) {
                    await interactionOrMessage.reply(payload);
                } else {
                    await interactionOrMessage.reply(payload);
                }
            } 
            else if (subcommand === 'remove') {
                if (!targetUser) throw new Error("Please specify a valid user to remove.");
                
                await FriendService.removeFriend(author.id, targetUser.id);
                const reply = `✅ You are no longer friends with **${targetUser.username}**.`;
                return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
            } 
            else if (subcommand === 'list') {
                const friends = await FriendService.getFriends(author.id);

                if (friends.length === 0) {
                    const reply = `You don't have any friends yet! Use \`/friends add @user\` to add someone.`;
                    return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
                }

                let desc = '';
                for (let i = 0; i < friends.length; i++) {
                    desc += `**${i + 1}.** <@${friends[i].discordId}> — \`${friends[i].lastfmUsername}\`\n`;
                }

                const builder = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`### 🫂 Your Friends\n${desc}`);

                const payload = builder.build();
                payload.ephemeral = true;

                if (isSlash) {
                    await interactionOrMessage.reply(payload);
                } else {
                    await interactionOrMessage.author.send(payload).catch(() => {
                        interactionOrMessage.reply("❌ I couldn't DM you your friend list. Are your DMs open?");
                    });
                }
            }
        } catch (err: any) {
            const reply = `❌ **Error:** ${err.message}`;
            return isSlash ? interactionOrMessage.reply({ content: reply, ephemeral: true }) : interactionOrMessage.reply(reply);
        }
    }
}
