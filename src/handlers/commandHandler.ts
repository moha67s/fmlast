import { Client, Collection } from 'discord.js';
import { readdirSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { BaseCommand } from '../structures/BaseCommand';

export const commands = new Collection<string, BaseCommand>();

export async function loadCommands(client: Client) {
    const commandsPath = join(__dirname, '../commands');
    const categories = readdirSync(commandsPath);

    for (const category of categories) {
        const categoryPath = join(commandsPath, category);
        const commandFiles = readdirSync(categoryPath).filter(file => file.endsWith('.ts') || file.endsWith('.js'));

        for (const file of commandFiles) {
            const fileUrl = pathToFileURL(join(categoryPath, file)).href;
            const imported = await import(fileUrl);
            const CommandClass = imported.default?.default || imported.default || imported;
            
            try {
                const command = new CommandClass() as BaseCommand;

                commands.set(command.name, command);
                
                if (command.aliases && Array.isArray(command.aliases)) {
                    for (const alias of command.aliases) {
                        commands.set(alias, command);
                    }
                }

                // Register slash command if it has slashData
                if (command.slashData) {
                    client.application?.commands.create(command.slashData.toJSON());
                }
            } catch (err) {
                console.error(`Failed to load command ${file}:`, err);
            }
        }
    }

    console.log(`✅ Loaded ${commands.size} commands`);
}
