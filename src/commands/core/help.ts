import {
  BaseCommand } from '../../structures/BaseCommand';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { SlashCommandBuilder,
  ComponentType,
  ButtonStyle
} from "discord.js";

export default class HelpCommand extends BaseCommand {
    name = 'help';
    description = 'Display all available commands and their usage';
    aliases = ['commands', 'h'];

    slashData = new SlashCommandBuilder()
        .setName('help')
        .setDescription('Display all available commands and their usage');

    async execute(interactionOrMessage: any, isSlash = false): Promise<void> {

        const user = isSlash ? interactionOrMessage.user : interactionOrMessage.author;

        const categories = [
            {
                name: '📊 Statistics',
                emoji: '📊',
                description: 'Analyze your music taste and history',
                commands: [
                    { name: 'tt', desc: 'Show your top tracks for a period' },
                    { name: 'ta', desc: 'Show your top albums for a period' },
                    { name: 'tar', desc: 'Show your top artists for a period' },
                    { name: 'at', desc: 'Show your top artists for a period' },
                    { name: 'aura', desc: 'Generate a music aura visualizer' },
                    { name: 'chart', desc: 'Generate a beautiful 3x3 or 5x5 chart' },
                    { name: 'insights', desc: 'Deep dive into your listening habits' },
                    { name: 'taste', desc: 'Compare your music taste with others' },
                    { name: 'timeline', desc: 'View your listening history over time' }
                ]
            },
            {
                name: '👥 Social & Friends',
                emoji: '👥',
                description: 'See how you compare with others',
                commands: [
                    { name: 'fm', desc: 'Show what you are currently listening to' },
                    { name: 'whoknows', desc: 'See who in the server knows an artist' },
                    { name: 'wkt', desc: 'See who knows the current track' },
                    { name: 'wka', desc: 'See who knows the current album' },
                    { name: 'fwk', desc: 'See artist stats among your friends' },
                    { name: 'fwkt', desc: 'See track stats among your friends' },
                    { name: 'fwka', desc: 'See album stats among your friends' },
                    { name: 'friends', desc: 'Manage your friend list' },
                    { name: 'crowns', desc: 'View artist crowns you hold in the server' },
                    { name: 'songtwin', desc: 'Find your music twin in the server' }
                ]
            },
            {
                name: '🎮 Games',
                emoji: '🎮',
                description: 'Fun interactive music challenges',
                commands: [
                    { name: 'pixelguess', desc: 'Guess the album from pixelated artwork' },
                    { name: 'zoomguess', desc: 'Guess the album from a zoomed-in image' },
                    { name: 'scramble', desc: 'Unscramble the artist/track names' },
                    { name: 'blindguess', desc: 'Guess the song from a short audio clip' },
                    { name: 'chartclash', desc: 'Battle other users with your charts' },
                    { name: 'labyrinth', desc: 'Navigate a maze based on music tags' },
                    { name: 'jumble', desc: 'Unscramble mixed-up album covers' }
                ]
            },
            {
                name: '🎵 Media & Tools',
                emoji: '🎵',
                description: 'Visuals, lyrics, and utility tools',
                commands: [
                    { name: 'lyriccard', desc: 'Generate a beautiful lyric visual' },
                    { name: 'cover', desc: 'Fetch high-quality album artwork' },
                    { name: 'shazam', desc: 'Identify a song from audio' },
                    { name: 'radio', desc: 'Start a high-fidelity music radio' },
                    { name: 'samples', desc: 'Discover samples used in a track' },
                    { name: 'trackdetails', desc: 'View deep technical details of a track' },
                    { name: 'whatchosong', desc: 'Ask the bot to identify a song' }
                ]
            },
            {
                name: '⚙️ Core',
                emoji: '⚙️',
                description: 'Account management and bot settings',
                commands: [
                    { name: 'login', desc: 'Connect your Last.fm account' },
                    { name: 'logout', desc: 'Disconnect your account' },
                    { name: 'import', desc: 'Import your entire listening history' },
                    { name: 'settings', desc: 'Customize your bot preferences' },
                    { name: 'update', desc: 'Force update your cached data' }
                ]
            },
            {
                name: '🎧 Music Player',
                emoji: '🎧',
                description: 'High-fidelity music playback from YouTube',
                commands: [
                    { name: 'play', desc: 'Play any song or link from YouTube/Spotify' },
                    { name: 'skip', desc: 'Skip the current track' },
                    { name: 'stop', desc: 'Stop playback and clear the queue' },
                    { name: 'radio', desc: 'Start an autonomous high-fidelity radio' }
                ]
            },
            {
                name: '⚡ Shortcut Tools',
                emoji: '⚡',
                description: 'Quick search and link shortcuts',
                commands: [
                    { name: 'applemusic', desc: 'Search and link directly to Apple Music' },
                    { name: 'deezer', desc: 'Search and link directly to Deezer' },
                    { name: 'discogs', desc: 'Search and view release info on Discogs' },
                    { name: 'youtube', desc: 'Search and link directly to YouTube' }
                ]
            }
        ];

        const generateMainPayload = () => {
            const builder = new ComponentsV2()
                .setAccent(0x5865F2)
                .addText(`## ✦ her — Command Guide`)
                .addSeparator()
                .addText(`Welcome to **her**, your premium music companion. Select a category from the menu below to explore available commands and their descriptions.`);

            const options = categories.map(cat => ({
                label: cat.name.replace(/[^\w\s&]/g, '').trim(),
                value: `help_cat_${cat.name.toLowerCase().replace(/[^\w]/g, '_')}`,
                description: cat.description,
                emoji: { name: cat.emoji }
            }));

            builder.addRow([
                {
                    type: ComponentType.StringSelect,
                    customId: 'help_category_picker',
                    placeholder: 'Choose a category to view commands',
                    options
                }
            ]);

            return builder.build();
        };

        const initialPayload = generateMainPayload();

        let message: any;
        if (isSlash) {
            message = await interactionOrMessage.reply({ ...initialPayload, fetchReply: true });
        } else {
            message = await interactionOrMessage.channel.send(initialPayload);
        }

        const collector = message.createMessageComponentCollector({
            filter: (i: any) => i.user.id === user.id,
            idle: 600000 // 10 minutes of inactivity
        });

        collector.on('collect', async (i: any) => {
            if (i.customId === 'help_back_to_main') {
                await i.update(generateMainPayload());
                return;
            }

            const selectedValue = i.values?.[0];
            const category = categories.find(cat => `help_cat_${cat.name.toLowerCase().replace(/[^\w]/g, '_')}` === selectedValue);

            if (category) {
                const commandList = category.commands.map(cmd => `\`.${cmd.name}\` — ${cmd.desc}`).join('\n');
                
                const catBuilder = new ComponentsV2()
                    .setAccent(0x5865F2)
                    .addText(`## ${category.name}`)
                    .addSeparator()
                    .addText(`${category.description}\n\n${commandList}`);

                catBuilder.addRow([
                    {
                        type: ComponentType.Button,
                        style: ButtonStyle.Secondary,
                        customId: 'help_back_to_main',
                        label: 'Back',
                        emoji: { name: '⬅️' }
                    }
                ]);

                await i.update(catBuilder.build());
            }
        });

        // Removed end listener to keep help menu active
    }
}
