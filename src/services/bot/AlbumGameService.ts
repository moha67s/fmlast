import { prisma } from '../../database/client';
import { TrackResolverService } from '../api/TrackResolverService';
import { CacheService } from '../bot/CacheService';

export enum AlbumRarity {
    COMMON = 'COMMON',
    RARE = 'RARE',
    EPIC = 'EPIC',
    LEGENDARY = 'LEGENDARY'
}

export interface AlbumRoll {
    albumId: string;
    albumName: string;
    artistName: string;
    image: string;
    rarity: AlbumRarity;
}

export class AlbumGameService {
    /**
     * Rolls for a random album based on gacha rates and rarity tiers.
     */
    static async rollAlbum(userId: string): Promise<AlbumRoll | null> {
        // 1. Determine Rarity Tier (New exclusive rates)
        const roll = Math.random() * 100;
        let rarity = AlbumRarity.COMMON;

        if (roll < 0.5) {
            rarity = AlbumRarity.LEGENDARY;
        } else if (roll < 4) {
            rarity = AlbumRarity.EPIC;
        } else if (roll < 20) {
            rarity = AlbumRarity.RARE;
        }

        // 2. Fetch a random album from the global pool
        // We'll retry up to 5 times if we can't find an image for the selected album
        let attempts = 0;
        while (attempts < 5) {
            attempts++;
            const albums = await prisma.$queryRaw<any[]>`
                SELECT a.id, a.name as "albumName", art.name as "artistName"
                FROM albums a
                JOIN artists art ON a.artist_id = art.id
                WHERE a.name NOT LIKE '%Ù%' 
                  AND a.name NOT LIKE '%Ø%'
                  AND a.name NOT LIKE '%??%'
                  AND art.name NOT LIKE '%Ù%'
                  AND art.name NOT LIKE '%Ø%'
                  AND LENGTH(a.name) > 1
                ORDER BY RANDOM()
                LIMIT 1
            `;

            if (!albums || albums.length === 0) return null;
            const album = albums[0];

            // 3. Resolve fresh artwork from APIs (Always bypassing DB as requested)
            const resolved = await TrackResolverService.resolveAlbum(album.artistName, album.albumName);
            const image = resolved.artworkUrl || '';

            if (image) {
                return {
                    albumId: album.id,
                    albumName: album.albumName,
                    artistName: album.artistName,
                    image: image,
                    rarity
                };
            }
            
            // If no image, loop will try again with a new random album
        }

        return null; // Exhausted retries
    }

    /**
     * Claims an album for the user.
     */
    static async claimAlbum(discordId: string, albumId: string, rarity: AlbumRarity): Promise<boolean> {
        const dbUser = await prisma.user.findUnique({ where: { discordId } });
        if (!dbUser) return false;

        try {
            await prisma.userAlbumCollection.upsert({
                where: {
                    userId_albumId: {
                        userId: dbUser.id,
                        albumId
                    }
                },
                create: {
                    userId: dbUser.id,
                    albumId,
                    rarity
                },
                update: {}
            });

            // On successful claim, trigger cooldown and reset quota
            await prisma.user.update({
                where: { discordId },
                data: {
                    albumRolls: 10, // Max out rolls to force cooldown
                    lastAlbumRoll: new Date()
                }
            });

            return true;
        } catch (err) {
            console.error('[AlbumGame] Error claiming album:', err);
            return false;
        }
    }

    /**
     * Gets the user's collection.
     */
    static async getCollection(discordId: string, page = 0, limit = 10) {
        const dbUser = await prisma.user.findUnique({ where: { discordId } });
        if (!dbUser) return null;

        const count = await prisma.userAlbumCollection.count({ where: { userId: dbUser.id } });
        const items = await prisma.userAlbumCollection.findMany({
            where: { userId: dbUser.id },
            include: {
                album: {
                    include: { artist: true }
                }
            },
            orderBy: { claimedAt: 'desc' },
            skip: page * limit,
            take: limit
        });

        return { items, count };
    }

    /**
     * Formats rarity into a hex color for the UI.
     */
    static getRarityColor(rarity: AlbumRarity): number {
        switch (rarity) {
            case AlbumRarity.LEGENDARY: return 0xFFD700; // Gold
            case AlbumRarity.EPIC:      return 0xA335EE; // Purple
            case AlbumRarity.RARE:      return 0x0070DD; // Blue
            default:                    return 0xFFFFFF; // White
        }
    }

    /**
     * RPG: Gets or creates a user's game profile.
     */
    static async getGameProfile(discordId: string) {
        const user = await prisma.user.findUnique({ 
            where: { discordId },
            include: { gameProfile: true }
        });
        if (!user) return null;

        if (!user.gameProfile) {
            return await prisma.userGameProfile.create({
                data: { userId: user.id }
            });
        }
        return user.gameProfile;
    }

    /**
     * RPG: Calculates scrap value based on rarity.
     */
    static getScrapValue(rarity: AlbumRarity): number {
        switch (rarity) {
            case AlbumRarity.LEGENDARY: return 500;
            case AlbumRarity.EPIC:      return 100;
            case AlbumRarity.RARE:      return 25;
            default:                    return 5;
        }
    }

    /**
     * RPG: Checks if an album is already owned.
     */
    static async isOwned(discordId: string, albumId: string): Promise<boolean> {
        const user = await prisma.user.findUnique({ where: { discordId } });
        if (!user) return false;

        const collection = await prisma.userAlbumCollection.findUnique({
            where: { userId_albumId: { userId: user.id, albumId } }
        });
        return !!collection;
    }

    /**
     * RPG: Updates user wishlist.
     */
    static async updateWishlist(discordId: string, albumId: string, action: 'add' | 'remove'): Promise<boolean> {
        const profile = await this.getGameProfile(discordId);
        if (!profile) return false;

        let newWishlist = [...profile.wishlist];
        if (action === 'add') {
            if (newWishlist.length >= 5) return false;
            if (!newWishlist.includes(albumId)) newWishlist.push(albumId);
        } else {
            newWishlist = newWishlist.filter(id => id !== albumId);
        }

        await prisma.userGameProfile.update({
            where: { userId: profile.userId },
            data: { wishlist: newWishlist }
        });
        return true;
    }

    /**
     * RPG: Check if anyone has this album on their wishlist.
     */
    static async getWishers(albumId: string): Promise<string[]> {
        const profiles = await prisma.userGameProfile.findMany({
            where: { wishlist: { has: albumId } },
            include: { user: true }
        });
        return profiles.map(p => p.user.discordId);
    }

    /**
     * RPG: Award Vinyls to user.
     */
    static async awardVinyls(discordId: string, amount: number) {
        const profile = await this.getGameProfile(discordId);
        if (!profile) return;

        await prisma.userGameProfile.update({
            where: { userId: profile.userId },
            data: { vinylScraps: { increment: amount } }
        });
    }

    /**
     * RPG: Caches a proxied image URL.
     */
    static async cacheProxyUrl(originalUrl: string, proxiedUrl: string) {
        const key = `market:proxy:${Buffer.from(originalUrl).toString('base64')}`;
        await CacheService.set(key, proxiedUrl, 21600); // 6 hours
    }

    /**
     * RPG: Gets a cached proxied image URL.
     */
    static async getCachedProxyUrl(originalUrl: string): Promise<string | null> {
        const key = `market:proxy:${Buffer.from(originalUrl).toString('base64')}`;
        return await CacheService.get<string>(key);
    }

    /**
     * RPG: Refreshes the global market with new stock.
     */
    static async refreshMarket() {
        // Clear old items
        await prisma.marketItem.deleteMany({});

        // Pick 10 random albums with weighted rarity
        const items = [];
        for (let i = 0; i < 10; i++) {
            const album = await this.pickRandomAlbum();
            if (!album) continue;

            const roll = Math.random() * 100;
            let rarity = AlbumRarity.COMMON;
            let price = 25;

            if (roll < 2) {
                rarity = AlbumRarity.LEGENDARY;
                price = 1500;
            } else if (roll < 10) {
                rarity = AlbumRarity.EPIC;
                price = 400;
            } else if (roll < 40) {
                rarity = AlbumRarity.RARE;
                price = 100;
            }

            items.push({ albumId: album.id, rarity, price });
        }

        const expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6 hours
        
        for (const item of items) {
            await prisma.marketItem.create({
                data: { ...item, expiresAt }
            });
        }
    }

    private static async pickRandomAlbum() {
        const albums = await prisma.$queryRaw<any[]>`
            SELECT a.id 
            FROM albums a
            JOIN artists art ON a.artist_id = art.id
            WHERE a.name NOT LIKE '%Ù%' 
              AND a.name NOT LIKE '%Ø%'
              AND a.name NOT LIKE '%??%'
              AND art.name NOT LIKE '%Ù%'
              AND art.name NOT LIKE '%Ø%'
              AND LENGTH(a.name) > 1
            ORDER BY RANDOM() 
            LIMIT 1
        `;
        return albums[0] || null;
    }

    static async getMarketItems() {
        return await prisma.marketItem.findMany({
            include: { album: { include: { artist: true } } },
            orderBy: { id: 'asc' }
        });
    }

    /**
     * RPG: Purchase an album from the market.
     */
    static async buyFromMarket(discordId: string, marketId: string): Promise<{ success: boolean; msg: string }> {
        const profile = await this.getGameProfile(discordId);
        if (!profile) return { success: false, msg: 'Profile not found.' };

        const item = await prisma.marketItem.findUnique({
            where: { id: marketId },
            include: { album: { include: { artist: true } } }
        });
        if (!item) return { success: false, msg: 'Item no longer in market.' };
        if (item.isSold) return { success: false, msg: 'This album is already sold out!' };

        if (profile.vinylScraps < item.price) {
            return { success: false, msg: `You need **${item.price}** Vinyls! (You have ${profile.vinylScraps})` };
        }

        // Check if already owned
        const owned = await this.isOwned(discordId, item.albumId);
        if (owned) return { success: false, msg: 'You already own this album!' };

        // Transaction
        await prisma.$transaction([
            prisma.userGameProfile.update({
                where: { userId: profile.userId },
                data: { vinylScraps: { decrement: item.price } }
            }),
            prisma.userAlbumCollection.create({
                data: {
                    userId: profile.userId,
                    albumId: item.albumId,
                    rarity: item.rarity
                }
            }),
            prisma.marketItem.update({
                where: { id: marketId },
                data: { isSold: true }
            })
        ]);

        return { success: true, msg: `Successfully bought **${item.album.artist.name} - ${item.album.name}**!` };
    }

    /**
     * RPG: Claims daily reward.
     */
    static async claimDaily(discordId: string): Promise<{ success: boolean; scraps?: number; cooldown?: number }> {
        const profile = await this.getGameProfile(discordId);
        if (!profile) return { success: false };

        const now = new Date();
        const lastDaily = profile.lastDaily;
        const COOLDOWN = 6 * 60 * 60 * 1000;

        if (lastDaily && (now.getTime() - lastDaily.getTime() < COOLDOWN)) {
            return { success: false, cooldown: COOLDOWN - (now.getTime() - lastDaily.getTime()) };
        }

        const Vinyls = Math.floor(Math.random() * (150 - 50 + 1)) + 50;
        await prisma.$transaction([
            prisma.userGameProfile.update({
                where: { userId: profile.userId },
                data: { 
                    vinylScraps: { increment: Vinyls },
                    lastDaily: now
                }
            }),
            prisma.user.update({
                where: { discordId },
                data: { 
                    albumRolls: 0, // Reset roll quota
                    lastAlbumRoll: null 
                }
            })
        ]);

        return { success: true, scraps: Vinyls };

    }
}
