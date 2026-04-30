import {
  BaseCommand } from '../../structures/BaseCommand';
import { LastFM } from '../../services/api/LastFM';
import { Deezer } from '../../services/api/Deezer';
import { AppleMusic } from '../../services/api/AppleMusic';
import { prisma } from '../../database/client';
import { ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TextChannel
} from "discord.js";
import { getAudioSignalAndSr, previewMap } from '../../utils/downloader';

const esPkg: any = require("essentia.js");
let essentia: any = null;

function getEssentia() {
    if (essentia !== null) return essentia;
    try {
        essentia = new esPkg.Essentia(esPkg.EssentiaWASM);
        return essentia;
    } catch (err) {
        console.error("[TrackDetails] Failed to initialize Essentia.js:", err);
        essentia = false; // Mark as failed
        return null;
    }
}

function formatKey(key: string, scale: string): string {
    const sharpMap: { [key: string]: string } = {
        A: "A", Bb: "A#", B: "B", C: "C", Db: "C#", D: "D",
        Eb: "D#", E: "E", F: "F", Gb: "F#", G: "G", Ab: "G#"
    };
    if (key === "N/A") return "N/A";
    const baseKey = sharpMap[key] || key;
    return baseKey; // No "m" appended
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default class TrackDetailsCommand extends BaseCommand {
    name = 'trackdetails';
    description = 'Show metadata for your currently playing track (BPM, key)';
    aliases = ['td', 't'];

    slashData = new (require('discord.js').SlashCommandBuilder)()
        .setName('trackdetails')
        .setDescription('Show metadata for your currently playing track (BPM, key)');

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]): Promise<void> {
        const userId = isSlash ? interactionOrMessage.user.id : interactionOrMessage.author.id;

        if (!isSlash) {
            try {
                (interactionOrMessage.channel as TextChannel).sendTyping();
            } catch (err) { }
        }

        const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });

        if (!dbUser?.lastfmSessionKey || !dbUser.lastfmUsername) {
            const payload = { content: '❌ You are not linked to Last.fm yet. Run `/login` or `+login` first!', ephemeral: true };
            isSlash ? await interactionOrMessage.reply(payload) : await interactionOrMessage.channel.send(payload);
            return;
        }

        if (isSlash) await interactionOrMessage.deferReply();

        try {
            const tracks = await LastFM.getRecentTracks(dbUser.lastfmUsername, 1, dbUser.lastfmSessionKey);

            if (!tracks?.length) {
                const payload = { content: '😢 No recent tracks found.' };
                isSlash ? await interactionOrMessage.editReply(payload) : await interactionOrMessage.channel.send(payload);
                return;
            }

            const track = tracks[0];
            const artist = track.artist['#text'] || 'Unknown Artist';
            const song = track.name || 'Unknown Track';

            // 1. Try Apple Music first
            let trackInfo: any = null;
            const appleResult = await AppleMusic.searchTrack(artist, song);
            if (appleResult) {
                trackInfo = {
                    id: interactionOrMessage.id,
                    name: appleResult.trackName,
                    artist: appleResult.artistName,
                    url: appleResult.storeUrl,
                    previewUrl: appleResult.previewUrl,
                    durationMs: appleResult.durationMs,
                    appleUrl: appleResult.storeUrl,
                };
            }

            // 2. Try Deezer Fallback
            if (!trackInfo) {
                console.log("Apple Music search failed entirely, trying Deezer as fallback source...");
                trackInfo = await Deezer.searchTrack(artist, song);
            }

            if (!trackInfo) {
                const msg = `**${song}** by **${artist}** is a track that we don't have any metadata for, sorry :eyes:`;
                isSlash ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.channel.send(msg);
                return;
            }

            // 3. Fallback for Preview URL
            if (!trackInfo.previewUrl) {
                if (trackInfo.appleUrl) {
                    const deezerFallback = await Deezer.searchTrack(trackInfo.artist, trackInfo.name);
                    if (deezerFallback && deezerFallback.previewUrl) {
                        trackInfo.previewUrl = deezerFallback.previewUrl;
                    }
                } else {
                    const appleFallback = await AppleMusic.searchTrack(trackInfo.artist, trackInfo.name);
                    if (appleFallback && appleFallback.previewUrl) {
                        trackInfo.previewUrl = appleFallback.previewUrl;
                        trackInfo.appleUrl = appleFallback.storeUrl;
                    }
                }
            }

            const messageId = isSlash ? interactionOrMessage.id : interactionOrMessage.id;
            const uniqueId = `track_${messageId}_${Date.now()}`;
            
            // 4. Get Audio Features
            let features: { bpm: number; key: string } | null = null;
            const esInstance = getEssentia();
            if (trackInfo.previewUrl && esInstance) {
                try {
                    const { signal } = await getAudioSignalAndSr(uniqueId, trackInfo.previewUrl);
                    const audioVector = esInstance.arrayToVector(signal);
                    const rhythm = esInstance.RhythmExtractor2013(audioVector);
                    const bpm = rhythm && rhythm.bpm ? Math.round(rhythm.bpm * 10) / 10 : 0;
                    const keyData = esInstance.KeyExtractor(audioVector);
                    const keyStr = keyData && keyData.key ? formatKey(keyData.key, keyData.scale) : "N/A";
                    features = { bpm, key: keyStr };
                } catch (err) {
                    console.error("Essentia analysis failed:", err);
                }
            }

            if (!features) {
                const msg = `**${trackInfo.name}** by **${trackInfo.artist}** is a track that we don't have **audio features** for, sorry 😔`;
                isSlash ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.channel.send(msg);
                return;
            }

            const duration = formatDuration(trackInfo.durationMs);

            if (!isSlash) {
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }

            if (trackInfo.previewUrl) {
                previewMap.set(uniqueId, trackInfo.previewUrl);
            }

            const response = `**${trackInfo.name}** by **${trackInfo.artist}** has \`${features.bpm}\` bpm, is in key \`${features.key}\` and lasts \`${duration}\``;

            const linkURL = trackInfo.appleUrl || trackInfo.url;
            const linkLabel = trackInfo.appleUrl ? "Open on Apple Music" : "Open on Deezer";

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`preview:${uniqueId}`)
                    .setLabel("Preview")
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!trackInfo.previewUrl),
                new ButtonBuilder()
                    .setURL(linkURL)
                    .setLabel(linkLabel)
                    .setStyle(ButtonStyle.Link)
            );

            const payload = { content: response, components: [row] };
            isSlash ? await interactionOrMessage.editReply(payload) : await interactionOrMessage.channel.send(payload);

        } catch (err: any) {
            console.error(err);
            const msg = `⚠️ Failed to fetch your track data.`;
            isSlash ? await interactionOrMessage.editReply(msg) : await interactionOrMessage.channel.send(msg);
        }
    }
}
