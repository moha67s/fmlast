import { Schema, model, Document } from 'mongoose';

export interface IPlaylist extends Document {
    name: string;
    userId: string;
    serverId?: string;
    songs: Array<{
        title: string;
        url: string;
        thumbnail?: string;
        duration?: string;
        durationSeconds?: number;
    }>;
    isPrivate: boolean;
    createdAt: Date;
}

const playlistSchema = new Schema<IPlaylist>({
    name: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    serverId: { type: String, index: true },
    songs: [{
        title: String,
        url: String,
        thumbnail: String,
        duration: String,
        durationSeconds: Number
    }],
    isPrivate: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

// Ensure unique playlist name per user
playlistSchema.index({ userId: 1, name: 1 }, { unique: true });

export const Playlist = model<IPlaylist>('Playlist', playlistSchema);
