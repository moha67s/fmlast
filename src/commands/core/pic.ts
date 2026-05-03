import { BaseCommand } from '../../structures/BaseCommand';
import { SlashCommandBuilder, AttachmentBuilder, TextChannel } from 'discord.js';
import { existsSync } from 'fs';
import { basename } from 'path';

export default class PicCommand extends BaseCommand {
    name = 'pic';
    description = 'Send a picture from the bot\'s PC to a channel';
    aliases = ['sendpic', 'img'];

    slashData = new SlashCommandBuilder()
        .setName('pic')
        .setDescription('Send a picture from the bot\'s PC to a channel')
        .addStringOption(opt =>
            opt.setName('path')
                .setDescription('Full file path to the image (e.g. C:\\Users\\user\\Pictures\\cat.png)')
                .setRequired(true)
        )
        .addChannelOption(opt =>
            opt.setName('channel')
                .setDescription('Channel to send the pic to (defaults to current channel)')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        let filePath = '';
        let targetChannelId = '';

        if (isSlash) {
            filePath = interactionOrMessage.options.getString('path', true);
            const channelOpt = interactionOrMessage.options.getChannel('channel');
            if (channelOpt) targetChannelId = channelOpt.id;
        } else {
            // Prefix usage: !pic <channelId> <path>  OR  !pic <path> (uses current channel)
            const input = args ? args.join(' ') : '';
            const match = input.match(/^(\d{17,20})\s+(.+)$/);
            if (match) {
                targetChannelId = match[1];
                filePath = match[2];
            } else {
                filePath = input;
            }
        }

        if (!filePath) {
            const msg = '❌ Give me a file path!\ne.g. `!pic C:\\Users\\user\\Pictures\\cat.png`\nor `!pic 123456789012345678 C:\\Users\\moha\\Pictures\\cat.png`';
            if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
            else await interactionOrMessage.channel.send(msg);
            return;
        }

        // Clean up quotes if the user wrapped the path
        filePath = filePath.replace(/^["']|["']$/g, '');

        if (!existsSync(filePath)) {
            const msg = `❌ File not found: \`${filePath}\``;
            if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
            else await interactionOrMessage.channel.send(msg);
            return;
        }

        // Resolve target channel
        const client = interactionOrMessage.client;
        let targetChannel: TextChannel;

        if (targetChannelId) {
            const fetched = await client.channels.fetch(targetChannelId).catch(() => null);
            if (!fetched || !fetched.isTextBased()) {
                const msg = `❌ Can't find or send to channel \`${targetChannelId}\``;
                if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
                else await interactionOrMessage.channel.send(msg);
                return;
            }
            targetChannel = fetched as TextChannel;
        } else {
            // Default to current channel
            targetChannel = isSlash ? interactionOrMessage.channel : interactionOrMessage.channel;
        }

        const attachment = new AttachmentBuilder(filePath, { name: basename(filePath) });

        // Send the pic to the target channel — plain, no embed, just like a normal user
        await targetChannel.send({ files: [attachment] });

        // If sending to a different channel, confirm it
        if (targetChannelId && targetChannel.id !== (isSlash ? interactionOrMessage.channelId : interactionOrMessage.channel.id)) {
            const msg = `✅ Sent to <#${targetChannel.id}>!`;
            if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
            else await interactionOrMessage.reply(msg);
        } else if (isSlash) {
            // If slash + same channel, reply ephemeral so the slash interaction doesn't hang
            await interactionOrMessage.reply({ content: '✅ Sent!', flags: 64 });
        }
    }
}
