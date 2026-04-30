import {
  BaseCommand } from '../../structures/BaseCommand';
import { Youtube } from '../../services/api/Youtube';
import { LastFM } from '../../services/api/LastFM';
import { prisma } from '../../database/client';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { ComponentsV2 } from '../../utils/ComponentsV2';

export default class YoutubeCommand extends BaseCommand {
    name = 'youtube';
    description = 'Search for a music video on YouTube';
    aliases = ['yt', 'video', 'mv'];

    slashData = new SlashCommandBuilder()
        .setName('youtube')
        .setDescription('Search for a music video on YouTube')
        .addStringOption(option =>
            option.setName('query')
                .setDescription('The song to search for (Artist - Track)')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args: string[] = []): Promise<void> {
        const isPrefix = !isSlash;
        if (!isPrefix && !interactionOrMessage.deferred) await interactionOrMessage.deferReply();

        let query = args.join(' ');
        if (isSlash && !query && interactionOrMessage.options) {
            query = interactionOrMessage.options.getString('query') || '';
        }
        let artistName = '';
        let trackTitle = '';

        try {
            // 1. If no query, find user's current track
            if (!query) {
                const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
                const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

                if (!dbUser?.lastfmUsername) {
                    const msg = '❌ You must be logged in to Last.fm to search for your current track, or provide a search query!';
                    if (isSlash) await interactionOrMessage.editReply(msg);
                    else await interactionOrMessage.reply(msg);
                    return;
                }

                const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey || undefined);
                if (tracks && tracks.length > 0) {
                    const track = tracks[0];
                    artistName = track.artist['#text'];
                    trackTitle = track.name;
                    query = `${artistName} - ${trackTitle}`;
                }
            }

            if (!query) {
                const msg = '❌ Please provide a song to search for!';
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // 2. Perform search
            const result = await Youtube.search(query);

            if (!result) {
                const msg = `❌ I couldn't find any YouTube videos for **${query}**.`;
                if (isSlash) await interactionOrMessage.editReply(msg);
                else await interactionOrMessage.reply(msg);
                return;
            }

            // 3. Build UI
            const builder = new ComponentsV2()
                .setAccent(0xff0000) // YouTube Red
                .addThumbnail(result.thumbnail, `### [${result.title}](${result.url})\n**${result.channelTitle}**`)
                .addRow([
                    {
                        type: ComponentType.Button,
                        style: ButtonStyle.Link,
                        label: 'Watch on YouTube',
                        url: result.url
                    }
                ]);

            if (result.views || result.duration) {
                let stats = '';
                if (result.views) stats += `👁️ **${result.views}** views`;
                if (result.duration) stats += stats ? `  •  ⏱️ **${result.duration}**` : `⏱️ **${result.duration}**`;
                builder.addText(`-# ${stats}`);
            }

            const payload = builder.build();
            if (isSlash) await interactionOrMessage.editReply(payload);
            else await interactionOrMessage.reply(payload);

        } catch (err: any) {
            console.error('[YoutubeCommand] Error:', err);
            const msg = `⚠️ Error: ${err.message || 'Something went wrong.'}`;
            if (isSlash) await interactionOrMessage.editReply(msg);
            else await interactionOrMessage.reply(msg);
        }
    }
}
