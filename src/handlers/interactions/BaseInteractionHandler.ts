import { Interaction, Client } from 'discord.js';

/**
 * Interface for all feature-specific interaction handlers
 */
export abstract class BaseInteractionHandler {
    /**
     * Handle an interaction
     * @param interaction The interaction to handle
     * @param client The discord client
     */
    abstract handle(interaction: Interaction, client: Client): Promise<void>;

    /**
     * Check if this handler should handle the given customId
     * @param customId The custom_id to check
     */
    abstract canHandle(customId: string): boolean;
}
