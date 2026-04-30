import { Message, TextChannel, VoiceChannel, ComponentType, ButtonStyle } from "discord.js";
import { ScrobbleService } from './ScrobbleService';
import { LastFM } from '../api/LastFM';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { Spotify } from '../api/Spotify';
import { Deezer } from '../api/Deezer';

const BOT_IDS = new Set([
    '411916947773587456', // Jockie 1
    '412347257233604609', // Jockie 2
    '451379187031343104', // Jockie 3/4
    '783720725846425630', // GreenBot
    '462966833444454423', // Maki
    '184405311681986560', // FredBoat
]);

export class MusicBotService {
    /** 
     * Observe a message to see if it's a "Now Playing" embed from a music bot 
     */
    static async handleMessage(message: Message) {
        if (!message.guild || !message.author.bot) return;

        // Optimized check: Is this a known music bot?
        const isKnown = BOT_IDS.has(message.author.id);
        const nameLower = message.author.username.toLowerCase();
        const isLikely = nameLower.includes('jockie') || nameLower.includes('green') || nameLower.includes('luna') || nameLower.includes('maki');

        if (!isKnown && !isLikely) return;

        const embed = message.embeds[0];
        if (!embed) return;

        const title = embed.title?.toLowerCase() || '';
        const description = embed.description || '';

        // Most bots have "playing" or "now playing" in title or description
        if (!title.includes('playing') && !description.toLowerCase().includes('playing') && !description.toLowerCase().includes('started')) return;

        let track: string | null = null;
        let artist: string | null = null;
        let album: string | undefined;

        let rawTrack = '';
        let rawArtist = '';

        // 1. Parsing Logic for Jockie / Luna / Standard Markdown
        // Format options: 
        // - [Track Name](URL)
        // - [Track Name **by** Artist Name](URL)
        // - [Track Name" by "Artist Name](URL)
        const markdownMatch = description.match(/\[(.+?)\]\(https?:\/\/.+?\)/);
        if (markdownMatch) {
            const rawContent = markdownMatch[1];
            
            // Try splitting by " by " (case insensitive, with or without markdown)
            const splitMatch = rawContent.match(/(.+?)(?:\s+(?:\*\*|")?by(?:\*\*|")?\s+)(.+)/i);
            if (splitMatch) {
                rawTrack = splitMatch[1];
                rawArtist = splitMatch[2];
            } else {
                rawTrack = rawContent;
            }
        }

        // 2. Fallback: Parse "Track - Artist" or "Artist - Track" in Description
        if (!rawTrack || !rawArtist) {
            const lines = description.split('\n');
            for (const line of lines) {
                const parts = line.split(' - ');
                if (parts.length >= 2) {
                    if (!rawTrack) rawTrack = parts[0];
                    if (!rawArtist) rawArtist = parts[1];
                    break;
                }
            }
        }

        // 3. Fallback: Check Embed Fields
        if (!rawTrack && embed.fields.length > 0) {
            const trackField = embed.fields.find(f => f.name.toLowerCase().includes('track') || f.name.toLowerCase().includes('title'));
            const artistField = embed.fields.find(f => f.name.toLowerCase().includes('artist') || f.name.toLowerCase().includes('author'));
            if (trackField) rawTrack = trackField.value;
            if (artistField) rawArtist = artistField.value;
        }

        if (!rawTrack && embed.title && !embed.title.toLowerCase().includes('playing')) {
            rawTrack = embed.title;
        }

        // ── CLEANUP UTILITY ──
        const clean = (str: string) => {
            return str
                .replace(/<a?:\w+:\d+>/g, '') // Remove custom emojis
                .replace(/^started playing/i, '')
                .replace(/^playing/i, '')
                .replace(/^now playing/i, '')
                .replace(/\*\*/g, '') // Remove bold
                .replace(/__/g, '') // Remove underline
                .replace(/`/g, '')  // Remove code
                .replace(/["\\]/g, '') // Remove quotes and backslashes
                .trim();
        };

        track = clean(rawTrack);
        artist = rawArtist ? clean(rawArtist) : null;
        
        if (!track) return;

        // Final split attempt if artist is still missing
        if (!artist && track.includes(' - ')) {
            const parts = track.split(' - ');
            artist = clean(parts[0]);
            track = clean(parts[1]);
        }

        if (!artist) artist = 'Unknown Artist';

        // ── METADATA RESOLUTION ──
        let resolvedTrack = track;
        let resolvedArtist = artist;
        let resolvedAlbum = album;

        try {
            const info = await LastFM.getTrackInfo(artist, track);
            if (info) {
                resolvedTrack = info.name;
                resolvedArtist = info.artist?.name || info.artist;
                resolvedAlbum = info.album?.title || album;
                console.log(`[MusicBot] Resolved: "${track}" by "${artist}" -> "${resolvedTrack}" by "${resolvedArtist}"`);
            }
        } catch (err) {
            // If getTrackInfo fails, try a fuzzy search as a second chance
            try {
                const searchResults = await LastFM.searchTracks(`${artist} ${track}`);
                if (searchResults && searchResults.length > 0) {
                    const topResult = searchResults[0];
                    resolvedTrack = topResult.name;
                    resolvedArtist = topResult.artist;
                    console.log(`[MusicBot] Fuzzy Resolved: "${track}" by "${artist}" -> "${resolvedTrack}" by "${resolvedArtist}"`);
                } else {
                    console.log(`[MusicBot] Skipping unverified track: "${track}" by "${artist}" (Not found on Last.fm)`);
                    return; // Skip as per user request
                }
            } catch (searchErr) {
                console.log(`[MusicBot] Skipping unverified track: "${track}" by "${artist}" (Search failed)`);
                return;
            }
        }

        // ── SCROBBLE ACTION ──
        
        // Debug: Check voice state cache
        const cacheSize = message.guild.voiceStates.cache.size;
        const authorVoiceState = message.guild.voiceStates.cache.get(message.author.id);
        let voiceChannelId = authorVoiceState?.channelId;
        
        // Fallback: fetch member if cache is empty (unlikely with Intent enabled)
        if (!voiceChannelId) {
            console.log(`[MusicBot] Cache miss for ${message.author.username}. Cache size: ${cacheSize}. Fetching member...`);
            const botMember = await message.guild.members.fetch(message.author.id).catch(() => null);
            voiceChannelId = botMember?.voice.channelId;
        }

        if (!voiceChannelId) {
            console.log(`[MusicBot] Bot ${message.author.username} (${message.author.id}) is NOT in a voice channel. Skipping.`);
            console.log(`[MusicBot] Debug: Author VoiceState in Cache: ${JSON.stringify(authorVoiceState)}`);
            return;
        }

        const voiceChannel = await message.guild.channels.fetch(voiceChannelId) as VoiceChannel;
        if (!voiceChannel) return;

        // Get IDs of everyone in the same VC (excluding bots)
        const listenerDiscordIds = voiceChannel.members
            .filter(m => !m.user.bot)
            .map(m => m.id);

        if (listenerDiscordIds.length === 0) {
            console.log(`[MusicBot] No listeners in ${voiceChannel.name}. Skipping.`);
            return;
        }

        console.log(`[MusicBot] Verified: "${resolvedTrack}" by "${resolvedArtist}". Scrobbling for ${listenerDiscordIds.length} listeners in ${voiceChannel.name}.`);

        // Scrobble for all of them immediately (per user spec)
        await ScrobbleService.scrobbleForUsers(listenerDiscordIds, {
            artist: resolvedArtist,
            track: resolvedTrack,
            album: resolvedAlbum
        });

        // ── PREMIUM UI NOTIFICATION ──
        const formatDuration = (ms?: number | string) => {
            if (!ms) return '0:00';
            const totalSeconds = Math.floor(Number(ms) / 1000);
            if (totalSeconds <= 0) return '0:00';
            const minutes = Math.floor(totalSeconds / 60);
            const seconds = totalSeconds % 60;
            return `${minutes}:${seconds.toString().padStart(2, '0')}`;
        };

        const resolveDuration = async (artist: string, track: string): Promise<number> => {
            // 1. Try Last.fm
            const lfm = await LastFM.getTrackInfo(artist, track).catch(() => null);
            if (lfm?.duration && Number(lfm.duration) > 0) return Number(lfm.duration);

            // 2. Try Spotify
            const sp = await Spotify.getTrackInfo(track, artist).catch(() => null);
            if (sp?.durationMs && sp.durationMs > 0) {
                console.log(`[MusicBot] Resolved duration from Spotify for "${track}"`);
                return sp.durationMs;
            }

            // 3. Try Deezer
            const dz = await Deezer.searchTrack(artist, track).catch(() => null);
            if (dz?.durationMs && dz.durationMs > 0) {
                console.log(`[MusicBot] Resolved duration from Deezer for "${track}"`);
                return dz.durationMs;
            }

            return 0;
        };

        const durationMs = await resolveDuration(resolvedArtist, resolvedTrack);
        const duration = formatDuration(durationMs);

        const builder = new ComponentsV2()
            .setAccent(0xd80000) // hsla(0, 100%, 36.5%, 1)
            .addText(`၊،||၊ Scrobbling **${resolvedTrack}** by **${resolvedArtist}** for ${listenerDiscordIds.length} listener${listenerDiscordIds.length === 1 ? '' : 's'}`)
            .addAction(`Length ${duration} — ${message.author.username}`, {
                type: ComponentType.Button,
                custom_id: 'user-setting-botscrobbling-manage',
                style: ButtonStyle.Secondary,
                label: 'Manage'
            });

        try {
            await (message.channel as TextChannel).send(builder.build());
        } catch (err) {
            console.error(`[MusicBot] Failed to send notification:`, err);
        }
    }
}
