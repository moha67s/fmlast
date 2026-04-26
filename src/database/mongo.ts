import mongoose from 'mongoose';
import { LoggerService } from '../services/bot/LoggerService';

export class MongoService {
    static async connect() {
        const url = process.env.MONGODB_URL;
        if (!url) {
            LoggerService.warn('MONGODB_URL not found in .env. MongoDB features (playlists, history) will be disabled.', 'Mongo');
            return;
        }

        try {
            await mongoose.connect(url);
            LoggerService.info('Successfully connected to MongoDB.', 'Mongo');
        } catch (err) {
            LoggerService.error('Failed to connect to MongoDB', err, 'Mongo');
        }
    }

    static get isConnected(): boolean {
        return mongoose.connection.readyState === 1;
    }
}
