import {
  SlashCommandBuilder,
  EmbedBuilder,
  TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from "discord.js";
import { BaseCommand } from "../../structures/BaseCommand";
import { LastFM } from "../../services/api/LastFM";
import { AppleMusic } from "../../services/api/AppleMusic";
import { config } from "../../../config";
import { prisma } from "../../database/client";
import { Client as GeniusClient } from "genius-lyrics";
import axios from "axios";

const genius = new GeniusClient(config.GENIUS_ACCESS_TOKEN);

export default class SamplesCommand extends BaseCommand {
  name = "samples";
  description = "Discover a song's DNA: samples, interpolations, and who sampled it.";
  aliases = ["dna", "lineage", "connections"];

  slashData = new SlashCommandBuilder()
    .setName("samples")
    .setDescription("Discover a song's DNA: samples, interpolations, and who sampled it.")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("Song name and artist (optional, defaults to Now Playing)")
        .setRequired(false)
    );

  async execute(interactionOrMessage: any, isSlash = false, args?: string[]) {
    const isPrefix = !isSlash;
    if (isPrefix) {
      try { (interactionOrMessage.channel as TextChannel).sendTyping(); } catch {}
    }

    let query = isSlash ? interactionOrMessage.options.getString("query") : args?.join(" ");
    const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

    if (!isPrefix) await interactionOrMessage.deferReply();

    try {
      let resolvedArtist = "";
      let resolvedTrack = "";

      // 1. Resolve Query or NP
      if (!query) {
        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
        if (!dbUser?.lastfmUsername) {
          const msg = "❌ Provide a song or link your Last.fm using `/login`!";
          return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
        }
        const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey);
        if (!tracks?.length) {
          const msg = "😢 No recent tracks found. Provide a search query!";
          return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
        }
        resolvedArtist = tracks[0].artist["#text"];
        resolvedTrack = tracks[0].name;
      } else {
        // Simple splitter for "track by artist"
        if (query.includes(" by ")) {
          const parts = query.split(" by ");
          resolvedTrack = parts[0].trim();
          resolvedArtist = parts[1].trim();
        } else {
          resolvedTrack = query.trim();
        }
      }

      // 2. Find on Genius
      const searches = await genius.songs.search(`${resolvedTrack} ${resolvedArtist}`);
      if (searches.length === 0) {
        const msg = `😢 I couldn't find "${resolvedTrack}" on Genius.`;
        return isSlash ? interactionOrMessage.editReply(msg) : interactionOrMessage.channel.send(msg);
      }

      const song = searches[0];
      // Fetch full details including relationships using the official API (via the library's internal request util)
      // The library's api.get returns a raw JSON string
      const rawData = await song.client.api.get(`/songs/${song.id}`);
      const data = JSON.parse(rawData).response.song;

      const relationships = data.song_relationships || [];
      const stats = data.stats || {};
      
      const embed = new EmbedBuilder()
        .setColor(0xffcc00)
        .setAuthor({ name: `Song Connections: ${data.title}`, iconURL: data.song_art_image_thumbnail_url, url: data.url })
        .setTitle(`${data.title} by ${data.primary_artist.name}`)
        .setThumbnail(data.song_art_image_url)
        .setFooter({ text: `Genius DNA • ${stats.pageviews?.toLocaleString() || 0} views` });

      let connectionsCount = 0;

      const typeMap: Record<string, { emoji: string, label: string }> = {
        samples: { emoji: "🧬", label: "Samples" },
        sampled_in: { emoji: "🧪", label: "Sampled In" },
        interpolates: { emoji: "🎹", label: "Interpolates" },
        interpolated_by: { emoji: "🎼", label: "Interpolated By" },
        cover_of: { emoji: "🎙️", label: "Cover Of" },
        covered_by: { emoji: "🎭", label: "Covered By" }
      };

      for (const rel of relationships) {
        if (rel.songs && rel.songs.length > 0) {
          const info = typeMap[rel.relationship_type] || { emoji: "🔗", label: rel.relationship_type.replace(/_/g, " ") };
          const list = rel.songs.map((s: any) => `• [${s.title}](https://genius.com${s.path}) by **${s.primary_artist.name}**`).join("\n");
          embed.addFields({ name: `${info.emoji} ${info.label}`, value: list.length > 1024 ? list.substring(0, 1021) + "..." : list });
          connectionsCount += rel.songs.length;
        }
      }

      if (connectionsCount === 0) {
         embed.setDescription("*This song has no known samples or relationships on Genius.*");
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel("View on Genius")
          .setURL(data.url)
          .setStyle(ButtonStyle.Link)
      );

      isSlash
        ? await interactionOrMessage.editReply({ embeds: [embed], components: [row] })
        : await interactionOrMessage.channel.send({ embeds: [embed], components: [row] });

    } catch (err) {
      console.error("[samples] error:", err);
      const msg = "⚠️ Failed to fetch song relationships.";
      isSlash
        ? await interactionOrMessage.editReply(msg)
        : await interactionOrMessage.channel.send(msg);
    }
  }
}
