import 'dotenv/config';

export const config = {
    DISCORD_TOKEN: process.env.DISCORD_TOKEN!,
    PREFIX: '+',                    // change if you want another prefix
    CLIENT_ID: process.env.DISCORD_CLIENT_ID!, // we'll get this in a second
    LASTFM_API_KEY: process.env.LASTFM_API_KEY!,
    LASTFM_API_SECRET: process.env.LASTFM_API_SECRET!,
    CHART_STAGING_CHANNEL_ID: process.env.CHART_STAGING_CHANNEL_ID!,
    GENIUS_ACCESS_TOKEN: process.env.GENIUS_CLIENT_ACCESS_TOKEN!,
    RAPIDAPI_KEY: process.env.RAPIDAPI_KEY,
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
    DISCOGS_TOKEN: process.env.DISCOGS_TOKEN,
    DISCOGS_KEY: process.env.DISCOGS_KEY,
    DISCOGS_SECRET: process.env.DISCOGS_SECRET,
    BOT_DISCORD_ID: '1492797348139630784', // Corrected ID
    BOT_LASTFM_USERNAME: 'a7aneekya3ny',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    // YouTube Engine Settings
    YT_VISITOR_DATA: process.env.YOUTUBE_VISITOR_DATA,
    POTOKEN_SERVER: process.env.POTOKEN_SERVER,
    YT_METADATA_TIMEOUT_MS: 20000,
    YT_STREAM_TIMEOUT_MS: 30000,
    YT_PLAYLIST_TIMEOUT_MS: 30000,
    INACTIVITY_TIMEOUT: 300, // 5 minutes
};