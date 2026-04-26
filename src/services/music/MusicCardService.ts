import { PuppeteerService } from '../external/PuppeteerService';
import { YoutubeResult } from '../api/Youtube';
import { formatDuration } from '../../utils/formatDuration';
import * as path from 'path';

export class MusicCardService {
    private static templatePath = path.join(__dirname, '../../images/templates/music_card.html');

    static async renderNowPlayingCard(track: YoutubeResult, currentPosMs: number, requester: string): Promise<Buffer> {
        const totalPosMs = (track.durationSeconds || 0) * 1000;
        const progress = totalPosMs > 0 ? (currentPosMs / totalPosMs) * 100 : 0;

        const data = {
            artworkUrl: track.artworkUrl || track.thumbnail,
            title: (track.trackTitle || track.title).replace(/\[.*?\]|\(.*?\)/g, '').trim(),
            artist: track.artistName || track.channelTitle,
            currentPos: formatDuration(Math.floor(currentPosMs / 1000)),
            totalPos: track.duration || '0:00',
            progress: Math.min(100, Math.max(0, progress)),
            requester: `Requested by ${requester}`
        };

        return await PuppeteerService.render('music_card', data, {
            width: 900,
            height: 300
        });
    }
}
