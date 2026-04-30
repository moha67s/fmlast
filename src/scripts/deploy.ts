import { REST, Routes } from 'discord.js';
import { config } from '../../config';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const commands: any[] = [];
const commandsPath = path.join(process.cwd(), 'src', 'commands');

async function loadCommands(dir: string) {
    const items = fs.readdirSync(dir);
    for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            await loadCommands(fullPath);
        } else if (item.endsWith('.ts') || item.endsWith('.js')) {
            const fileUrl = pathToFileURL(fullPath).href;
            const { default: CommandClass } = await import(fileUrl);
            if (CommandClass) {
                const command = new CommandClass();
                if (command.slashData) {
                    const data = command.slashData.toJSON();
                    commands.push(data);
                    console.log(`[${commands.length - 1}] Loaded slash command: ${command.name}`);
                }
            }
        }
    }
}

const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');
        await loadCommands(commandsPath);

        console.log(`Successfully loaded ${commands.length} commands.`);

        // Detect Client ID from token if not provided or to verify
        const user: any = await rest.get(Routes.user());
        const clientId = user.id;
        
        console.log(`Deploying to Application ID: ${clientId} (${user.username})`);

        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commands },
        );

        console.log('Successfully reloaded application (/) commands.');
        process.exit(0);
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
