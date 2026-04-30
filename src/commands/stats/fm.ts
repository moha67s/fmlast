import {
  SettingService } from '../../services/bot/SettingService';
import { BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { prisma } from '../../database/client';
import { TextChannel,
  AttachmentBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { Client as GeniusClient } from 'genius-lyrics';
import { config } from '../../../config';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { triggerDeltaSync } from '../../services/bot/QueueWorker';
import { PuppeteerService } from '../../services/external/PuppeteerService';
import { RenderCacheService } from '../../services/bot/RenderCacheService';
import { ChannelType } from 'discord.js';
import { resolveTargetUser } from '../../utils/userResolver';

const genius = new GeniusClient(config.GENIUS_ACCESS_TOKEN);

export default class FMCommand extends BaseCommand {
    name = 'fm';
    description = 'Show what you are currently listening to';
    aliases = ['f', 'np'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('fm')
        .setDescription('Show what you are currently listening to')
        .addUserOption((opt: any) =>
            opt.setName('user')
                .setDescription('View another user\'s now playing')
                .setRequired(false)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const authorId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;
        const authorDb = await prisma.user.findUnique({ where: { discordId: authorId } });
        const embedColor = authorDb ? SettingService.resolveAccentColor(authorDb) : 0x0a0a0b;

        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const targetUser = await resolveTargetUser(interactionOrMessage, isSlash);
        const userId = targetUser.id;

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        if (!dbUser?.lastfmSessionKey || !dbUser.lastfmUsername) {
            const isSelf = userId === (isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id);
            const msg = isSelf 
                ? '❌ You are not linked to Last.fm yet.\nRun `/login` or `!login` first!'
                : `❌ **${targetUser.username}** is not linked to Last.fm yet.`;

            const payload = new ComponentsV2()
                .setAccent(0xff0000)
                .addText(msg)
                .build();

            if (isSlash) await interactionOrMessage.reply({ ...payload, ephemeral: true });
            else await interactionOrMessage.channel.send(payload);
            return;
        }

        // Fire & Forget background sync
        triggerDeltaSync(userId);

        try {
            const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey);
            const userInfo = await LastFM.getUserInfo(dbUser.lastfmUsername, dbUser.lastfmSessionKey);

            if (!tracks?.length) throw new Error('No tracks found.');

            const track = tracks[0];
            const artistRaw = track.artist['#text'];
            const albumRaw = track.album?.['#text'] || 'Unknown Album';
            const scrobbles = userInfo.playcount || '0';

            // ── 1. GLOBAL RESOLUTION (UTR) ──
            const resolved = await TrackResolverService.resolve(artistRaw, track.name, false, albumRaw !== 'Unknown Album' ? albumRaw : undefined);
            
            const artist = resolved.artist;
            const album = resolved.album || albumRaw;
            const cover = resolved.artworkUrl;
            const coverSource = resolved.source;

            console.log(`\n[fm] ✅ Source: ${coverSource} | ${track.name} — ${artist}\n`);

            const albumUrl = `https://www.last.fm/music/${encodeURIComponent(artist).replace(/%20/g, '+')}/${encodeURIComponent(album).replace(/%20/g, '+')}`;
            const content = `### [${track.name}](${track.url})\n**${artist}** • [${album}](${albumUrl})\n\n-# ${scrobbles} total scrobbles`;

            const builder = new ComponentsV2().setAccent(embedColor);

            const files = [];
            if (typeof cover === 'string' && cover.length > 0) {
                builder.addThumbnail("attachment://fm_cover.jpg", content);
                files.push(new AttachmentBuilder(cover, { name: 'fm_cover.jpg' }));
            } else {
                builder.addText(content);
            }

            const links = resolved.links;
            const platformButtons: any[] = [];
            
            if (links.spotify) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.spotify, emoji: { id: "1496297132381048995", name: "sp" } });
            if (links.apple) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.apple, emoji: { id: "1496297174869479548", name: "am" } });
            if (links.deezer) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.deezer, emoji: { id: "1496297153717473311", name: "dez" } });
            if (track.url) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: track.url, emoji: { id: "1496297104434270290", name: "las" } });

            if (platformButtons.length > 0) {
                builder.addRow(platformButtons);
            }

            const payload = { ...builder.build(), files };

            if (isSlash) {
                await interactionOrMessage.reply(payload);
            } else {
                await interactionOrMessage.channel.send(payload);
            }

        } catch (err: any) {
            console.error(err);
            const errPayload = new ComponentsV2()
                .setAccent(0xff0000)
                .addText(`❌ ${err.message || 'Could not fetch now playing.'}`)
                .build();

            if (isSlash) await interactionOrMessage.reply({ ...errPayload, ephemeral: true });
            else await interactionOrMessage.channel.send(errPayload);
        }
    }
}
