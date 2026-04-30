import {
  SlashCommandBuilder,
  TextChannel,
  AttachmentBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";
import { BaseCommand } from "../../structures/BaseCommand";
import { LastFM } from "../../services/api/LastFM";
import { AppleMusic } from "../../services/api/AppleMusic";
import { Deezer } from "../../services/api/Deezer";
import { Youtube } from "../../services/api/Youtube";
import { Spotify } from "../../services/api/Spotify";
import { config } from "../../../config";
import { prisma } from "../../database/client";
import { Client as GeniusClient } from "genius-lyrics";
import axios from "axios";
import { createCanvas, loadImage } from "canvas";
import { setLyricCacheCover } from "./lyriccard";
import { PuppeteerService } from "../../services/external/PuppeteerService";
import { ComponentsV2 } from "../../utils/ComponentsV2";
import { TrackResolverService } from "../../services/api/TrackResolverService";
import { RateLimitService } from "../../services/bot/RateLimitService";
import { RenderCacheService } from "../../services/bot/RenderCacheService";

const genius = new GeniusClient(config.GENIUS_ACCESS_TOKEN);

export default class WhatchosongCommand extends BaseCommand {
  name = "whatchosong";
  description = "Identify a song from a lyric snippet.";
  aliases = ["whats-this-song", "ws", "identify"];

  slashData = new SlashCommandBuilder()
    .setName("whatchosong")
    .setDescription("Identify a song from a lyric snippet.")
    .addStringOption((option) =>
      option
        .setName("lyrics")
        .setDescription("The lyric snippet to search for")
        .setRequired(true)
    );

  async execute(interactionOrMessage: any, isSlash = false, args?: string[]) {

    const isPrefix = !isSlash;
    if (isPrefix) {
      try {
        (interactionOrMessage.channel as TextChannel).sendTyping();
      } catch { }
    }

    const lyricsQuery = isSlash
      ? interactionOrMessage.options.getString("lyrics")
      : args?.join(" ");

    if (!lyricsQuery) {
      const msg = "❌ Please provide a lyric snippet to search for!";
      isSlash
        ? await interactionOrMessage.reply({ content: msg, ephemeral: true })
        : await interactionOrMessage.channel.send(msg);
      return;
    }

    if (!isPrefix) await interactionOrMessage.deferReply();
 
    // ── 0. GLOBAL RATE LIMIT ──
    const allowed = await RateLimitService.checkCommand(interactionOrMessage.member?.id || interactionOrMessage.author?.id);
    if (!allowed) {
        const msg = "⚠️ You are sending commands too fast! Please slow down.";
        return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
    }

    try {
      // 1. Search Genius for the lyrics
      const searches = await genius.songs.search(lyricsQuery);
      if (searches.length === 0) {
        const msg = `😢 I couldn't find any song matching those lyrics.`;
        isSlash
          ? await interactionOrMessage.editReply(msg)
          : await interactionOrMessage.channel.send(msg);
        return;
      }

      const bestMatch = searches[0];
      let artistName = bestMatch.artist.name;
      let trackTitle = bestMatch.title;
      const geniusUrl = bestMatch.url;
      const thumbnail = bestMatch.thumbnail;

      // 2. Resolve High-Res Metadata (Spotify / Apple Music / Deezer)
      // ── 1. GLOBAL RESOLUTION (UTR) ──
      const resolved = await TrackResolverService.resolve(artistName, trackTitle);
      
      const highResCover = resolved.artworkUrl || "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png";
      const coverSource = resolved.source;
      const artistAvatarUrl = resolved.artistAvatarUrl;
      const previewUrl = resolved.links.spotify || resolved.previewUrl;
      
      artistName = resolved.artist;
      trackTitle = resolved.title;
      let albumName = resolved.album || "Unknown Album";

      // Log source
      console.log(`\n[whatchosong] ✅ Source: ${coverSource}`);
      console.log(`[whatchosong]    Track : ${trackTitle} — ${artistName}`);
      console.log(`[whatchosong]    Album : ${albumName}\n`);

      let cdnUrl: string | null = null;
      let artistScrobbles = null;
      let trackScrobbles = null;
      let targetUsername: string | null = null;
      let sessionKey: string | null = null;

      // ── 0. LOOKUP USER (For scrobbles) ──
      const discordId = interactionOrMessage.member?.id || interactionOrMessage.author?.id;
      if (discordId) {
          const user = await prisma.user.findUnique({ where: { discordId } });
          if (user?.lastfmUsername) {
              targetUsername = user.lastfmUsername;
              sessionKey = user.lastfmSessionKey;
              try {
                  const [aInfo, tInfo] = await Promise.all([
                      LastFM.getArtistInfo(artistName, targetUsername, sessionKey),
                      LastFM.getTrackInfo(artistName, trackTitle, targetUsername, sessionKey)
                  ]);
                  artistScrobbles = aInfo?.stats?.userplaycount || aInfo?.userplaycount || null;
                  trackScrobbles = tInfo?.userplaycount || null;
              } catch (e: any) {
                  console.warn(`[whatchosong] Failed to fetch scrobbles for ${targetUsername}:`, e.message);
              }
          }
      }

      // ── 1. CHECK RENDER CACHE (Personalized) ──
      cdnUrl = await RenderCacheService.getCachedImage('track_info', artistName, trackTitle, targetUsername || undefined);
 
      if (!cdnUrl) {
          const templateData = {
              coverUrl: highResCover,
              artistAvatarUrl: artistAvatarUrl,
              trackName: trackTitle,
              artistName: artistName,
              albumName: albumName,
              badgeText: "FOUND ON GENIUS",
              accentColor: "#ffcc00",
              artistScrobbles: artistScrobbles ? Number(artistScrobbles).toLocaleString() : null,
              trackScrobbles: trackScrobbles ? Number(trackScrobbles).toLocaleString() : null,
              hasStats: !!(artistScrobbles || trackScrobbles)
          };
 
          const buffer = await PuppeteerService.render('track_info', templateData, { width: 1080, height: 1080 });
 
          try {
            const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
            if (stagingChannelId && interactionOrMessage.client) {
              const stagingChannel = await interactionOrMessage.client.channels.fetch(stagingChannelId) as TextChannel;
              if (stagingChannel) {
                const attachment = new AttachmentBuilder(buffer, { name: 'whatchosong.webp' });
                const stagingMsg = await stagingChannel.send({ files: [attachment] });
                cdnUrl = stagingMsg.attachments.first()?.url || null;
                
                // Cache successful render
                if (cdnUrl) {
                    await RenderCacheService.setCachedImage('track_info', artistName, trackTitle, cdnUrl, targetUsername || undefined);
                }
 
                // Deleting after 24 hours to keep the CDN link alive for a while
                setTimeout(() => stagingMsg.delete().catch(() => { }), 86400000);
              }
            }
          } catch (err) {
            console.error("[whatchosong] staging failed:", err);
          }
      }

      // 3.5 Cache the high-res cover for the Lyrics Card button
      setLyricCacheCover(artistName, trackTitle, highResCover);

      // Fetch platform links (Already resolved via UTR)
      const trackUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(artistName)}/_/${encodeURIComponent(trackTitle)}`;
      const links = resolved.links;
 
      const platformButtons: any[] = [];
      if (links.spotify) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.spotify, emoji: { id: "1496297132381048995", name: "sp" } });
      if (links.apple) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.apple, emoji: { id: "1496297174869479548", name: "am" } });
      if (links.deezer) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.deezer, emoji: { id: "1496297153717473311", name: "dez" } });
      if (trackUrlLastfm) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: trackUrlLastfm, emoji: { id: "1496297104434270290", name: "las" } });
      if (links.youtube) platformButtons.push({ type: ComponentType.Button, style: ButtonStyle.Link, url: links.youtube, emoji: { id: "1496297072201040094", name: "yt" } });

      const geniusId = bestMatch.id;
      const safeArtist = artistName.substring(0, 35);
      const safeTrack = trackTitle.substring(0, 35);

      const payload = new ComponentsV2()
        .setAccent(0x5865f2) // Genius Yellow
        .addMedia(cdnUrl || thumbnail, `${trackTitle} by ${artistName}`)
        .addSeparator();

      if (platformButtons.length > 0) {
        payload.addRow(platformButtons);
      }

      payload.addRow([
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary, // Secondary
            custom_id: `wh-lyrics:${geniusId}|${safeArtist}|${safeTrack}`,
            label: "Lyrics Card"
          },
          {
            type: ComponentType.Button,
            style: ButtonStyle.Secondary, // Secondary
            custom_id: `wh-full-lyrics:${geniusId}|${safeArtist}|${safeTrack}`,
            label: "Full Lyrics"
          }
        ]);

      const finalPayload = { ...payload.build(), flags: 32768 };

      if (isSlash) {
        await interactionOrMessage.editReply(finalPayload);
      } else {
        await interactionOrMessage.channel.send(finalPayload);
      }

    } catch (err) {
      console.error("[whatchosong] error:", err);
      const msg = "⚠️ Failed to identify song.";
      isSlash
        ? await interactionOrMessage.editReply(msg)
        : await interactionOrMessage.channel.send(msg);
    }
  }
}
