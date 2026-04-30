import { prisma } from '../../database/client';

export interface TopResult {
    name: string;
    artistName?: string;
    playcount: number;
}

export interface EraResult {
    era_start: Date;
    artist_name: string;
    playcount: number;
}

export class StatsService {
    /**
     * Fetches top artists for a user within a timestamp range using local DB.
     */
    static async getTopArtists(userId: string, from: Date, to: Date, limit: number = 10): Promise<TopResult[]> {
        const results: any[] = await prisma.$queryRaw`
            SELECT artist_name as name, CAST(COUNT(*) AS INTEGER) as playcount
            FROM user_plays
            WHERE user_id = ${userId} AND time_played >= ${from} AND time_played <= ${to}
            GROUP BY artist_name
            ORDER BY playcount DESC
            LIMIT ${limit}
        `;
        return results;
    }

    /**
     * Fetches top albums for a user within a timestamp range using local DB.
     */
    static async getTopAlbums(userId: string, from: Date, to: Date, limit: number = 10): Promise<TopResult[]> {
        const results: any[] = await prisma.$queryRaw`
            SELECT album_name as name, artist_name as "artistName", CAST(COUNT(*) AS INTEGER) as playcount
            FROM user_plays
            WHERE user_id = ${userId} AND time_played >= ${from} AND time_played <= ${to} AND album_name IS NOT NULL
            GROUP BY album_name, artist_name
            ORDER BY playcount DESC
            LIMIT ${limit}
        `;
        return results;
    }

    /**
     * Fetches top tracks for a user within a timestamp range using local DB.
     */
    static async getTopTracks(userId: string, from: Date, to: Date, limit: number = 10): Promise<TopResult[]> {
        const results: any[] = await prisma.$queryRaw`
            SELECT track_name as name, artist_name as "artistName", CAST(COUNT(*) AS INTEGER) as playcount
            FROM user_plays
            WHERE user_id = ${userId} AND time_played >= ${from} AND time_played <= ${to}
            GROUP BY track_name, artist_name
            ORDER BY playcount DESC
            LIMIT ${limit}
        `;
        return results;
    }

    /**
     * Fetches "Eras" (top artist per period) for the timeline command.
     */
    static async getEras(userId: string, period: 'year' | 'month', limit: number = 10, from?: Date, to?: Date): Promise<EraResult[]> {
        const results: any[] = await (from && to 
            ? prisma.$queryRaw`
                WITH base_counts AS (
                    SELECT DATE_TRUNC(${period}, time_played) as era_start, artist_name, COUNT(*) as count_val
                    FROM user_plays
                    WHERE user_id = ${userId} AND time_played >= ${from} AND time_played <= ${to}
                    GROUP BY 1, 2
                ),
                ranked_stats AS (
                    SELECT era_start, artist_name, count_val, ROW_NUMBER() OVER(PARTITION BY era_start ORDER BY count_val DESC) as rank
                    FROM base_counts
                )
                SELECT era_start, artist_name, CAST(count_val AS INTEGER) as playcount
                FROM ranked_stats WHERE rank = 1 ORDER BY era_start DESC LIMIT ${limit}
            `
            : prisma.$queryRaw`
                WITH base_counts AS (
                    SELECT DATE_TRUNC(${period}, time_played) as era_start, artist_name, COUNT(*) as count_val
                    FROM user_plays
                    WHERE user_id = ${userId}
                    GROUP BY 1, 2
                ),
                ranked_stats AS (
                    SELECT era_start, artist_name, count_val, ROW_NUMBER() OVER(PARTITION BY era_start ORDER BY count_val DESC) as rank
                    FROM base_counts
                )
                SELECT era_start, artist_name, CAST(count_val AS INTEGER) as playcount
                FROM ranked_stats WHERE rank = 1 ORDER BY era_start DESC LIMIT ${limit}
            `);
            
        return results;
    }

    /**
     * Fetches genre distribution for a user in a period.
     */
    static async getTopGenres(userId: string, from: Date, to: Date, limit: number = 10): Promise<{ name: string, count: number }[]> {
        const results: any[] = await prisma.$queryRaw`
            SELECT t.name, CAST(COUNT(*) AS INTEGER) as count
            FROM user_plays up
            JOIN artists a ON up.artist_name = a.name
            JOIN artist_tags at ON a.id = at.artist_id
            JOIN tags t ON at.tag_id = t.id
            WHERE up.user_id = ${userId} AND up.time_played >= ${from} AND up.time_played <= ${to}
            GROUP BY t.name
            ORDER BY count DESC
            LIMIT ${limit}
        `;
        return results;
    }
    /**
     * Fetches playcount over time for an artist, album, or track.
     */
    static async getPlaycountOverTime(userId: string, period: 'month' | 'year', filters: { artist?: string; album?: string; track?: string }): Promise<{ period_start: Date; playcount: number }[]> {
        const conditions = [`user_id = '${userId}'`];
        
        // Escape single quotes for raw queries manually
        if (filters.artist) conditions.push(`artist_name ILIKE '${filters.artist.replace(/'/g, "''")}'`);
        if (filters.album) conditions.push(`album_name ILIKE '${filters.album.replace(/'/g, "''")}'`);
        if (filters.track) conditions.push(`track_name ILIKE '${filters.track.replace(/'/g, "''")}'`);

        const whereClause = conditions.join(' AND ');

        // Prisma doesn't support dynamic variables in $queryRaw for identifiers/complex clauses,
        // so we use $queryRawUnsafe here for the dynamic WHERE clause.
        const query = `
            SELECT DATE_TRUNC('${period}', time_played) as period_start, CAST(COUNT(*) AS INTEGER) as playcount
            FROM user_plays
            WHERE ${whereClause}
            GROUP BY 1
            ORDER BY 1 ASC
        `;

        const results: any[] = await prisma.$queryRawUnsafe(query);
        return results;
    }
}
