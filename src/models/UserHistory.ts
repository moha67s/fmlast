import { Schema, model, Document } from 'mongoose';

export interface IUserHistory extends Document {
    userId: string;
    lastPlayed: Array<{
        title: string;
        url: string;
        playedAt: Date;
    }>;
    favorites: Array<{
        title: string;
        url: string;
        addedAt: Date;
    }>;
}

const userHistorySchema = new Schema<IUserHistory>({
    userId: { type: String, required: true, unique: true, index: true },
    lastPlayed: [{
        title: String,
        url: String,
        playedAt: { type: Date, default: Date.now }
    }],
    favorites: [{
        title: String,
        url: String,
        addedAt: { type: Date, default: Date.now }
    }]
});

export const UserHistory = model<IUserHistory>('UserHistory', userHistorySchema);
