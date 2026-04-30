import {
  SlashCommandBuilder,
  TextChannel,
  AttachmentBuilder,
} from "discord.js";
import { BaseCommand } from "../../structures/BaseCommand";
import { AppleMusic } from "../../services/api/AppleMusic";
import { Deezer } from "../../services/api/Deezer";
import { Youtube } from "../../services/api/Youtube";
import { Spotify } from "../../services/api/Spotify";
import { LastFM } from "../../services/api/LastFM";
import { config } from "../../../config";
import { setLyricCacheCover } from "./lyriccard";
import { extractPreview, cleanup } from "../../utils/audioProcessor";
import { Client as GeniusClient } from "genius-lyrics";
import axios from "axios";
import fs from "fs";
import { PuppeteerService } from "../../services/external/PuppeteerService";
import { ComponentsV2 } from "../../utils/ComponentsV2";
import { RateLimitService } from "../../services/bot/RateLimitService";
import { RenderCacheService } from "../../services/bot/RenderCacheService";
import { TrackResolverService } from "../../services/api/TrackResolverService";
import { prisma } from "../../database/client";

const genius = new GeniusClient(config.GENIUS_ACCESS_TOKEN);

export default class ShazamCommand extends BaseCommand {
  name = "shazam";
  description = "Identify music from a video or audio attachment.";
  aliases = ["identify", "findsong", "whatisthis"];

  slashData = new SlashCommandBuilder()
    .setName("shazam")
    .setDescription("Identify music from a video or audio attachment.")
    .addAttachmentOption((option) =>
      option
        .setName("file")
        .setDescription("The video or audio file to identify")
        .setRequired(false)
    );

  async execute(interactionOrMessage: any, isSlash = false, args?: string[]) {

    const isPrefix = !isSlash;
    if (isPrefix) {
      try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch { }
    }

    if (!isPrefix) await interactionOrMessage.deferReply();
    const replyMethod = isPrefix ? "reply" : "editReply";
 
    // ── 0. GLOBAL RATE LIMIT ──
    const allowed = await RateLimitService.checkCommand(interactionOrMessage.member?.id || interactionOrMessage.author?.id);
    if (!allowed) {
        const msg = "⚠️ You are sending commands too fast! Please slow down.";
        return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
    }

    try {
      // 1. Find the attachment
      let attachment: any = null;

      if (isSlash) {
        if (interactionOrMessage.isButton()) {
          // If button is on a reply, check the original message
          attachment = interactionOrMessage.message.attachments.first();
          if (!attachment && interactionOrMessage.message.reference) {
            try {
              const ref = await interactionOrMessage.channel.messages.fetch(interactionOrMessage.message.reference.messageId);
              attachment = ref.attachments.first();
            } catch { }
          }
        } else {
          attachment = interactionOrMessage.options.getAttachment("file");
        }
      } else {
        attachment = interactionOrMessage.attachments.first();
      }

      // Check for reply if prefix and no attachment
      if (isPrefix && !attachment && interactionOrMessage.reference) {
        const repliedMsg = await interactionOrMessage.channel.messages.fetch(interactionOrMessage.reference.messageId);
        attachment = repliedMsg.attachments.first();
      }

      if (!attachment) {
        const msg = "❌ Please attach a video/audio file or reply to one!";
        return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
      }

      const isVideo = attachment.contentType?.startsWith("video");
      const isAudio = attachment.contentType?.startsWith("audio");

      if (!isVideo && !isAudio) {
        const msg = "❌ attachment must be a video or audio file!";
        return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
      }

      // 2. Process Audio Snippet
      const uniqueId = `${interactionOrMessage.id}_${Date.now()}`;
      let audioPath: string;
      try {
        audioPath = await extractPreview(attachment.url, uniqueId);
      } catch (err) {
        console.error("[shazam] ffmpeg error:", err);
        throw new Error("Failed to extract audio from the file.");
      }

      // 3. Identify via RapidAPI Shazam
      if (!config.RAPIDAPI_KEY) {
        throw new Error("RapidAPI key is missing in configuration.");
      }

      const pcmData = fs.readFileSync(audioPath);
      const base64Audio = pcmData.toString('base64');

      const options = {
        method: 'POST',
        url: 'https://shazam.p.rapidapi.com/songs/v2/detect',
        params: { timezone: 'America/Chicago', locale: 'en-US' },
        headers: {
          'content-type': 'text/plain',
          'x-rapidapi-key': config.RAPIDAPI_KEY,
          'x-rapidapi-host': 'shazam.p.rapidapi.com'
        },
        data: base64Audio
      };

      const shazamRes = await axios.request(options);

      console.log("[shazam] RapidAPI Response:", JSON.stringify(shazamRes.data, null, 2));

      cleanup(audioPath);

      const result = shazamRes.data;
      if (!result.track) {
        const msg = "😢 I couldn't identify the song in this clip.";
        return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
      }

      const song = result.track;
      let artistName = song.subtitle || "Unknown Artist";
      let trackTitle = song.title || "Unknown Title";
      let albumName = "Unknown Album";

      // 4. Resolve High-Res Metadata
      // ── 1. GLOBAL RESOLUTION (UTR) ──
      const resolved = await TrackResolverService.resolve(artistName, trackTitle);
      
      const finalCover = resolved.artworkUrl;
      const coverSource = resolved.source;
      const artistAvatarUrl = resolved.artistAvatarUrl;
      const previewUrl = resolved.links.spotify || resolved.previewUrl;
      const links = resolved.links;
      
      artistName = resolved.artist;
      trackTitle = resolved.title;
      albumName = resolved.album || "Unknown Album";
 
      // Log source
      console.log(`\n[shazam] ✅ Source: ${coverSource}`);
      console.log(`[shazam]    Track : ${trackTitle} — ${artistName}`);
      console.log(`[shazam]    Album : ${albumName}\n`);

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
                  console.warn(`[shazam] Failed to fetch scrobbles for ${targetUsername}:`, e.message);
              }
          }
      }

      // ── 1. CHECK RENDER CACHE (Personalized) ──
      cdnUrl = await RenderCacheService.getCachedImage('track_info', artistName, trackTitle, targetUsername || undefined);
 
      if (!cdnUrl) {
          const templateData = {
              coverUrl: finalCover,
              artistAvatarUrl: artistAvatarUrl,
              trackName: trackTitle,
              artistName: artistName,
              albumName: albumName,
              badgeText: "IDENTIFIED VIA SHAZAM",
              accentColor: "#0088ff",
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
                const attachment = new AttachmentBuilder(buffer, { name: 'shazam.webp' });
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
            console.error("[shazam] staging failed:", err);
          }
      }

      // Cache for Lyrics Card
      setLyricCacheCover(artistName, trackTitle, finalCover);

      // Fetch platform links (Already resolved via UTR)
      const trackUrlLastfm = `https://www.last.fm/music/${encodeURIComponent(artistName)}/_/${encodeURIComponent(trackTitle)}`;
      
      const platformButtons: any[] = [];
      if (links.spotify) platformButtons.push({ type: 2, style: 5, url: links.spotify, emoji: { id: "1496297132381048995", name: "sp" } });
      if (links.apple) platformButtons.push({ type: 2, style: 5, url: links.apple, emoji: { id: "1496297174869479548", name: "am" } });
      if (links.deezer) platformButtons.push({ type: 2, style: 5, url: links.deezer, emoji: { id: "1496297153717473311", name: "dez" } });
      if (trackUrlLastfm) platformButtons.push({ type: 2, style: 5, url: trackUrlLastfm, emoji: { id: "1496297104434270290", name: "las" } });
      if (links.youtube) platformButtons.push({ type: 2, style: 5, url: links.youtube, emoji: { id: "1496297072201040094", name: "yt" } });

      const payload = new ComponentsV2()
        .setAccent(0x0088ff) // Shazam Blue
        .addMedia((cdnUrl || finalCover) as string, `${trackTitle} by ${artistName}`)
        .addSeparator();

      if (platformButtons.length > 0) {
        payload.addRow(platformButtons);
      }

      payload.addRow([
          {
            type: 2,
            style: 2,
            custom_id: `wh-lyrics:${artistName.substring(0, 35)}|${trackTitle.substring(0, 35)}`,
            label: "Lyrics Card"
          },
          {
            type: 2,
            style: 2,
            custom_id: `wh-full-lyrics:${artistName.substring(0, 35)}|${trackTitle.substring(0, 35)}`,
            label: "Full Lyrics"
          }
        ]);

      await interactionOrMessage[replyMethod]({ ...payload.build(), flags: 32768 });

    } catch (err: any) {
      console.error("[shazam] overall error:", err);
      const msg = `⚠️ Error: ${err.message || "Failed to identify music."}`;
      isSlash ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.channel.send(msg);
    }
  }
}
