import { shoukaku } from '../../index';
import { Player } from 'shoukaku';
import { TextChannel, Message } from 'discord.js';
import { YoutubeResult } from '../api/Youtube';
import { config } from '../../../config';

export type RepeatMode = 'off' | 'one' | 'all';

export interface GuildQueue {
    textChannel: TextChannel;
    voiceChannelId: string;
    player: Player | null;
    tracks: YoutubeResult[];
    currentTrack: YoutubeResult | null;
    lastPlayedTrack?: YoutubeResult | null;
    lastStart?: number;
    isPlaying: boolean;
    isPaused: boolean;
    repeatMode: RepeatMode;
    repeatCount: number;
    consecutiveErrors: number;
    nowPlayingMessage?: Message;
    progressInterval?: NodeJS.Timeout;
    inactivityTimer?: NodeJS.Timeout;
    mixContext?: {
        songs: YoutubeResult[];
        index: number;
        title: string;
    };
    hasLyrics?: boolean;
    autoplay?: boolean;
    lastUpdate?: number;
}

const queues = new Map<string, GuildQueue>();

export class QueueManager {
    static getQueue(guildId: string): GuildQueue | undefined {
        return queues.get(guildId);
    }

    static createQueue(
        guildId: string, 
        textChannel: TextChannel, 
        voiceChannelId: string, 
        player: Player
    ): GuildQueue {
        const queue: GuildQueue = {
            textChannel,
            voiceChannelId,
            player,
            tracks: [],
            currentTrack: null,
            isPlaying: false,
            isPaused: false,
            repeatMode: 'off',
            repeatCount: 0,
            consecutiveErrors: 0,
        };

        queues.set(guildId, queue);
        return queue;
    }

    static deleteQueue(guildId: string): void {
        const queue = queues.get(guildId);
        if (!queue) return;

        if (queue.inactivityTimer) clearTimeout(queue.inactivityTimer);
        if (queue.progressInterval) clearInterval(queue.progressInterval);
        
        queue.player?.stopTrack();
        try {
            shoukaku.leaveVoiceChannel(guildId);
        } catch {}

        queues.delete(guildId);
    }

    static addTrack(guildId: string, track: YoutubeResult): number {
        const queue = queues.get(guildId);
        if (!queue) throw new Error(`No queue exists for guild ${guildId}`);

        queue.tracks.push(track);
        
        if (!queue.currentTrack && queue.tracks.length === 1) {
            return 0; // Means it should start playing immediately
        }

        return queue.tracks.length;
    }

    static getNextTrack(guildId: string): YoutubeResult | undefined {
        const queue = queues.get(guildId);
        if (!queue) return undefined;

        // If we have a current track and repeat is on, return it before shifting new ones
        if (queue.currentTrack) {
            if (queue.repeatMode === 'one') {
                queue.repeatCount++;
                return queue.currentTrack;
            } else if (queue.repeatMode === 'all') {
                queue.tracks.push(queue.currentTrack);
                // Continue to shift below
            }
        }

        queue.repeatCount = 0;
        const next = queue.tracks.shift();
        
        // If we didn't find a next track but 'all' is on, we might have just pushed it back
        // but if tracks was empty, it won't matter.
        return next;
    }

    static getNextMixTrack(guildId: string): YoutubeResult | undefined {
        const queue = queues.get(guildId);
        if (!queue?.mixContext) return undefined;

        const { songs, index } = queue.mixContext;
        if (index >= songs.length) {
            queue.mixContext = undefined;
            return undefined;
        }

        const track = songs[index];
        queue.mixContext.index = index + 1;
        return track;
    }

    static setRepeatMode(guildId: string, mode: RepeatMode): void {
        const queue = queues.get(guildId);
        if (queue) {
            queue.repeatMode = mode;
        }
    }

    static setMixContext(guildId: string, songs: YoutubeResult[], title: string): void {
        const queue = queues.get(guildId);
        if (!queue) return;
        queue.mixContext = { songs, index: 0, title };
    }

    static jump(guildId: string, position: number): YoutubeResult | undefined {
        const queue = queues.get(guildId);
        if (!queue || position < 1 || position > queue.tracks.length) return undefined;

        // Remove all tracks before the target position
        queue.tracks.splice(0, position - 1);
        return queue.tracks[0];
    }

    static move(guildId: string, from: number, to: number): YoutubeResult | undefined {
        const queue = queues.get(guildId);
        if (!queue || from < 1 || from > queue.tracks.length || to < 1 || to > queue.tracks.length) return undefined;

        const track = queue.tracks.splice(from - 1, 1)[0];
        queue.tracks.splice(to - 1, 0, track);
        return track;
    }

    static removeTrack(guildId: string, position: number): YoutubeResult | undefined {
        const queue = queues.get(guildId);
        if (!queue || position < 1 || position > queue.tracks.length) return undefined;

        return queue.tracks.splice(position - 1, 1)[0];
    }

    static clearQueue(guildId: string): void {
        const queue = queues.get(guildId);
        if (!queue) return;

        queue.tracks = [];
        queue.currentTrack = null;
        queue.isPlaying = false;
        queue.isPaused = false;
        queue.mixContext = undefined;
    }

    static shuffleQueue(guildId: string): void {
        const queue = queues.get(guildId);
        if (!queue || queue.tracks.length < 2) return;

        for (let i = queue.tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [queue.tracks[i], queue.tracks[j]] = [queue.tracks[j], queue.tracks[i]];
        }
    }
}
