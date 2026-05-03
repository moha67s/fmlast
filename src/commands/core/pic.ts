import { BaseCommand } from '../../structures/BaseCommand';
import { SlashCommandBuilder, AttachmentBuilder, TextChannel } from 'discord.js';
import { existsSync, readdirSync } from 'fs';
import { basename, join, resolve } from 'path';

// Pics folder lives at project root: /pics/
const PICS_DIR = resolve(__dirname, '../../../pics');

export default class PicCommand extends BaseCommand {
    name = 'pic';
    description = 'Send a picture from the pics folder to a channel';
    aliases = ['sendpic', 'img'];

    slashData = new SlashCommandBuilder()
        .setName('pic')
        .setDescription('Send a picture from the pics folder to a channel')
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('Filename of the pic (e.g. cat.png) — or "list" to see all pics')
                .setRequired(true)
        )
        .addChannelOption(opt =>
            opt.setName('channel')
                .setDescription('Channel to send the pic to (defaults to current channel)')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        let fileName = '';
        let targetChannelId = '';

        if (isSlash) {
            fileName = interactionOrMessage.options.getString('name', true);
            const channelOpt = interactionOrMessage.options.getChannel('channel');
            if (channelOpt) targetChannelId = channelOpt.id;
        } else {
            // Prefix: !pic <filename>  OR  !pic <channelId> <filename>
            const input = args ? args.join(' ') : '';
            const match = input.match(/^(\d{17,20})\s+(.+)$/);
            if (match) {
                targetChannelId = match[1];
                fileName = match[2];
            } else {
                fileName = input;
            }
        }

        if (!fileName) {
            const msg = '❌ Give me a filename! e.g. `!pic cat.png`\nUse `!pic list` to see available pics.';
            if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
            else await interactionOrMessage.channel.send(msg);
            return;
        }

        // List all available pics
        if (fileName.toLowerCase() === 'list') {
            const files = existsSync(PICS_DIR)
                ? readdirSync(PICS_DIR).filter(f => !f.startsWith('.'))
                : [];
            const msg = files.length
                ? `📂 **Available pics:**\n${files.map(f => `• \`${f}\``).join('\n')}`
                : '📂 No pics found! Add images to the `pics/` folder.';
            if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
            else await interactionOrMessage.channel.send(msg);
            return;
        }

        const filePath = join(PICS_DIR, fileName);

        // Prevent path traversal
        if (!resolve(filePath).startsWith(PICS_DIR)) {
            const msg = '❌ Nice try lol';
            if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
            else await interactionOrMessage.channel.send(msg);
            return;
        }

        if (!existsSync(filePath)) {
            const msg = `❌ File not found: \`${fileName}\`\nUse \`!pic list\` to see available pics.`;
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
            targetChannel = isSlash ? interactionOrMessage.channel : interactionOrMessage.channel;
        }

        const attachment = new AttachmentBuilder(filePath, { name: basename(filePath) });

        // Send it plain — just the image like a normal user
        await targetChannel.send({ files: [attachment] });

        // Confirm if sending to a different channel
        if (targetChannelId && targetChannel.id !== (isSlash ? interactionOrMessage.channelId : interactionOrMessage.channel.id)) {
            const msg = `✅ Sent to <#${targetChannel.id}>!`;
            if (isSlash) await interactionOrMessage.reply({ content: msg, flags: 64 });
            else await interactionOrMessage.reply(msg);
        } else if (isSlash) {
            await interactionOrMessage.reply({ content: '✅ Sent!', flags: 64 });
        }
    }
}
