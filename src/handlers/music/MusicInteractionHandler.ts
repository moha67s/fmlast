import { ButtonInteraction, StringSelectMenuInteraction, ModalSubmitInteraction, Message, Client, MessageFlags } from 'discord.js';
import { MusicPlayer } from '../../services/music/MusicPlayer';
import { QueueManager } from '../../services/music/QueueManager';
import { LyricsService } from '../../services/music/LyricsService';
import { ComponentsV2 } from '../../utils/ComponentsV2';
import { Playlist } from '../../models/Playlist';

export class MusicInteractionHandler {
    static async handleButton(interaction: ButtonInteraction, client: Client) {
        const [action] = interaction.customId.split(':');
        const guildId = interaction.guildId!;
        
        // Ensure user is in the same VC
        const member = interaction.member as any;
        const voiceChannel = member.voice.channel;
        const queue = QueueManager.getQueue(guildId);

        const playlistActions = ['mp-pl-create', 'mp-pl-view-all', 'mp-pl-manage', 'mp-pl-add-show', 'mp-pl-delete', 'mp-pl-songs'];
        
        if (!playlistActions.includes(action)) {
            if (!queue && action !== 'mp-pl-play') {
                return interaction.reply({ content: '❌ No active player found.', ephemeral: true });
            }

            if (queue && (!voiceChannel || voiceChannel.id !== queue.voiceChannelId)) {
                return interaction.reply({ content: '❌ You must be in the same voice channel to use controls.', ephemeral: true });
            }
        }

        switch (action) {
            case 'mp-pause':
                MusicPlayer.pause(guildId);
                await interaction.deferUpdate();
                break;
            case 'mp-resume':
                MusicPlayer.resume(guildId);
                await interaction.deferUpdate();
                break;
            case 'mp-skip':
                MusicPlayer.skip(guildId);
                await interaction.reply({ content: '⏭️ Skipping...', ephemeral: true });
                break;
            case 'mp-stop':
                MusicPlayer.stop(guildId);
                await interaction.reply({ content: '🛑 Stopped and cleared.', ephemeral: true });
                break;
            case 'mp-repeat':
                const modes = ['off', 'one', 'all'] as const;
                const nextMode = modes[(modes.indexOf(queue.repeatMode) + 1) % modes.length];
                QueueManager.setRepeatMode(guildId, nextMode);
                MusicPlayer.updateNowPlayingMessage(guildId);
                await interaction.deferUpdate();
                break;
            case 'mp-lyrics': {
                const lyrics = await MusicPlayer.getLyrics(guildId);
                if (!lyrics) {
                    return interaction.reply({ content: '❌ No lyrics found for this track.', ephemeral: true });
                }
                if (lyrics.lines && lyrics.lines.length > 0) {
                    const queue = QueueManager.getQueue(guildId);
                    const pos = queue?.player?.position ?? 0;
                    const firstFrame = LyricsService.buildLiveLyricsUI(lyrics.lines, pos, guildId);
                    
                    const msg = await interaction.reply({ ...firstFrame, fetchReply: true }) as unknown as Message;
                    await LyricsService.startLiveLyrics(guildId, msg, lyrics.lines);
                } else {
                    const builder = new ComponentsV2()
                        .setAccent(0x1DB954)
                        .addText(`### 🎤 Lyrics\n\n${(lyrics.text || '').substring(0, 3500)}`);
                    await interaction.reply({ ...builder.build(), ephemeral: true });
                }
                break;
            }
            case 'mp-lyrics-stop': {
                LyricsService.stopLiveLyrics(guildId);
                await interaction.update({ content: '⏹️ Lyrics sync stopped.', components: [], flags: [] });
                break;
            }
            case 'mp-lyrics-full': {
                LyricsService.stopLiveLyrics(guildId);
                const storedLines = LyricsService.getStoredLines(guildId);
                const fullLyrics = storedLines ? null : await MusicPlayer.getLyrics(guildId);
                const payload = LyricsService.buildFullLyricsUI(
                    storedLines,
                    fullLyrics?.text ?? null
                );
                await interaction.update(payload);
                break;
            }
            case 'mp-shuffle':
                MusicPlayer.shuffle(guildId);
                await interaction.reply({ content: '🔀 Queue shuffled!', ephemeral: true });
                break;
            case 'mp-queue':
                const tracks = queue.tracks.slice(0, 10).map((t, i) => `${i + 1}. **${t.title}**`).join('\n') || '*Queue is empty*';
                const qBuilder = new ComponentsV2()
                    .setAccent(0x1DB954)
                    .addText(`### 📄 Current Queue\n${tracks}${queue.tracks.length > 10 ? `\n...and ${queue.tracks.length - 10} more` : ''}`);
                await interaction.reply({ ...qBuilder.build(), ephemeral: true });
                break;
            case 'mp-trackinfo':
                const track = queue.currentTrack;
                if (!track) return;
                const infoBuilder = new ComponentsV2()
                    .setAccent(0x1DB954)
                    .addThumbnail(track.artworkUrl || track.thumbnail, 
                        `### ℹ️ Track Info\n**Title:** ${track.title}\n**Artist:** ${track.artistName || track.channelTitle}\n**Duration:** ${track.duration}\n**Requester:** ${track.requesterName}`)
                await interaction.reply({ ...infoBuilder.build(), ephemeral: true });
                break;
            case 'mp-volume':
                const volModal = {
                    title: 'Adjust Volume',
                    custom_id: `mp-modal-volume:${guildId}`,
                    components: [{
                        type: 1,
                        components: [{
                            type: 4,
                            custom_id: 'volume_input',
                            label: 'Volume (1-100)',
                            style: 1,
                            min_length: 1,
                            max_length: 3,
                            placeholder: 'Enter volume level...',
                            value: String(queue.player?.volume || 100),
                            required: true
                        }]
                    }]
                };
                await interaction.showModal(volModal);
                break;
            case 'mp-pl-create':
                const plModal = {
                    title: 'Create Playlist',
                    custom_id: `mp-modal-pl-create:${guildId}`,
                    components: [{
                        type: 1,
                        components: [{
                            type: 4,
                            custom_id: 'pl_name',
                            label: 'Playlist Name',
                            style: 1,
                            placeholder: 'e.g. My Chill Mix',
                            required: true
                        }]
                    }]
                };
                await interaction.showModal(plModal);
                break;
            case 'mp-pl-songs':
                const [______, viewId] = interaction.customId.split(':');
                const viewPl = await Playlist.findById(viewId);
                if (!viewPl) return interaction.reply({ content: '❌ Playlist not found.', ephemeral: true });

                const songsText = viewPl.songs.map((s, i) => `${i + 1}. **${s.title}**`).join('\n') || '*No songs in this playlist.*';
                const plSongs = new ComponentsV2()
                    .setAccent(0x1DB954)
                    .addText(`### 📑 Tracks in: ${viewPl.name}\n${songsText}`);
                await interaction.reply({ ...plSongs.build(), ephemeral: true });
                break;
            case 'mp-pl-view-all':
                const playlists = await Playlist.find({ userId: interaction.user.id });
                if (playlists.length === 0) {
                    return interaction.reply({ content: '❌ You don\'t have any playlists yet. Click "Create New" to get started!', ephemeral: true });
                }
                const plList = new ComponentsV2()
                    .setAccent(0x1DB954)
                    .addText('### 📚 Your Playlists\nChoose a playlist to manage or play.');
                
                for (let i = 0; i < playlists.length; i += 5) {
                    const row = playlists.slice(i, i + 5).map(pl => ({
                        type: 2,
                        style: 1,
                        custom_id: `mp-pl-manage:${pl._id}`,
                        label: pl.name,
                        emoji: '🎵'
                    }));
                    plList.addRow(row as any);
                }
                await interaction.reply({ ...plList.build(), ephemeral: true });
                break;
            case 'mp-pl-manage':
                const [_, plId] = interaction.customId.split(':');
                const pl = await Playlist.findById(plId);
                if (!pl) return interaction.reply({ content: '❌ Playlist not found.', ephemeral: true });

                const plManage = new ComponentsV2()
                    .setAccent(0x1DB954)
                    .addText(`### ⚙️ Managing: ${pl.name}\n**Tracks:** ${pl.songs.length}\nChoose an action below.`)
                    .addRow([
                        { type: 2, style: 3, custom_id: `mp-pl-play:${plId}`, label: 'Play Now', emoji: '▶️' },
                        { type: 2, style: 1, custom_id: `mp-pl-add-show:${plId}`, label: 'Add Songs', emoji: '➕' },
                        { type: 2, style: 1, custom_id: `mp-pl-songs:${plId}`, label: 'View Songs', emoji: '📑' },
                        { type: 2, style: 4, custom_id: `mp-pl-delete:${plId}`, label: 'Delete', emoji: '🗑️' }
                    ]);
                await interaction.reply({ ...plManage.build(), ephemeral: true });
                break;
            case 'mp-pl-add-show':
                const [___, addId] = interaction.customId.split(':');
                const addModal = {
                    title: 'Add Songs',
                    custom_id: `mp-modal-pl-add:${addId}`,
                    components: [{
                        type: 1,
                        components: [{
                            type: 4,
                            custom_id: 'songs_input',
                            label: 'Songs or URLs (comma separated)',
                            style: 2,
                            placeholder: 'Song 1, Song 2, https://youtube.com/...',
                            required: true
                        }]
                    }]
                };
                await interaction.showModal(addModal);
                break;
            case 'mp-pl-play':
                const [____, playId] = interaction.customId.split(':');
                const playPl = await Playlist.findById(playId);
                if (!playPl || playPl.songs.length === 0) return interaction.reply({ content: '❌ Playlist is empty.', ephemeral: true });

                await interaction.reply({ content: `⏳ Preparing to play **${playPl.name}**...`, ephemeral: true });

                try {
                    // Initialize player if not exists
                    let currentQueue = QueueManager.getQueue(guildId);
                    if (!currentQueue) {
                        const voiceChannelId = (interaction.member as any).voice.channelId;
                        if (!voiceChannelId) return interaction.editReply({ content: '❌ You must be in a voice channel to play music.' });
                        currentQueue = await MusicPlayer.join(guildId, voiceChannelId, interaction.channel as any);
                    }

                    // Add to queue — stamp requester info so NP card is correct
                    for (const s of playPl.songs) {
                        const song = (s as any).toObject ? (s as any).toObject() : { ...s };
                        QueueManager.addTrack(guildId, {
                            ...song,
                            requesterName: interaction.user.displayName,
                            requesterId: interaction.user.id,
                        });
                    }
                    
                    // Start if not playing
                    if (!currentQueue.isPlaying) {
                        await MusicPlayer.play(guildId);
                        await interaction.editReply({ content: `🎵 Now playing: **${playPl.name}** (${playPl.songs.length} tracks added)` });
                    } else {
                        await interaction.editReply({ content: `✅ Added **${playPl.songs.length}** tracks from **${playPl.name}** to the queue.` });
                    }
                } catch (err: any) {
                    console.error('[MusicInteractionHandler] Playlist play failed:', err);
                    await interaction.editReply({ content: `❌ **Failed to start playlist**: ${err.message || 'Internal Error'}` });
                }
                break;
            case 'mp-pl-delete':
                const [_____, delId] = interaction.customId.split(':');
                await Playlist.findByIdAndDelete(delId);
                await interaction.reply({ content: '✅ Playlist deleted.', ephemeral: true });
                break;
        }
    }

    static async handleModal(interaction: ModalSubmitInteraction) {
        const parts = interaction.customId.split(':');
        const action = parts[0];
        const guildId = parts[1];

        if (action === 'mp-modal-volume') {
            const volume = parseInt(interaction.fields.getTextInputValue('volume_input'));
            if (isNaN(volume) || volume < 1 || volume > 100) {
                return interaction.reply({ content: '❌ Please enter a valid number between 1 and 100.', ephemeral: true });
            }
            await MusicPlayer.setVolume(guildId, volume);
            await interaction.reply({ content: `🔊 Volume set to **${volume}%**`, ephemeral: true });
            MusicPlayer.updateNowPlayingMessage(guildId);
        } else if (action === 'mp-modal-pl-create') {
            const name = interaction.fields.getTextInputValue('pl_name');
            try {
                await Playlist.create({
                    name,
                    userId: interaction.user.id,
                    serverId: interaction.guildId || undefined,
                    songs: []
                });
                await interaction.reply({ content: `✅ Playlist **${name}** created!`, ephemeral: true });
            } catch (err: any) {
                if (err.code === 11000) {
                    await interaction.reply({ content: '❌ You already have a playlist with that name.', ephemeral: true });
                } else {
                    await interaction.reply({ content: '❌ Error creating playlist.', ephemeral: true });
                }
            }
        } else if (action === 'mp-modal-pl-add') {
            const plId = parts[1];
            const songsRaw = interaction.fields.getTextInputValue('songs_input');
            const songs = songsRaw.split(',').map(s => s.trim()).filter(s => s.length > 0);
            
            if (songs.length === 0) return interaction.reply({ content: '❌ No songs provided.', ephemeral: true });

            await interaction.reply({ content: `⏳ Resolving metadata for **${songs.length}** items...`, ephemeral: true });

            const { TrackResolverService } = await import('../../services/api/TrackResolverService');
            const newTracks = [];
            for (const s of songs) {
                let title = s;
                let url = s;
                let thumbnail = 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg';

                if (s.startsWith('http')) {
                    try {
                        const parsed = await TrackResolverService.parseStreamingLink(s);
                        if (parsed) {
                            const resolved = await TrackResolverService.resolve(parsed.artist, parsed.track);
                            title = `${resolved.artist} - ${resolved.title}`;
                            url = resolved.links.youtube || s;
                            thumbnail = resolved.artworkUrl || thumbnail;
                        }
                    } catch {}
                }
                newTracks.push({ title, url, thumbnail });
            }

            await Playlist.findByIdAndUpdate(plId, {
                $push: { songs: { $each: newTracks } }
            });

            await interaction.editReply({ content: `✅ Added **${songs.length}** items to the playlist!` });
        }
    }

    static async handleSelectMenu(interaction: StringSelectMenuInteraction) {
        const [action, guildId] = interaction.customId.split(':');
        
        if (action === 'mp-filter-select') {
            const filter = interaction.values[0];
            // Import logic from filters.ts or centralize filter mapping
            const FILTER_MAP: any = {
                'clear': {},
                'bassboost': { 
                    equalizer: [
                        { band: 0, gain: 0.6 },
                        { band: 1, gain: 0.6 },
                        { band: 2, gain: 0.5 },
                        { band: 3, gain: 0.4 },
                        { band: 4, gain: 0.3 },
                        { band: 5, gain: 0.2 },
                        { band: 6, gain: 0.1 },
                    ] 
                },
                'nightcore': { timescale: { speed: 1.25, pitch: 1.2, rate: 1.0 } },
                'vaporwave': { timescale: { speed: 0.85, pitch: 0.8, rate: 1.0 } },
                'daycore': { timescale: { speed: 0.85, pitch: 0.8, rate: 1.0 }, equalizer: [{ band: 0, gain: 0.3 }, { band: 1, gain: 0.2 }] },
                'tremolo': { tremolo: { frequency: 2.0, depth: 0.5 } },
                'vibrato': { vibrato: { frequency: 2.0, depth: 0.5 } },
                'distortion': { 
                    distortion: { 
                        sinOffset: 0.0, sinScale: 1.0, cosOffset: 0.0, cosScale: 1.0, tanOffset: 0.0, tanScale: 1.0, offset: 0.0, scale: 1.0 
                    },
                    channelMix: { leftToLeft: 0.5, leftToRight: 0.5, rightToLeft: 0.5, rightToRight: 0.5 }
                },
                '8d': { rotation: { rotationHz: 0.2 } }, 
                'pop': { 
                    equalizer: [
                        { band: 0, gain: 0.15 }, { band: 1, gain: 0.1 }, { band: 2, gain: 0.05 }, { band: 3, gain: 0 }, 
                        { band: 4, gain: -0.05 }, { band: 5, gain: -0.1 }, { band: 6, gain: -0.05 }, { band: 7, gain: 0.05 }, 
                        { band: 8, gain: 0.1 }, { band: 9, gain: 0.2 }, { band: 10, gain: 0.25 }, { band: 11, gain: 0.3 }, 
                        { band: 12, gain: 0.25 }, { band: 13, gain: 0.2 }, { band: 14, gain: 0.15 }
                    ] 
                },
                'treble': { 
                    equalizer: [
                        { band: 0, gain: -0.2 }, { band: 1, gain: -0.15 }, { band: 2, gain: -0.1 }, { band: 3, gain: -0.05 }, 
                        { band: 4, gain: 0 }, { band: 5, gain: 0.05 }, { band: 6, gain: 0.1 }, { band: 7, gain: 0.15 }, 
                        { band: 8, gain: 0.2 }, { band: 9, gain: 0.25 }, { band: 10, gain: 0.3 }, { band: 11, gain: 0.35 }, 
                        { band: 12, gain: 0.4 }, { band: 13, gain: 0.45 }, { band: 14, gain: 0.5 }
                    ] 
                },
            };

            await interaction.deferUpdate();
            await MusicPlayer.setFilters(guildId, FILTER_MAP[filter] || {});
        }
    }
}
