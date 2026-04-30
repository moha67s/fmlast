import { prisma } from '../../database/client';
import { User as DBUser } from '@prisma/client';

export enum TimePeriod {
    Weekly = '7day',
    Monthly = '1month',
    Quarterly = '3month',
    HalfYearly = '6month',
    Yearly = '12month',
    AllTime = 'overall'
}

export interface TimeSettings {
    apiParameter: string;
    description: string;
    altDescription: string;
    playDays?: number;
    startDateTime?: Date;
    endDateTime?: Date;
    timeFrom?: number;
    timeUntil?: number;
    useCustomTimePeriod: boolean;
    searchValue: string;
}

export interface UserSettings {
    targetUser: DBUser;
    isDifferentUser: boolean;
    displayName: string;
    searchValue: string;
    /** The user's custom embed accent color as an integer, or the default */
    accentColor: number;
}

/**
 * SettingService — Advanced input parsing and entity resolution.
 * 
 * Ported from FMBot-dev SettingService.cs.
 * Handles:
 * - Timeframe parsing (7d, 3m, 2023, Jan 2024, etc.)
 * - Target resolution (me, @user, lfm:username)
 * - Numeric amount parsing
 */
export class SettingService {
    /**
     * Parse time period from options string.
     */
    static getTimePeriod(options: string, defaultPeriod: TimePeriod = TimePeriod.Weekly): TimeSettings {
        const end = new Date();
        const start = new Date(Date.now() - 7 * 86400 * 1000); // 7 days ago default
        
        const settings: TimeSettings = {
            apiParameter: defaultPeriod,
            description: 'Weekly',
            altDescription: 'last week',
            useCustomTimePeriod: false,
            searchValue: options || '',
            startDateTime: start,
            endDateTime: end,
            timeFrom: Math.floor(start.getTime() / 1000),
            timeUntil: Math.floor(end.getTime() / 1000)
        };

        if (!options) return settings;
        const lowOptions = options.toLowerCase();

        // 1. Specific Month (e.g. "2024-9", "2023/04", "Sep 2023")
        const monthMatch = options.match(/(\d{4})[-/](\d{1,2})/);
        if (monthMatch) {
            const year = parseInt(monthMatch[1], 10);
            const month = parseInt(monthMatch[2], 10) - 1;
            if (year >= 1970 && year <= 2100 && month >= 0 && month <= 11) {
                const start = new Date(year, month, 1);
                const end = new Date(year, month + 1, 0, 23, 59, 59);
                settings.startDateTime = start;
                settings.endDateTime = end;
                settings.timeFrom = Math.floor(start.getTime() / 1000);
                settings.timeUntil = Math.floor(end.getTime() / 1000);
                settings.description = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
                settings.altDescription = `month ${monthMatch[0]}`;
                settings.useCustomTimePeriod = true;
                settings.searchValue = options.replace(monthMatch[0], '').trim();
                return settings;
            }
        }

        const monthNameMatch = options.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i);
        if (monthNameMatch) {
            const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
            const monthIdx = monthNames.indexOf(monthNameMatch[1].toLowerCase().substring(0, 3));
            const year = parseInt(monthNameMatch[2], 10);
            if (monthIdx !== -1 && year >= 1970 && year <= 2100) {
                const start = new Date(year, monthIdx, 1);
                const end = new Date(year, monthIdx + 1, 0, 23, 59, 59);
                settings.startDateTime = start;
                settings.endDateTime = end;
                settings.timeFrom = Math.floor(start.getTime() / 1000);
                settings.timeUntil = Math.floor(end.getTime() / 1000);
                settings.description = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
                settings.altDescription = `month ${monthNameMatch[0]}`;
                settings.useCustomTimePeriod = true;
                settings.searchValue = options.replace(monthNameMatch[0], '').trim();
                return settings;
            }
        }

        // 2. Specific Year (e.g. "2023")
        const yearMatch = options.match(/\b(\d{4})\b/);
        if (yearMatch) {
            const year = parseInt(yearMatch[1], 10);
            if (year >= 1970 && year <= 2100) {
                const start = new Date(year, 0, 1);
                const end = new Date(year, 11, 31, 23, 59, 59);
                settings.startDateTime = start;
                settings.endDateTime = end;
                settings.timeFrom = Math.floor(start.getTime() / 1000);
                settings.timeUntil = Math.floor(end.getTime() / 1000);
                settings.description = `${year}`;
                settings.altDescription = `year ${year}`;
                settings.useCustomTimePeriod = true;
                settings.searchValue = options.replace(yearMatch[0], '').trim();
                return settings;
            }
        }

        // 3. Static Periods
        const periods: Record<string, { api: string, desc: string, alt: string, days: number }> = {
            'd': { api: 'day', desc: 'Daily', alt: 'today', days: 1 },
            'day': { api: 'day', desc: 'Daily', alt: 'today', days: 1 },
            'today': { api: 'day', desc: 'Daily', alt: 'today', days: 1 },

            'w': { api: '7day', desc: 'Weekly', alt: 'last week', days: 7 },
            '7d': { api: '7day', desc: 'Weekly', alt: 'last week', days: 7 },
            'week': { api: '7day', desc: 'Weekly', alt: 'last week', days: 7 },
            '7day': { api: '7day', desc: 'Weekly', alt: 'last week', days: 7 },
            
            'm': { api: '1month', desc: 'Monthly', alt: 'last month', days: 30 },
            '1m': { api: '1month', desc: 'Monthly', alt: 'last month', days: 30 },
            'month': { api: '1month', desc: 'Monthly', alt: 'last month', days: 30 },
            '1month': { api: '1month', desc: 'Monthly', alt: 'last month', days: 30 },
            '30d': { api: '1month', desc: 'Monthly', alt: 'last month', days: 30 },

            'q': { api: '3month', desc: 'Quarterly', alt: 'last quarter', days: 90 },
            '3m': { api: '3month', desc: 'Quarterly', alt: 'last quarter', days: 90 },
            'quarter': { api: '3month', desc: 'Quarterly', alt: 'last quarter', days: 90 },
            '3month': { api: '3month', desc: 'Quarterly', alt: 'last quarter', days: 90 },

            '6m': { api: '6month', desc: 'Half-yearly', alt: 'last half year', days: 180 },
            'half': { api: '6month', desc: 'Half-yearly', alt: 'last half year', days: 180 },
            '6month': { api: '6month', desc: 'Half-yearly', alt: 'last half year', days: 180 },

            'y': { api: '12month', desc: 'Yearly', alt: 'last year', days: 365 },
            '1y': { api: '12month', desc: 'Yearly', alt: 'last year', days: 365 },
            'year': { api: '12month', desc: 'Yearly', alt: 'last year', days: 365 },
            '12m': { api: '12month', desc: 'Yearly', alt: 'last year', days: 365 },
            '12month': { api: '12month', desc: 'Yearly', alt: 'last year', days: 365 },

            'overall': { api: 'overall', desc: 'Overall', alt: 'all-time', days: 9999 },
            'at': { api: 'overall', desc: 'Overall', alt: 'all-time', days: 9999 },
            'alltime': { api: 'overall', desc: 'Overall', alt: 'all-time', days: 9999 }
        };

        const words = lowOptions.split(/\s+/);
        for (const word of words) {
            if (periods[word]) {
                const p = periods[word];
                settings.apiParameter = p.api;
                settings.description = p.desc;
                settings.altDescription = p.alt;
                settings.playDays = p.days;
                settings.searchValue = options.replace(new RegExp(`\\b${word}\\b`, 'gi'), '').trim();

                // Assign actual Date objects for native DB querying (skip for 'overall')
                if (p.api !== 'overall') {
                    const start = new Date(Date.now() - p.days * 86400 * 1000);
                    const end = new Date();
                    settings.startDateTime = start;
                    settings.endDateTime = end;
                    settings.timeFrom = Math.floor(start.getTime() / 1000);
                    settings.timeUntil = Math.floor(end.getTime() / 1000);
                    // Explicitly flag it so our commands treat it as a filterable DB range
                    // but we keep `useCustomTimePeriod` false to preserve 'description' formatting
                }

                return settings;
            }
        }

        return settings;
    }

    /**
     * Resolve target user from mentions, usernames, or 'me'.
     */
    static async getUser(options: string, requester: DBUser): Promise<UserSettings> {
        const settings: UserSettings = {
            targetUser: requester,
            isDifferentUser: false,
            displayName: 'You',
            searchValue: options || '',
            accentColor: SettingService.resolveAccentColor(requester)
        };

        if (!options) return settings;

        const words = options.trim().split(/\s+/);
        const firstWord = words[0];

        // 1. Check for Discord Mentions <@ID> or <@!ID>
        const mentionMatch = firstWord.match(/<@!?(\d+)>/);
        const idMatch = firstWord.match(/^\d{17,19}$/);
        const targetId = mentionMatch ? mentionMatch[1] : (idMatch ? idMatch[0] : null);

        if (targetId) {
            const user = await prisma.user.findUnique({ where: { discordId: targetId } });
            if (user) {
                settings.targetUser = user;
                settings.isDifferentUser = user.id !== requester.id;
                settings.displayName = user.lastfmUsername || 'User';
                settings.searchValue = words.slice(1).join(' ');
                settings.accentColor = SettingService.resolveAccentColor(user);
                return settings;
            }
        }

        // 2. Check for lfm:username
        if (firstWord.startsWith('lfm:')) {
            const lfmUsername = firstWord.substring(4);
            const user = await prisma.user.findFirst({
                where: { lastfmUsername: { equals: lfmUsername, mode: 'insensitive' } }
            });
            if (user) {
                settings.targetUser = user;
                settings.isDifferentUser = true;
                settings.displayName = user.lastfmUsername!;
                settings.searchValue = words.slice(1).join(' ');
                settings.accentColor = SettingService.resolveAccentColor(user);
                return settings;
            }
        }

        return settings;
    }

    /**
     * Parse numeric amount (e.g. "10" from "top 10")
     */
    static getAmount(options: string, defaultValue: number = 10, max: number = 50): { amount: number, searchValue: string } {
        if (!options) return { amount: defaultValue, searchValue: '' };

        const words = options.split(/\s+/);
        for (const word of words) {
            const num = parseInt(word, 10);
            if (!isNaN(num) && num > 0 && num <= 2000000) {
                const finalAmount = Math.min(num, max);
                const remaining = options.replace(new RegExp(`\\b${word}\\b`), '').trim();
                return { amount: finalAmount, searchValue: remaining };
            }
        }

        return { amount: defaultValue, searchValue: options };
    }

    /** Default accent color used when the user hasn't set a custom one */
    static readonly DEFAULT_ACCENT = 0x0a0a0b;

    /**
     * Resolve a user's accent color from their DB settings.
     * Returns the user's custom embedColor or the default.
     */
    static resolveAccentColor(user: DBUser): number {
        const hex = (user.settings as any)?.embedColor;
        if (hex && typeof hex === 'string') {
            const parsed = parseInt(hex.replace('#', ''), 16);
            if (!isNaN(parsed)) return parsed;
        }
        return SettingService.DEFAULT_ACCENT;
    }
}
