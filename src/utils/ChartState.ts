export interface ChartEditState {
    userId: string;
    size: number;
    period: string;
    skipNoImage: boolean;
    sfwOnly: boolean;
    hideSingles: boolean;
    releaseFilter: string;
    username: string;
}

export class ChartState {
    
    static encode(state: ChartEditState): string {
        const bits = (state.skipNoImage ? 1 : 0) | (state.sfwOnly ? 2 : 0) | (state.hideSingles ? 4 : 0);
        const rf = this.base64UrlEncode(state.releaseFilter || '');
        const user = this.base64UrlEncode(state.username || '');
        const periodKey = this.periodToKey(state.period);
        // Format: <userId>:<size><periodKey><bits>:<rf>:<user>
        return `${state.userId}:${state.size}${periodKey}${bits}:${rf}:${user}`;
    }

    static encodeNoPeriod(state: ChartEditState): string {
        const bits = (state.skipNoImage ? 1 : 0) | (state.sfwOnly ? 2 : 0) | (state.hideSingles ? 4 : 0);
        const rf = this.base64UrlEncode(state.releaseFilter || '');
        const user = this.base64UrlEncode(state.username || '');
        // Format: <userId>:<size>_<bits>:<rf>:<user>  (using _ as placeholder for period)
        return `${state.userId}:${state.size}_${bits}:${rf}:${user}`;
    }

    static decode(stateStr: string): ChartEditState {
        const parts = stateStr.split(':');
        
        // Handle legacy format (for backward compatibility if needed, though we said it's breaking)
        if (parts.length > 5) {
            return {
                userId: parts[0],
                size: parseInt(parts[1]) || 3,
                period: parts[2] || 'weekly',
                skipNoImage: parts[3] === '1',
                sfwOnly: parts[4] === '1',
                hideSingles: parts[5] === '1',
                releaseFilter: (parts[6] === '_' || !parts[6]) ? '' : parts[6],
                username: parts[7] || '',
            };
        }

        const userId = parts[0];
        const fixed = parts[1];
        const size = parseInt(fixed[0]) || 3;
        const bits = parseInt(fixed[fixed.length - 1]) || 0;
        const periodKey = fixed.substring(1, fixed.length - 1);
        
        return {
            userId,
            size,
            period: periodKey === '_' ? 'weekly' : this.keyToPeriod(periodKey),
            skipNoImage: (bits & 1) !== 0,
            sfwOnly: (bits & 2) !== 0,
            hideSingles: (bits & 4) !== 0,
            releaseFilter: this.base64UrlDecode(parts[2]),
            username: this.base64UrlDecode(parts[3]),
        };
    }

    static decodeNoPeriod(stateStr: string, period: string): ChartEditState {
        const state = this.decode(stateStr);
        state.period = period;
        return state;
    }

    private static periodToKey(period: string): string {
        const map: Record<string, string> = { daily: 'd', weekly: 'w', monthly: 'm', yearly: 'y', overall: 'o' };
        if (map[period]) return map[period];
        if (period.startsWith('month-')) return 'M' + period.substring(6).replace(/-/g, '');
        if (period.startsWith('year-')) return 'Y' + period.substring(5);
        return 'w';
    }

    private static keyToPeriod(key: string): string {
        const map: Record<string, string> = { d: 'daily', w: 'weekly', m: 'monthly', y: 'yearly', o: 'overall' };
        if (map[key]) return map[key];
        if (key.startsWith('M')) return `month-${key.substring(1, 5)}-${key.substring(5)}`;
        if (key.startsWith('Y')) return `year-${key.substring(1)}`;
        return 'weekly';
    }

    private static base64UrlEncode(str: string): string {
        return Buffer.from(str).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') || '_';
    }

    private static base64UrlDecode(str: string): string {
        if (str === '_') return '';
        return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    }
}
