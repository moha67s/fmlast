import { BaseCommand } from '../../structures/BaseCommand';
import { Discogs } from '../../services/api/Discogs';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, TextChannel } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class DiscogsCommand extends BaseCommand {
    name = 'discogs';
    description = 'Discogs vinyl collection tracking and search';
    aliases = ['dc'];

    slashData = new SlashCommandBuilder()
        .setName('discogs')
        .setDescription('Discogs vinyl collection tracking and search')
        .addSubcommand(sub => 
            sub.setName('login')
               .setDescription('Link your Discogs account')
               .addStringOption(opt => opt.setName('username').setDescription('Your Discogs username').setRequired(true))
        )
        .addSubcommand(sub => 
            sub.setName('collection')
               .setDescription('View your Discogs vinyl collection')
               .addStringOption(opt => opt.setName('username').setDescription('Optional: Another user').setRequired(false))
        )
        .addSubcommand(sub =>
            sub.setName('wantlist')
               .setDescription('View your Discogs wantlist')
               .addStringOption(opt => opt.setName('username').setDescription('Optional: Another user').setRequired(false))
        )
        .addSubcommand(sub => 
            sub.setName('search')
               .setDescription('Search for a vinyl release')
               .addStringOption(opt => opt.setName('query').setDescription('Artist and album name').setRequired(true))
        );

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {

        let sub = '';
        let query = '';

        if (isSlash) {
            sub = interactionOrMessage.options.getSubcommand();
            query = interactionOrMessage.options.getString('username') || interactionOrMessage.options.getString('query') || '';
            await interactionOrMessage.deferReply();
        } else {
            sub = args[0]?.toLowerCase() || '';
            query = args.slice(1).join(' ');
            if (['login', 'collection', 'wantlist', 'search'].includes(sub)) {
                try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch {}
            } else {
                return this.handleFallback(interactionOrMessage, isSlash);
            }
        }

        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

        switch (sub) {
            case 'login':
                return this.handleLogin(interactionOrMessage, isSlash, userId, query);
            case 'collection':
                return this.handleCollection(interactionOrMessage, isSlash, userId, query);
            case 'wantlist':
                return this.handleWantlist(interactionOrMessage, isSlash, userId, query);
            case 'search':
                return this.handleSearch(interactionOrMessage, isSlash, query);
            default:
                return this.handleFallback(interactionOrMessage, isSlash);
        }
    }

    private async handleFallback(interactionOrMessage: any, isSlash: boolean) {
        const msg = '❌ Invalid subcommand. Use `login`, `collection`, `wantlist`, or `search`.';
        if (isSlash) await interactionOrMessage.editReply(msg);
        else await interactionOrMessage.reply(msg);
    }

    private async handleLogin(interactionOrMessage: any, isSlash: boolean, discordId: string, query: string) {
        if (!query) {
            const msg = '❌ Please provide a Discogs username. Example: `.discogs login Johndoe`';
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        const isValid = await Discogs.verifyUser(query);
        if (!isValid) {
            const msg = `❌ Could not find a Discogs user named **${query}**.`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        await prisma.user.upsert({
            where: { discordId },
            create: { discordId, discogsUsername: query },
            update: { discogsUsername: query }
        });

        const b = new ComponentsV2()
            .addText(`✅ Successfully linked your Discogs account to **${query}**!`)
            .build();

        if (isSlash) await interactionOrMessage.editReply(b);
        else await interactionOrMessage.reply(b);
    }

    private async resolveDiscogsUser(discordId: string, query: string): Promise<string | null> {
        if (query) return query; // If target user provided
        // Try DB
        const dbUser = await prisma.user.findUnique({ where: { discordId } });
        return dbUser?.discogsUsername || null;
    }

    private async handleCollection(interactionOrMessage: any, isSlash: boolean, discordId: string, query: string) {
        const username = await this.resolveDiscogsUser(discordId, query);
        if (!username) {
            const msg = '❌ You have not linked a Discogs account! Use `.discogs login <username>` first.';
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        const data = await Discogs.getCollection(username, 1, 10);
        if (!data.items || data.items.length === 0) {
            const msg = `❌ No collection tracks found for **${username}**.`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        const total = data.pagination?.items || data.items.length;
        const totalPages = data.pagination?.pages || 1;

        const trackLines = data.items.map((item: any, i: number) => {
            const r = item.basic_information;
            return `${i + 1}. **${r.title}** - *${r.artists?.[0]?.name || 'Unknown Artist'}* (${r.year || '?'})`;
        }).join('\n');

        const userAvatar = isSlash ? interactionOrMessage.user.displayAvatarURL() : interactionOrMessage.author.displayAvatarURL();
        const builder = new ComponentsV2()
            .addThumbnail(userAvatar, `### 💿 ${username}'s Vinyl Collection\n${trackLines}\n-# Total records: ${total}`)
            .addRow([
                { type: 2, style: 2, label: '⬅️', custom_id: `discogs-page:prev:1:${discordId}:${username}:collection`, disabled: true },
                { type: 2, style: 2, label: `1 / ${totalPages}`, custom_id: 'dummy', disabled: true },
                { type: 2, style: 2, label: '➡️', custom_id: `discogs-page:next:1:${discordId}:${username}:collection`, disabled: totalPages <= 1 }
            ]);

        if (isSlash) await interactionOrMessage.editReply(builder.build());
        else await interactionOrMessage.reply(builder.build());
    }

    private async handleWantlist(interactionOrMessage: any, isSlash: boolean, discordId: string, query: string) {
        const username = await this.resolveDiscogsUser(discordId, query);
        if (!username) {
            const msg = '❌ You have not linked a Discogs account! Use `.discogs login <username>` first.';
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        const data = await Discogs.getWantlist(username, 1, 10);
        if (!data.items || data.items.length === 0) {
            const msg = `❌ No wantlist tracks found for **${username}**.`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        const total = data.pagination?.items || data.items.length;
        const totalPages = data.pagination?.pages || 1;

        const trackLines = data.items.map((item: any, i: number) => {
            const r = item.basic_information;
            return `${i + 1}. **${r.title}** - *${r.artists?.[0]?.name || 'Unknown Artist'}* (${r.year || '?'})`;
        }).join('\n');

        const userAvatar = isSlash ? interactionOrMessage.user.displayAvatarURL() : interactionOrMessage.author.displayAvatarURL();
        const builder = new ComponentsV2()
            .setAccent(0xff0000)
            .addThumbnail(userAvatar, `### ❤️ ${username}'s Vinyl Wantlist\n${trackLines}\n-# Total wanted: ${total}`)
            .addRow([
                { type: 2, style: 2, label: '⬅️', custom_id: `discogs-page:prev:1:${discordId}:${username}:wantlist`, disabled: true },
                { type: 2, style: 2, label: `1 / ${totalPages}`, custom_id: 'dummy', disabled: true },
                { type: 2, style: 2, label: '➡️', custom_id: `discogs-page:next:1:${discordId}:${username}:wantlist`, disabled: totalPages <= 1 }
            ]);

        if (isSlash) await interactionOrMessage.editReply(builder.build());
        else await interactionOrMessage.reply(builder.build());
    }

    private async handleSearch(interactionOrMessage: any, isSlash: boolean, query: string) {
        if (!query) {
            const msg = '❌ Please provide a query to search. Example: `.discogs search blond frank ocean`';
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        const item = await Discogs.searchRelease(query);
        if (!item) {
            const msg = `❌ Discogs couldn't find a record for **${query}**!`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
            return;
        }

        const splitTitle = item.title.split(' - ');
        const artist = splitTitle.length > 1 ? splitTitle[0] : 'Unknown';
        const album = splitTitle.length > 1 ? splitTitle[1] : item.title;

        let meta = `**Year**: ${item.year || '?'}\n`;
        if (item.label && item.label.length) meta += `**Label**: ${item.label.join(', ')}\n`;
        if (item.format && item.format.length) meta += `**Format**: ${item.format.join(', ')}\n`;
        if (item.style && item.style.length) meta += `**Style**: ${item.style.join(', ')}\n`;
        if (item.community) meta += `-# ❤️ ${item.community.want} wants • 💿 ${item.community.have} have`;

        const b = new ComponentsV2()
            .setAccent(0x000000)
            .addFullImage(item.cover_image || item.thumb || '', `### 💿 ${artist} - ${album}\n${meta}`)
            .addLinkButton('Discogs', 'Open on Discogs', `https://discogs.com${item.uri || item.master_url || ''}`)
            .build();

        if (isSlash) await interactionOrMessage.editReply(b);
        else await interactionOrMessage.reply(b);
    }
}
