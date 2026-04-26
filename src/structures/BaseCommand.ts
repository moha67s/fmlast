import { SlashCommandBuilder } from 'discord.js';

export abstract class BaseCommand {
    abstract name: string;
    abstract description: string;
    aliases?: string[];

    /** Optional slash command definition (auto-registered later) */
    slashData?: any;

    /** Optional autocomplete handler */
    autocomplete?(interaction: any): Promise<void>;

    /** Every command must return Promise<void> */
    abstract execute(interactionOrMessage: any, isSlash?: boolean, args?: string[]): Promise<void>;
}
