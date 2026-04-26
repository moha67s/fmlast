import { Message } from 'discord.js';
import { QueueManager } from './QueueManager';
import { ComponentsV2 } from '../../utils/ComponentsV2';

export interface SyncedLyric {
    timestamp: number;
    line: string;
}

export class LyricsService {
    /** Active update intervals keyed by guildId */
    private static activeIntervals = new Map<string, NodeJS.Timeout>();
    /** Stored synced lines keyed by guildId — used by "Full Lyrics" button */
    private static storedLines = new Map<string, SyncedLyric[]>();
    /** The live message for each guild so we can delete it on track change */
    private static lyricsMessages = new Map<string, Message>();

    // ─────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Send an initial "syncing" message and start the live update loop.
     * Returns the sent message so the caller can store it.
     */
    static async startLiveLyrics(
        guildId: string,
        message: Message,
        lines: SyncedLyric[]
    ): Promise<void> {
        this.stopLiveLyrics(guildId);           // Clear any existing session
        this.storedLines.set(guildId, lines);
        this.lyricsMessages.set(guildId, message);

        const interval = setInterval(async () => {
            const q = QueueManager.getQueue(guildId);
            if (!q || !q.player || !q.isPlaying) {
                this.stopLiveLyrics(guildId);
                return;
            }

            const frame = this.buildLiveLyricsUI(lines, q.player.position, guildId);
            frame.content = '';
            await message.edit(frame).catch((err) => {
                console.error('[LyricsService] Error editing interval frame:', err);
                this.stopLiveLyrics(guildId);
            });
        }, 3500);                               // Every 3.5 s — responsive but rate-limit safe

        this.activeIntervals.set(guildId, interval);
    }

    /** Stop the sync loop (call on track change, stop, disconnect) */
    static stopLiveLyrics(guildId: string): void {
        const interval = this.activeIntervals.get(guildId);
        if (interval) {
            clearInterval(interval);
            this.activeIntervals.delete(guildId);
        }
    }

    /** Stop and delete the lyrics message (call when a new track starts) */
    static cleanupForGuild(guildId: string): void {
        this.stopLiveLyrics(guildId);
        const msg = this.lyricsMessages.get(guildId);
        if (msg) {
            msg.delete().catch(() => {});
            this.lyricsMessages.delete(guildId);
        }
        this.storedLines.delete(guildId);
    }

    /** Get the stored lines for the "Full Lyrics" button */
    static getStoredLines(guildId: string): SyncedLyric[] | null {
        return this.storedLines.get(guildId) ?? null;
    }

    // ─────────────────────────────────────────────────────────────────────
    // UI builder
    // ─────────────────────────────────────────────────────────────────────

    static buildLiveLyricsUI(
        lines: SyncedLyric[],
        currentPos: number,
        guildId: string
    ) {
        // Find the currently active line
        let currentIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (currentPos >= lines[i].timestamp) {
                const next = lines[i + 1];
                if (!next || currentPos < next.timestamp) {
                    currentIndex = i;
                }
            }
        }
        // Before song starts → show first line
        if (currentIndex === -1 && lines.length > 0 && currentPos < lines[0].timestamp) {
            currentIndex = 0;
        }

        // Sliding window: 3 before, current (bolded), 3 after
        const start = Math.max(0, currentIndex - 3);
        const end   = Math.min(lines.length, currentIndex + 4);

        let lyricsText = '';
        for (let i = start; i < end; i++) {
            const line = lines[i].line || '♪';
            if (i === currentIndex) {
                lyricsText += `> **${line}**\n`;    // Current line: blockquote + bold
            } else if (Math.abs(i - currentIndex) === 1) {
                lyricsText += `${line}\n`;           // Adjacent lines: normal
            } else {
                lyricsText += `-# ${line}\n`;        // Far lines: dimmed
            }
        }

        const progress = currentIndex >= 0
            ? `*Line ${currentIndex + 1} of ${lines.length}*`
            : '*Waiting for song to start...*';

        const builder = new ComponentsV2()
            .setAccent(0x1DB954)
            .addText(
                `### 🎤 Live Lyrics\n\n${lyricsText || '*♪ Instrumental ♪*'}\n\n-# ${progress} • Synced via LRCLib`
            )
            .addRow([
                { type: 2, style: 2, label: '📜 Full Lyrics', custom_id: `mp-lyrics-full:${guildId}` },
                { type: 2, style: 4, label: '⏹️ Stop Sync',  custom_id: `mp-lyrics-stop:${guildId}` }
            ]);

        return builder.build();
    }

    /** Build the static "full lyrics" view */
    static buildFullLyricsUI(lines: SyncedLyric[] | null, plainText: string | null) {
        const text = lines
            ? lines.map(l => l.line || '♪').join('\n')
            : (plainText ?? '*No lyrics available.*');

        const truncated = text.length > 3800 ? text.substring(0, 3800) + '\n...' : text;

        return new ComponentsV2()
            .setAccent(0x1DB954)
            .addText(`### 📜 Full Lyrics\n\n${truncated}`)
            .build();
    }
}
