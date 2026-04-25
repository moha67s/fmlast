import { Client, GatewayIntentBits } from 'discord.js';
import { loadCommands } from './handlers/commandHandler';
import { loadEvents } from './handlers/eventHandler';
import { config } from '../config';
import { initBotProfile } from './services/bot/BotProfile';
import { PuppeteerService } from './services/external/PuppeteerService';
import { LoggerService } from './services/bot/LoggerService';
import { Shoukaku, Connectors } from 'shoukaku';
import http from 'http';
import dns from 'dns';

// Force use of reliable DNS servers to bypass local ENOTFOUND issues
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
    ],
});

export const shoukaku = new Shoukaku(new Connectors.DiscordJS(client), config.LAVALINK_NODES, {
    moveOnDisconnect: true,
    resume: true,
    reconnectTries: 5,
    restTimeout: 15000
});

shoukaku.on('error', (name, error) => {
    // Silence common connection spam, only log critical errors
    const msg = error.message || String(error);
    if (msg.includes('ENOTFOUND') || msg.includes('429') || msg.includes('ECONNREFUSED')) {
        return; // Ignore unreachable/rate-limited nodes silently
    }
    console.error(`[Lavalink] Node ${name} error:`, msg);
});
shoukaku.on('ready', (name) => console.log(`[Lavalink] 🟢 Node ${name} is ready!`));
shoukaku.on('close', (name, code, reason) => {
    if (code !== 1000) console.warn(`[Lavalink] 🟡 Node ${name} closed (Code: ${code})`);
});
shoukaku.on('disconnect', (name, players) => {
    // Silent disconnects are handled by shoukaku's moveOnDisconnect
});

async function bootstrap() {
    // 1. Load Command Registry
    await loadCommands(client);

    // 2. Load Modular Events
    await loadEvents(client);

    // 3. Warm up Puppeteer Pool
    PuppeteerService.warmUp().catch(err => LoggerService.error('Puppeteer Warmup Failed', err, 'Bootstrap'));

    // 4. Login
    await client.login(config.DISCORD_TOKEN);

    // 5. Post-Login Initialization
    await initBotProfile();

    // 6. Simple Health Check for Railway
    http.createServer((req, res) => {
        res.writeHead(200);
        res.end('Bot is alive');
    }).listen(process.env.PORT || 3000);
}

bootstrap().catch(err => {
    console.error('Fatal bootstrap error:', err);
});
