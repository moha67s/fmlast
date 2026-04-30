import { ComponentType, ButtonStyle } from "discord.js";
import { LastFM } from '../api/LastFM';
import { prisma } from '../../database/client';

const DAYS   = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

/** Fallback only used when no track duration data is available at all — mirrors fmbot */
const FALLBACK_SECONDS_PER_PLAY = 210;

// ─────────────────────────── helpers ───────────────────────────

function getLongListeningTimeString(totalSeconds: number): string {
    const days    = Math.floor(totalSeconds / 86400);
    const hours   = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (days >= 2) return `${days} days${hours > 0 ? `, ${hours} hour${hours === 1 ? '' : 's'}` : ''}`;
    if (days === 1) return `1 day${hours > 0 ? `, ${hours} hour${hours === 1 ? '' : 's'}` : ''}`;
    if (hours >= 2) return `${hours} hours${minutes > 0 ? `, ${minutes} minutes` : ''}`;
    if (hours === 1) return `1 hour${minutes > 0 ? `, ${minutes} minutes` : ''}`;
    return `${minutes} minutes`;
}

function getMonthBounds(year: number, month: number): { from: number; to: number } {
    const from = Math.floor(Date.UTC(year, month, 1) / 1000);
    const to   = Math.floor(Date.UTC(year, month + 1, 1) / 1000) - 1;
    return { from, to };
}

function extractAvatar(userInfo: any): string {
    const images: any[] = userInfo.image || [];
    const img =
        images.find((i: any) => i.size === 'extralarge') ||
        images.find((i: any) => i.size === 'large') ||
        images[images.length - 1];
    return img?.['#text'] || '';
}

/**
 * Compute a weighted-average track duration (seconds) for listening-time estimates.
 *
 * Priority:
 *  1. Rows in `user_tracks` that already have a real `duration` from Last.fm
 *     (populated lazily by QueueWorker.backfillTrackDurations after each sync).
 *     Weighted by playcount so heavily-replayed tracks dominate — same logic as fmbot.
 *  2. Fall back to fetching the user's top 200 tracks from the Last.fm API and
 *     deriving the weighted average from their `duration` field.
 *  3. Hard-coded 210 s (fmbot's last-resort fallback) if everything else fails.
 */
async function getWeightedAvgDuration(userId: string, username: string, sessionKey: string | null): Promise<number> {
    // ── 1. DB durations (most accurate) ──
    try {
        const rows = await prisma.userTrack.findMany({
            where: { userId, duration: { gt: 0 } },
            select: { playcount: true, duration: true },
        });
        if (rows.length > 0) {
            let weightedSum = 0;
            let totalPlays  = 0;
            for (const r of rows) {
                let dur = (r.duration as number);
                // Safety check: if duration > 5000 (83 min), it's definitely milliseconds.
                // This fixes existing corrupted data on the fly.
                if (dur > 5000) dur = Math.floor(dur / 1000);

                weightedSum += dur * r.playcount;
                totalPlays  += r.playcount;
            }
            if (totalPlays > 0) return Math.round(weightedSum / totalPlays);
        }
    } catch { /* fall through */ }

    // ── 2. Last.fm API top-tracks (good approximation while DB fills up) ──
    try {
        const tracks = await LastFM.getTopTracks(username, 'overall', 200, sessionKey);
        let weightedSum = 0;
        let totalPlays  = 0;
        for (const t of tracks) {
            let dur     = parseInt(t.duration  || '0', 10);
            const plays = parseInt(t.playcount || '1', 10);
            
            // Convert ms to seconds
            if (dur > 0) dur = Math.floor(dur / 1000);

            if (dur > 0) { weightedSum += dur * plays; totalPlays += plays; }
        }
        if (totalPlays > 0) return Math.round(weightedSum / totalPlays);
    } catch { /* fall through */ }

    // ── 3. Hard fallback ──
    return FALLBACK_SECONDS_PER_PLAY;
}

// ─────────────────────────── service ───────────────────────────

export class ProfileService {

    // ──────────────────────────── PROFILE VIEW ────────────────────────────

    static async buildProfilePayload(dbUser: any, invokerDiscordId: string): Promise<any> {
        const username        = dbUser.lastfmUsername as string;
        const sessionKey      = dbUser.lastfmSessionKey as string | null;
        const targetDiscordId = dbUser.discordId as string;

        const [userInfo, topArtists, recentTracks] = await Promise.all([
            LastFM.getUserInfo(username, sessionKey),
            LastFM.getTopArtists(username, 'overall', 10, sessionKey),
            LastFM.getRecentTracks(username, 1000, sessionKey),
        ]);

        const playcount   = parseInt(userInfo.playcount             || '0', 10);
        const trackCount  = parseInt(userInfo.track_count  || userInfo.trackcount  || '0', 10);
        const albumCount  = parseInt(userInfo.album_count  || userInfo.albumcount  || '0', 10);
        const artistCount = parseInt(userInfo.artist_count || userInfo.artistcount || '0', 10);
        const registeredUnix = parseInt(userInfo.registered?.unixtime || '0', 10);
        const avatarUrl   = extractAvatar(userInfo);

        // Averages
        const totalDays       = Math.max(1, (Date.now() / 1000 - registeredUnix) / 86400);
        const avgPerDay       = Math.round(playcount / totalDays);
        const albumsPerArtist = artistCount > 0 ? (albumCount  / artistCount).toFixed(1) : '0';
        const tracksPerArtist = artistCount > 0 ? (trackCount  / artistCount).toFixed(1) : '0';

        // Top-10 artist percentage
        let top10Pct = '0';
        if (topArtists.length > 0 && playcount > 0) {
            const top10Sum = topArtists
                .slice(0, 10)
                .reduce((s: number, a: any) => s + parseInt(a.playcount || '0', 10), 0);
            top10Pct = ((top10Sum / playcount) * 100).toFixed(1);
        }

        // Most active day of week (UTC, mirrors fmbot exactly)
        let mostActiveDay = '';
        const filtered = (recentTracks as any[]).filter(
            (t: any) => !t['@attr']?.nowplaying && t.date?.uts
        );
        if (filtered.length > 0) {
            const dayCounts = new Array(7).fill(0);
            for (const t of filtered) {
                dayCounts[new Date(parseInt(t.date.uts, 10) * 1000).getUTCDay()]++;
            }
            let maxIdx = 0;
            for (let i = 1; i < 7; i++) if (dayCounts[i] > dayCounts[maxIdx]) maxIdx = i;
            mostActiveDay = DAYS[maxIdx];
        }

        // ── Build text blocks ──
        const headerText = [
            `## [${username}](https://last.fm/user/${username})`,
            `**${playcount.toLocaleString('en-US')}** scrobbles`,
            `Since <t:${registeredUnix}:D>`,
        ].join('\n');

        const statsBlock1 = [
            `**${trackCount.toLocaleString('en-US')}** different tracks`,
            `**${albumCount.toLocaleString('en-US')}** different albums`,
            `**${artistCount.toLocaleString('en-US')}** different artists`,
        ].join('\n');

        const statsLines: string[] = [];
        statsLines.push(`Average of **${avgPerDay.toLocaleString('en-US')}** scrobbles per day`);
        if (artistCount > 0) {
            statsLines.push(
                `Average of **${albumsPerArtist}** albums and **${tracksPerArtist}** tracks per artist`
            );
        }
        if (playcount > 0 && topArtists.length > 0) {
            statsLines.push(`Top **10** artists make up **${top10Pct}%** of scrobbles`);
        }
        if (mostActiveDay) {
            statsLines.push(`Most active day of the week is **${mostActiveDay}**`);
        }

        const container: any = {
            type: 17,
            spoiler: false,
            components: [
                {
                    type: 9,
                    components: [{ type: ComponentType.TextDisplay, content: headerText }],
                    accessory: { type: ComponentType.Thumbnail, media: { url: avatarUrl }, description: null, spoiler: false },
                },
                { type: ComponentType.Separator, divider: true, spacing: 1 },
                { type: ComponentType.TextDisplay, content: statsBlock1 },
                { type: ComponentType.Separator, divider: true, spacing: 1 },
                { type: ComponentType.TextDisplay, content: statsLines.join('\n') },
            ],
        };

        const actionRow: any = {
            type: ComponentType.ActionRow,
            components: [
                {
                    type: ComponentType.Button,
                    custom_id: `user-history:${invokerDiscordId}:${targetDiscordId}`,
                    style: ButtonStyle.Secondary,
                    label: 'History',
                    emoji: { name: '📖' },
                },
                {
                    type: ComponentType.Button,
                    style: ButtonStyle.Link,
                    url: `https://last.fm/user/${username}`,
                    label: 'Last.fm',
                    emoji: { id: '882227627287515166', name: 'services_lastfm' },
                },
            ],
        };

        return { components: [container, actionRow], flags: 32768 };
    }

    // ──────────────────────────── HISTORY VIEW ────────────────────────────

    static async buildHistoryPayload(dbUser: any, invokerDiscordId: string): Promise<any> {
        const username        = dbUser.lastfmUsername as string;
        const sessionKey      = dbUser.lastfmSessionKey as string | null;
        const targetDiscordId = dbUser.discordId as string;

        // Fetch user info + weighted avg duration in parallel
        const [userInfo, secsPerPlay] = await Promise.all([
            LastFM.getUserInfo(username, sessionKey),
            getWeightedAvgDuration(dbUser.id, username, sessionKey),
        ]);

        const playcount      = parseInt(userInfo.playcount            || '0', 10);
        const registeredUnix = parseInt(userInfo.registered?.unixtime || '0', 10);
        const avatarUrl      = extractAvatar(userInfo);

        console.log(`[profile/history] ${username} — weighted avg duration: ${secsPerPlay}s/play`);

        // Fetch last 6 months sequentially (avoids rate-limit burst)
        const now = new Date();
        const monthlyLines: string[] = [];

        for (let i = 0; i < 6; i++) {
            let month = now.getUTCMonth() - i;
            let year  = now.getUTCFullYear();
            if (month < 0) { month += 12; year--; }
            const { from, to } = getMonthBounds(year, month);

            try {
                const count = await LastFM.getScrobbleCountForPeriod(username, from, to, sessionKey);
                if (count > 0) {
                    const listeningTime = getLongListeningTimeString(count * secsPerPlay);
                    monthlyLines.push(
                        `**\`${MONTHS[month]}\`** - **${count.toLocaleString('en-US')}** plays - **${listeningTime}**`
                    );
                }
            } catch {
                // skip failed months silently
            }
        }

        const historyContent = monthlyLines.length > 0
            ? `**Last months**\n${monthlyLines.join('\n')}`
            : 'No listening history found for the last 6 months.';

        const headerText = [
            `## [${username}](https://last.fm/user/${username})'s history`,
            `**${playcount.toLocaleString('en-US')}** scrobbles`,
            `Since <t:${registeredUnix}:D>`,
        ].join('\n');

        const container: any = {
            type: 17,
            spoiler: false,
            components: [
                {
                    type: 9,
                    components: [{ type: ComponentType.TextDisplay, content: headerText }],
                    accessory: { type: ComponentType.Thumbnail, media: { url: avatarUrl }, description: null, spoiler: false },
                },
                { type: ComponentType.Separator, divider: true, spacing: 1 },
                { type: ComponentType.TextDisplay, content: historyContent },
            ],
        };

        const actionRow: any = {
            type: ComponentType.ActionRow,
            components: [
                {
                    type: ComponentType.Button,
                    custom_id: `user-profile:${invokerDiscordId}:${targetDiscordId}`,
                    style: ButtonStyle.Secondary,
                    label: 'Profile',
                    emoji: { name: 'ℹ' },
                },
                {
                    type: ComponentType.Button,
                    style: ButtonStyle.Link,
                    url: `https://last.fm/user/${username}`,
                    label: 'Last.fm',
                    emoji: { id: '882227627287515166', name: 'services_lastfm' },
                },
            ],
        };

        return { components: [container, actionRow], flags: 32768 };
    }
}
