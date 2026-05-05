import { PuppeteerService } from '../external/PuppeteerService';
import { AlbumRarity } from './AlbumGameService';
import { Spotify } from '../api/Spotify';

export class AlbumRenderService {
    /**
     * Renders a premium album card with a cello-wrap effect.
     */
    static async renderAlbumCard(data: {
        artistName: string;
        albumName: string;
        image: string;
        rarity: AlbumRarity;
    }): Promise<Buffer> {
        const barcodeBars = Array.from({ length: 40 }, () =>
            Math.floor(Math.random() * 16) + 8
        );

        // Fetch artist profile picture
        let artistImage: string | null = null;
        try {
            artistImage = await Spotify.getArtistCover(data.artistName);
        } catch { /* silently fall back to null */ }

        return await PuppeteerService.render('album_card', {
            ...data,
            rarityColor: this.getRarityColor(data.rarity),
            rarityLabel: data.rarity,
            rarityIcon: this.getRarityIcon(data.rarity),
            artistImage: artistImage || null,
            barcodeBars,
        }, { width: 1080, height: 1080 });
    }

    private static getRarityColor(rarity: AlbumRarity): string {
        switch (rarity) {
            case AlbumRarity.LEGENDARY: return '#FFD700';
            case AlbumRarity.EPIC:      return '#A335EE';
            case AlbumRarity.RARE:      return '#0070DD';
            default:                    return '#AAAAAA';
        }
    }

    private static getRarityIcon(rarity: AlbumRarity): string {
        switch (rarity) {
            case AlbumRarity.LEGENDARY: return '🌟';
            case AlbumRarity.EPIC:      return '💎';
            case AlbumRarity.RARE:      return '🔵';
            default:                    return '⚪';
        }
    }
}
