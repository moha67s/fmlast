import { Client, ComponentType, ButtonStyle, ActivityType } from "discord.js";

export class VoiceStatusService {
    /**
     * Set the voice channel status to the currently playing track
     */
    static async setTrackStatus(client: Client, voiceChannelId: string, title: string): Promise<void> {
        try {
            // Discord Voice Channel Status API
            // PUT /channels/{channel_id}/voice-status
            await client.rest.put(`/channels/${voiceChannelId}/voice-status` as any, {
                body: { status: `🎵 ${title.substring(0, 90)}` }
            });
        } catch (err) {
            // console.error('[VoiceStatusService] Failed to set status:', err);
        }
    }

    /**
     * Clear the voice channel status
     */
    static async clearStatus(client: Client, voiceChannelId: string): Promise<void> {
        try {
            await client.rest.put(`/channels/${voiceChannelId}/voice-status` as any, {
                body: { status: null }
            });
        } catch (err) {
            // console.error('[VoiceStatusService] Failed to clear status:', err);
        }
    }

    /**
     * Update bot presence to show current song
     */
    static async updatePresence(client: Client, trackTitle: string | null) {
        if (!client.user) return;

        if (trackTitle) {
            client.user.setPresence({
                activities: [{
                    name: trackTitle,
                    type: ActivityType.Listening // Listening
                }],
                status: 'online'
            });
        } else {
            // Default presence
            client.user.setPresence({
                activities: [{
                    name: 'I AM THE MUSIC',
                    type: ActivityType.Listening
                }],
                status: 'online'
            });
        }
    }
}
