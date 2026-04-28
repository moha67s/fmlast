import {
  SlashCommandBuilder,
  AttachmentBuilder,
  TextChannel,
  ChannelType,
} from "discord.js";
import { BaseCommand } from "../../structures/BaseCommand";
import { LastFM } from "../../services/api/LastFM";
import { Spotify } from "../../services/api/Spotify";
import { Deezer } from "../../services/api/Deezer";
import { AppleMusic } from "../../services/api/AppleMusic";
import { Youtube } from "../../services/api/Youtube";
import { prisma } from "../../database/client";
import { config } from "../../../config";
import { parseArgs } from "../../utils/prefixParser";
import axios from "axios";
import { PuppeteerService } from "../../services/external/PuppeteerService";
import { ComponentsV2 } from "../../utils/ComponentsV2";
import { TrackResolverService } from '../../services/api/TrackResolverService';
import { RateLimitService } from '../../services/bot/RateLimitService';
import { RenderCacheService } from '../../services/bot/RenderCacheService';
import { Client as GeniusClient } from "genius-lyrics";
import { triggerDeltaSync } from "../../services/bot/QueueWorker";

const genius = new GeniusClient(config.GENIUS_ACCESS_TOKEN);


const LASTFM_API_KEY = process.env.LASTFM_API_KEY!;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
const FM_COLOR = 0xd51007;
const MARKET = "EG";

// Removed redundant fetch functions: Artwork utility handles this now with Redis caching.



function secondsToTimeString(s: number) {
  if (s <= 0) return "0 minutes";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  let str = '';
  if (h > 0) str += `${h} hour${h > 1 ? 's' : ''}`;
  if (h > 0 && m > 0) str += ', ';
  if (m > 0) str += `${m} minute${m > 1 ? 's' : ''}`;
  return str;
}

function secondsToHMMSS(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  } else {
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
}

export default class CoverCommand extends BaseCommand {
  name = "cover";
  description = "Show the album cover of your currently playing or last played track.";
  aliases = ["c", "cv"];

  slashData = new SlashCommandBuilder()
    .setName("cover")
    .setDescription("Show the album cover of your currently playing or last played track.")
    .addUserOption((option) =>
      option.setName("user").setDescription("Show album cover for another user.")
    )
    .addStringOption((option) =>
      option.setName("track").setDescription("The track to get the cover for").setRequired(false)
    )
    .addStringOption((option) =>
      option.setName("artist").setDescription("The artist (optional)").setRequired(false)
    );

  async execute(interactionOrMessage: any, isSlash = false, args?: string[]) {
    const isPrefix = !isSlash;
    if (isPrefix) {
      try {
        (interactionOrMessage.channel as TextChannel).sendTyping();
      } catch (err: any) {
        console.warn("Typing indicator failed:", err);
      }
    }

    if (!isPrefix) {
      await interactionOrMessage.deferReply();
    }
    const replyMethod = isPrefix ? "reply" : "editReply";

    // ── 0. GLOBAL RATE LIMIT ──
    const allowed = await RateLimitService.checkCommand(interactionOrMessage.member?.id || interactionOrMessage.author?.id);
    if (!allowed) {
        const msg = "⚠️ You are sending commands too fast! Please slow down.";
        return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
    }

    let artist = "";
    let trackName = "";
    let album = "";
    let finalImageUrl: string | null = null;
    let finalSpotifyUrl: string | null = null;
    let coverSource: string = 'unknown';
    
    let targetUsername: string;
    let sessionKey: string;

    try {
      const targetUser = isSlash 
        ? (interactionOrMessage.options.getUser("user") || interactionOrMessage.user) 
        : (interactionOrMessage.mentions?.users?.first() || interactionOrMessage.author);

      let trackOpt = isSlash ? interactionOrMessage.options.getString("track")?.trim() : undefined;
      let artistOpt = isSlash ? interactionOrMessage.options.getString("artist")?.trim() : undefined;

      if (isPrefix && args) {
        const { map, unnamed } = parseArgs(args);
        if (map.track) {
          trackOpt = map.track;
        } else if (unnamed.length > 0) {
          const filteredUnnamed = unnamed.filter(u => !u.match(/<@!?\d+>/));
          const full = filteredUnnamed.join(' ');
          const match = full.match(/(.+) by (.+)/i);
          if (match) {
            trackOpt = match[1].trim();
            artistOpt = match[2].trim();
          } else {
            trackOpt = full.trim();
          }
        }
        if (map.artist) {
          artistOpt = map.artist;
        }
      }

      const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
      if (!dbUser?.lastfmSessionKey || !dbUser.lastfmUsername) {
        await interactionOrMessage[replyMethod]({
          content: "❌ This user hasn’t linked their Last.fm account yet. Use `/login` or `+login` first."
        });
        return;
      }
      targetUsername = dbUser.lastfmUsername;
      sessionKey = dbUser.lastfmSessionKey;

      // Fire & Forget background sync
      triggerDeltaSync(targetUser.id);

      let resolvedData;
      const isManual = !!(trackOpt || artistOpt);

      if (isManual) {
        if (!trackOpt) throw new Error("Need album or track name");
        resolvedData = await TrackResolverService.resolve(artistOpt || "", trackOpt);
      } else {
        const recentTracks = await LastFM.getRecentTracks(targetUsername, 1, sessionKey);
        const track = recentTracks?.[0];
        if (!track) {
          await interactionOrMessage[replyMethod]({ content: "⚠️ No recent tracks found." });
          return;
        }
        const albumHint = track.album?.['#text'];
        resolvedData = await TrackResolverService.resolve(
          track.artist?.['#text'] || 'Unknown Artist',
          track.name || 'Unknown Track',
          false,
          albumHint || undefined
        );
      }

      artist = resolvedData.artist;
      trackName = resolvedData.title;
      album = resolvedData.album || "Unknown Album";
      finalImageUrl = resolvedData.artworkUrl;
      const links = resolvedData.links;
      coverSource = resolvedData.source;
      const artistAvatarUrl = resolvedData.artistAvatarUrl;

      if (!finalImageUrl) {
        await interactionOrMessage[replyMethod]({ content: '⚠️ No album artwork found.' });
        return;
      }
      // ── COVER SOURCE SUMMARY LOG (Consolidated) ──
      console.log(`[cover] ✅ ${artist} - ${trackName} | Source: ${coverSource}`);

      let cdnUrl: string | null = null;
      let artistScrobbles = null;
      let trackScrobbles = null;

      // ── 0. FETCH USER SCROBBLES (If username available) ──
      if (targetUsername) {
          try {
              const [aInfo, tInfo] = await Promise.all([
                  LastFM.getArtistInfo(artist, targetUsername, sessionKey),
                  LastFM.getTrackInfo(artist, trackName, targetUsername, sessionKey)
              ]);
              artistScrobbles = aInfo?.stats?.userplaycount || aInfo?.userplaycount || null;
              trackScrobbles = tInfo?.userplaycount || null;
          } catch (e: any) {
              console.warn(`[cover] Failed to fetch scrobbles for ${targetUsername}:`, e.message);
          }
      }

      // ── 1. CHECK RENDER CACHE (Personalized) ──
      cdnUrl = await RenderCacheService.getCachedImage('track_info', artist, trackName, targetUsername || undefined);

      if (!cdnUrl) {
          const templateData = {
              coverUrl: finalImageUrl,
              artistAvatarUrl: artistAvatarUrl,
              trackName: trackName,
              artistName: artist,
              albumName: album,
              badgeText: coverSource.toUpperCase(),
              accentColor: "#d51007",
              artistScrobbles: artistScrobbles ? Number(artistScrobbles).toLocaleString() : null,
              trackScrobbles: trackScrobbles ? Number(trackScrobbles).toLocaleString() : null,
              hasStats: !!(artistScrobbles || trackScrobbles)
          };

          const renderBuffer = await PuppeteerService.render('track_info', templateData, { width: 1080, height: 1080 });

          const stagingChannelId = config.CHART_STAGING_CHANNEL_ID;
          if (stagingChannelId && interactionOrMessage.client) {
            try {
              const stagingChannel = await interactionOrMessage.client.channels.fetch(stagingChannelId) as TextChannel | null;
              if (stagingChannel && (stagingChannel.type === ChannelType.GuildText || stagingChannel.type === ChannelType.PublicThread || stagingChannel.type === ChannelType.PrivateThread)) {
                const attachment = new AttachmentBuilder(renderBuffer, {
                  name: `cover-${artist.replace(/\s+/g, '_')}-${(album !== "Unknown Album" ? album : trackName).replace(/\s+/g, '_')}.webp`
                });
                const stagingMessage = await (stagingChannel as TextChannel).send({ files: [attachment] });
                cdnUrl = stagingMessage.attachments.first()?.url || null;

                // Cache the successful render
                if (cdnUrl) {
                    await RenderCacheService.setCachedImage('track_info', artist, trackName, cdnUrl, targetUsername || undefined);
                }

                // Deleting after 24 hours to keep the CDN link alive for a while
                setTimeout(() => stagingMessage.delete().catch(() => { }), 86400000);
              }
            } catch (e: any) {
              console.warn('⚠️ Staging failed:', e);
            }
          }
      }

      if (!cdnUrl) throw new Error('Could not upload cover to Discord CDN.');

      // Fetch platform links (Already resolved via UTR)
      const trackUrlLastfm = trackName !== "Unknown Track" ? `https://www.last.fm/music/${encodeURIComponent(artist)}/_/${encodeURIComponent(trackName)}` : null;

      const buttons: any[] = [];
      if (links.spotify) buttons.push({ type: 2, style: 5, url: links.spotify, emoji: { id: "1496297132381048995", name: "sp" } });
      if (links.apple) buttons.push({ type: 2, style: 5, url: links.apple, emoji: { id: "1496297174869479548", name: "am" } });
      if (links.deezer) buttons.push({ type: 2, style: 5, url: links.deezer, emoji: { id: "1496297153717473311", name: "dez" } });
      if (trackUrlLastfm) buttons.push({ type: 2, style: 5, url: trackUrlLastfm, emoji: { id: "1496297104434270290", name: "las" } });
      if (links.youtube) buttons.push({ type: 2, style: 5, url: links.youtube, emoji: { id: "1496297072201040094", name: "yt" } });

      const payload = new ComponentsV2()
        .setAccent(0xff0000)
        .addMedia(cdnUrl, `${trackName} by ${artist}`)
        .addSeparator();

      if (buttons.length > 0) {
        payload.addRow(buttons);
      }
      
      const finalPayload = payload.build();

      // Removed artificial 2-second delay
      
      await interactionOrMessage[replyMethod](finalPayload);

    } catch (err: any) {
      console.error("🔥 Error fetching album cover:", err);
      const errorMsg = "❌ " + (err.message || "Failed to fetch album cover.");
      if (isSlash && (interactionOrMessage.replied || interactionOrMessage.deferred)) {
        await interactionOrMessage.editReply({ content: errorMsg, embeds: [], files: [], components: [] }).catch(() => {});
      } else {
        await interactionOrMessage.reply({ content: errorMsg, ephemeral: true }).catch(() => {});
      }
    }
  }
}
