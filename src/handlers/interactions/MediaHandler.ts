import { Interaction, Client, ComponentType, ButtonStyle, AttachmentBuilder } from 'discord.js';
import { BaseInteractionHandler } from './BaseInteractionHandler';
import { prisma } from '../../database/client';
import { LoggerService } from '../../services/bot/LoggerService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { config } from '../../../config';

export class MediaHandler extends BaseInteractionHandler {
    
    canHandle(customId: string): boolean {
        return customId.startsWith('preview:') || 
               customId.startsWith('radio-') || 
               customId.startsWith('lc-nav:') ||
               customId.startsWith('wh-lyrics') ||
               customId.startsWith('wh-full-lyrics');
    }

    async handle(interaction: Interaction, client: Client): Promise<void> {
        if (!interaction.isButton()) return;

        try {
            // ── Preview ──
            if (interaction.customId.startsWith('preview:')) {
                const uniqueId = interaction.customId.substring('preview:'.length);
                const { previewMap, downloadAndConvert } = await import('../../utils/downloader');
                const sendVoice = (await import('../../utils/sendVoice')).default;
                
                const previewUrl = previewMap.get(uniqueId);
                if (!previewUrl) {
                    await interaction.reply({ content: '❌ Preview expired.', ephemeral: true });
                    return;
                }
                
                await interaction.deferUpdate();
                const oggPath = await downloadAndConvert(previewUrl, uniqueId);
                await sendVoice(interaction.channelId!, oggPath, interaction.message?.id);
                return;
            }

            // ── Radio ──
            if (interaction.customId.startsWith('radio-pre:')) {
                const query = interaction.customId.substring('radio-pre:'.length);
                const [art, track] = query.split('|');
                const { downloadAndConvert } = await import('../../utils/downloader');
                const sendVoice = (await import('../../utils/sendVoice')).default;
                const { TrackResolverService } = await import('../../services/api/TrackResolverService');
                const { LastFM } = await import('../../services/api/LastFM');
                
                await interaction.deferUpdate();
                const resolved = await TrackResolverService.resolve(art, track);
                const previewUrl = resolved.previewUrl;
                
                if (!previewUrl) {
                    await interaction.followUp({ content: '❌ No preview found.', ephemeral: true });
                    return;
                }
                
                const oggPath = await downloadAndConvert(previewUrl, `radio_${Date.now()}`);
                const msg = await sendVoice(interaction.channelId!, oggPath, interaction.message.id);

                if (msg && msg.id) {
                    const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
                    let statsText = '';
                    try {
                        const lfmInfo = await LastFM.getTrackInfo(resolved.artist, resolved.title, dbUser?.lastfmUsername, dbUser?.lastfmSessionKey);
                        const listeners = lfmInfo?.listeners ? parseInt(lfmInfo.listeners).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;
                        const plays = lfmInfo?.playcount ? parseInt(lfmInfo.playcount).toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 }) : null;
                        const parts = [];
                        if (listeners) parts.push(`${listeners} listeners`);
                        if (plays) parts.push(`${plays} plays`);
                        if (parts.length > 0) statsText = `\n${parts.join(' • ')}`;
                    } catch { }

                    const embedBuilder = new ComponentsV2()
                        .addThumbnail(resolved.artworkUrl || 'https://i.imgur.com/Gis9d79.png', `### ${resolved.title}\n**${resolved.artist}**${resolved.album ? ` - ${resolved.album}` : ''}${statsText}`)
                        .addSeparator();

                    const buttons: any[] = [];
                    const links = resolved.links;
                    if (links.spotify) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.spotify, emoji: { id: "1496297132381048995", name: "sp" } });
                    if (links.apple) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.apple, emoji: { id: "1496297174869479548", name: "am" } });
                    if (links.deezer) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.deezer, emoji: { id: "1496297153717473311", name: "dez" } });
                    if (links.youtube) buttons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.youtube, emoji: { id: "1496297072201040094", name: "yt" } });

                    if (buttons.length > 0) embedBuilder.addRow(buttons);
                    
                    const channel = client.channels.cache.get(interaction.channelId!) as any;
                    if (channel) await channel.send({ ...embedBuilder.build(), reply: { messageReference: msg.id } });
                }
                return;
            }

            if (interaction.customId.startsWith('radio-reroll')) {
                const { default: RadioCommand } = await import('../../commands/media/radio');
                const radioCmd = new RadioCommand();
                await radioCmd.execute(interaction, true);
                return;
            }

            // ── Lyric Card ──
            if (interaction.customId.startsWith('lc-nav:')) {
                await interaction.deferUpdate();
                const payload = interaction.customId.substring('lc-nav:'.length);
                const parts = payload.split('|');
                const artist = parts[0];
                const track = parts[1];
                const lineIdx = parseInt(parts[2] ?? '0', 10);
                
                const { buildLyricCardBuffer, buildLyricNavRow, getLyricCacheCover } = await import('../../commands/media/lyriccard');
                const { LyricsService } = await import('../../services/external/LyricsService');
                const { lines: lyricLines, source } = await LyricsService.fetchLyrics(artist, track);
                
                let coverUrl = getLyricCacheCover(artist, track);
                if (coverUrl === undefined || coverUrl === null) {
                    const { AppleMusic } = await import('../../services/api/AppleMusic');
                    const am = await AppleMusic.searchTrack(artist, track);
                    coverUrl = am?.artworkUrl?.replace('{w}x{h}', '1000x1000') || null;
                }

                const { RenderCacheService } = await import('../../services/bot/RenderCacheService');
                let cdnUrl = await RenderCacheService.getCachedImage('lyriccard', artist, track + ':' + lineIdx);

                if (!cdnUrl) {
                    const buf = await buildLyricCardBuffer({ artist, track, coverUrl, lyricLines, lineIdx, source });
                    const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
                    if (stagingChannelId && client) {
                        const stagingChannel = await client.channels.fetch(stagingChannelId) as any;
                        const attachment = new AttachmentBuilder(buf as Buffer, { name: 'lyriccard.webp' });
                        const stagingMsg = await stagingChannel.send({ files: [attachment] });
                        cdnUrl = stagingMsg.attachments.first()?.url || null;
                        if (cdnUrl) await RenderCacheService.setCachedImage('lyriccard', artist, track + ':' + lineIdx, cdnUrl);
                        setTimeout(() => stagingMsg.delete().catch(() => {}), 86400000);
                    }
                }

                const builder = new ComponentsV2().addFullImage(cdnUrl || '', `Lyrics for **${track}** by **${artist}**`);
                builder.addRow(buildLyricNavRow(artist, track, lineIdx, lyricLines.length, null).components);
                await interaction.editReply(builder.build());
                return;
            }

            // ── Whatchosong Lyrics ──
            if (interaction.customId.startsWith('wh-lyrics') || interaction.customId.startsWith('wh-full-lyrics')) {
                const isFull = interaction.customId.startsWith('wh-full-lyrics');
                const payload = interaction.customId.split(':')[1];
                const parts = payload.split('|');
                const geniusId = parts[0];
                const artist = parts[1];
                const track = parts[2];

                if (isFull) {
                    const { LyricsService } = await import('../../services/external/LyricsService');
                    const lyrics = await LyricsService.fetchFullLyricsById(geniusId);
                    if (!lyrics) {
                        await interaction.reply({ content: '❌ Lyrics not found.', ephemeral: true });
                        return;
                    }
                    const builder = new ComponentsV2().addText(`## 📜 Full Lyrics: ${track}\n${lyrics.substring(0, 3900)}`);
                    await interaction.reply({ ...builder.build(), ephemeral: true });
                } else {
                    const { LyricsService } = await import('../../services/external/LyricsService');
                    const { lines, source } = await LyricsService.fetchLyrics(artist, track);
                    const { buildLyricCardBuffer, buildLyricNavRow, getLyricCacheCover } = await import('../../commands/media/lyriccard');
                    let coverUrl = getLyricCacheCover(artist, track) || null;
                    
                    await interaction.deferReply();
                    const buf = await buildLyricCardBuffer({ artist, track, coverUrl, lyricLines: lines, lineIdx: 0, source });
                    const attachment = new AttachmentBuilder(buf as Buffer, { name: 'lyriccard.webp' });
                    const builder = new ComponentsV2().addFullImage('attachment://lyriccard.webp', `Lyrics for **${track}** by **${artist}**`);
                    builder.addRow(buildLyricNavRow(artist, track, 0, lines.length, null).components);
                    await interaction.editReply({ ...builder.build(), files: [attachment] });
                }
                return;
            }
        } catch (err) {
            LoggerService.error('MediaHandler Error', err, 'MediaHandler');
            throw err;
        }
    }
}
