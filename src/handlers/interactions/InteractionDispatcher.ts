import { Interaction, Client } from 'discord.js';
import { BaseInteractionHandler } from './BaseInteractionHandler';
import { ChartHandler } from './ChartHandler';
import { AccountHandler } from './AccountHandler';
import { SocialHandler } from './SocialHandler';
import { MediaHandler } from './MediaHandler';
import { SettingsHandler } from './SettingsHandler';
import { DiscogsHandler } from './DiscogsHandler';

export class InteractionDispatcher {
    private static handlers: BaseInteractionHandler[] = [];
    private static initialized = false;

    /**
     * Initialize and register all handlers
     */
    static init() {
        if (this.initialized) return;
        this.register(new ChartHandler());
        this.register(new AccountHandler());
        this.register(new SocialHandler());
        this.register(new MediaHandler());
        this.register(new SettingsHandler());
        this.register(new DiscogsHandler());
        this.initialized = true;
    }

    /**
     * Register a new interaction handler
     */
    static register(handler: BaseInteractionHandler) {
        this.handlers.push(handler);
    }

    /**
     * Dispatch an interaction to the appropriate handler
     */
    static async dispatch(interaction: Interaction, client: Client): Promise<boolean> {
        let customId = '';

        if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
            customId = interaction.customId;
        } else if (interaction.isAutocomplete()) {
            // Autocomplete is usually handled by the command itself
            return false;
        }

        if (!customId) return false;

        for (const handler of this.handlers) {
            if (handler.canHandle(customId)) {
                await handler.handle(interaction, client);
                return true;
            }
        }

        return false;
    }
}
