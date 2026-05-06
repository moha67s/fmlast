import { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } from "discord.js";
import { BaseCommand } from "../../structures/BaseCommand";
import { Spotify } from "../../services/api/Spotify";
import { Deezer } from "../../services/api/Deezer";
import { SlskdDownloader } from "../../services/api/SlskdDownloader";
import { UploaderService } from "../../services/bot/UploaderService";
import { RateLimitService } from "../../services/bot/RateLimitService";
import { ComponentsV2 } from "../../utils/ComponentsV2";
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import os from 'os';

export default class DownloadCommand extends BaseCommand {
    name = "download";
    description = "Download a Spotify track or album via Soulseek (Slskd) and upload to GoFile.";
    aliases = ["dl"];

    slashData = new SlashCommandBuilder()
        .setName("download")
        .setDescription("Download a Spotify track or album via Soulseek (Slskd) and upload to GoFile.")
        .addStringOption(option =>
            option.setName("link")
                .setDescription("The Spotify track, album, or playlist link")
                .setRequired(true)
        );

    async execute(interactionOrMessage: any, isSlash = false, args?: string[]) {
        const link = isSlash 
            ? interactionOrMessage.options.getString("link") 
            : args?.[0];

        if (!link) {
            const msg = "❌ Please provide a Spotify link.";
            return isSlash ? interactionOrMessage.reply(msg) : interactionOrMessage.channel.send(msg);
        }

        // Rate Limit check
        const allowed = await RateLimitService.checkCommand(interactionOrMessage.member?.id || interactionOrMessage.author?.id);
        if (!allowed) {
            const msg = "⚠️ You are sending commands too fast!";
            return isSlash ? interactionOrMessage.reply(msg) : interactionOrMessage.channel.send(msg);
        }

        if (isSlash) await interactionOrMessage.deferReply();
        else await interactionOrMessage.channel.sendTyping();

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-dl-'));
        let tracks: { name: string; artist: string }[] = [];
        let collectionName = "Download";
        
        try {
            // 1. Parse Link
            const trackMatch = link.match(/track\/([a-zA-Z0-9]+)/);
            const albumMatch = link.match(/album\/([a-zA-Z0-9]+)/);
            const playlistMatch = link.match(/playlist\/([a-zA-Z0-9]+)/);

            if (trackMatch) {
                const meta = await Spotify.getTrackMetadataById(trackMatch[1]);
                if (meta) tracks.push(meta);
            } else if (albumMatch) {
                const meta = await Spotify.getAlbumMetadataById(albumMatch[1]);
                if (meta) {
                    collectionName = meta.name;
                    tracks = await Spotify.getAlbumTracks(albumMatch[1]);
                }
            } else if (playlistMatch) {
                tracks = await Spotify.getPlaylistTracks(playlistMatch[1]);
                collectionName = "Playlist";
            }

            if (tracks.length === 0) {
                throw new Error("Could not find any tracks in that link.");
            }

            if (tracks.length > 20) {
                throw new Error("Soulseek downloads take time! Maximum 20 tracks at once.");
            }

            const statusMsg = await (isSlash ? interactionOrMessage.editReply(`📥 Starting Soulseek download of **${tracks.length}** tracks...`) : interactionOrMessage.channel.send(`📥 Starting Soulseek download of **${tracks.length}** tracks...`));

            const downloadedFiles: string[] = [];
            for (let i = 0; i < tracks.length; i++) {
                const track = tracks[i];
                try {
                    await statusMsg.edit(`📥 Processing: ${i + 1}/${tracks.length} (**${track.name}**)...`).catch(() => {});

                    // Use Deezer search only to get high-res artwork if possible, otherwise skip
                    const dzTrack = await Deezer.searchTrack(track.artist, track.name).catch(() => null);

                    const ext = ".mp3"; // Default for metadata writing in downloader
                    const fileName = `${track.artist} - ${track.name}${ext}`.replace(/[\\/:"*?<>|]/g, "");
                    const outputPath = path.join(tempDir, fileName);

                    await SlskdDownloader.downloadTrack(outputPath, {
                        name: track.name,
                        artist: track.artist,
                        album: collectionName,
                        artworkUrl: dzTrack?.artworkUrl || undefined
                    });
                    
                    downloadedFiles.push(outputPath);
                } catch (e) {
                    console.error(`Failed to download ${track.name}:`, e);
                }
            }

            if (downloadedFiles.length === 0) {
                throw new Error("Failed to download any tracks.");
            }

            // 2. Zip if multiple, or just use the file
            let finalPath = downloadedFiles[0];
            if (downloadedFiles.length > 1) {
                await statusMsg.edit("📦 Creating ZIP archive...").catch(() => {});
                const zipPath = path.join(os.tmpdir(), `${collectionName.replace(/\s+/g, '_')}.zip`);
                const output = fs.createWriteStream(zipPath);
                const archive = archiver('zip', { zlib: { level: 9 } });

                const zipPromise = new Promise((resolve, reject) => {
                    output.on('close', resolve);
                    archive.on('error', reject);
                });

                archive.pipe(output);
                for (const f of downloadedFiles) {
                    archive.file(f, { name: path.basename(f) });
                }
                await archive.finalize();
                await zipPromise;
                finalPath = zipPath;
            }

            // 3. Upload to GoFile
            await statusMsg.edit("☁️ Uploading to GoFile...").catch(() => {});
            const downloadUrl = await UploaderService.uploadToGoFile(finalPath);

            // 4. Final Response
            const embed = new EmbedBuilder()
                .setTitle(`✅ ${collectionName}`)
                .setDescription(`Successfully downloaded **${downloadedFiles.length}** tracks.`)
                .addFields({ name: 'Download Link', value: `[Click here to download](${downloadUrl})` })
                .setColor(0x00FF00)
                .setFooter({ text: "Link expires in a few days." });

            await (isSlash ? interactionOrMessage.editReply({ content: null, embeds: [embed] }) : statusMsg.edit({ content: null, embeds: [embed] }));

        } catch (err: any) {
            const errMsg = `❌ Error: ${err.message}`;
            if (isSlash) await interactionOrMessage.editReply(errMsg).catch(() => {});
            else await interactionOrMessage.channel.send(errMsg).catch(() => {});
        } finally {
            // Clean up temp files
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
                // If it was a zip, delete it from tmp
                if (tracks.length > 1) {
                    const zipPath = path.join(os.tmpdir(), `${collectionName.replace(/\s+/g, '_')}.zip`);
                    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
                }
            } catch (e) {
                console.error("Cleanup error:", e);
            }
        }
    }
}
