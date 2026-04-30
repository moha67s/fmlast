import { BaseCommand } from '../../structures/BaseCommand';
import { prisma } from '../../database/client';
import { SlashCommandBuilder, ComponentType, ButtonStyle } from 'discord.js';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SettingService } from '../../services/bot/SettingService';

export default class CountryChartCommand extends BaseCommand {
    name = 'country';
    description = 'View your top countries by scrobbles';
    aliases = ['countries', 'cc'];

    slashData = new SlashCommandBuilder()
        .setName('country')
        .setDescription('View top countries by scrobbles')
        .addStringOption((opt: any) => 
            opt.setName('query')
                .setDescription('User mention or username')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        const query = isSlash 
            ? interactionOrMessage.options.getString('query') || '' 
            : (args ? args.join(' ') : '');

        const author = isSlash ? interactionOrMessage.user : interactionOrMessage.author;
        
        const dbAuthor = await prisma.user.findUnique({ where: { discordId: author.id } });
        if (!dbAuthor) {
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Link your Last.fm first!').build();
            if (isSlash) await interactionOrMessage.reply(payload);
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        const userSettings = await SettingService.getUser(query, dbAuthor);
        const targetDbUser = userSettings.targetUser;

        if (isSlash && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        try {
            // 1. Fetch Country Stats using raw query for performance/join
            // Note: We cast SUM to BIGINT because Postgres returns it as bigint
            const stats: any[] = await prisma.$queryRaw`
                SELECT a.country_code as country, CAST(SUM(ua.playcount) AS INTEGER) as count
                FROM user_artists ua
                JOIN artists a ON ua.artist_id = a.id
                WHERE ua.user_id = ${targetDbUser.id} AND a.country_code IS NOT NULL
                GROUP BY a.country_code
                ORDER BY count DESC
                LIMIT 20
            `;

            if (stats.length === 0) {
                const payload = new ComponentsV2().addText(`**${userSettings.displayName}** has no country metadata for their artists yet. The background worker is enriching data...`).build();
                if (isSlash) await interactionOrMessage.editReply(payload);
                else await interactionOrMessage.channel.send(payload);
                return;
            }

            // 2. Build Response
            const builder = new ComponentsV2().setAccent(embedColor);
            builder.addText(`### Top Countries for ${userSettings.displayName}`);

            const list = stats.map((s, i) => {
                const rank = i + 1;
                const flag = s.country ? `:${s.country.toLowerCase()}:` : '🏳️'; // Discord emoji flags use :us:, :gb:, etc.
                // Fallback for some common codes that might not match Discord emojis directly
                const flagEmoji = this.getFlagEmoji(s.country);
                return `${rank}.\u2004\u2005${flagEmoji} **${s.country}** — **${s.count.toLocaleString()}** plays`;
            }).join('\n');

            builder.addText(list);
            builder.addText(`\n-# Metadata is enriched by MusicBrainz via background worker.`);

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);

        } catch (err) {
            console.error(err);
            const payload = new ComponentsV2().setAccent(0xff0000).addText('❌ Failed to fetch country stats.').build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.channel.send(payload);
        }
    }

    private getFlagEmoji(countryCode: string): string {
        const codePoints = countryCode
            .toUpperCase()
            .split('')
            .map(char => 127397 + char.charCodeAt(0));
        return String.fromCodePoint(...codePoints);
    }
}
