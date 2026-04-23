// src/utils/downloader.ts
let ffmpeg: any;
import ffmpegPath from "ffmpeg-static";
const ffprobeStatic: any = require("ffprobe-static");
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import cp from "child_process";

// Simple in-memory preview URL map tracking interactionIds
export const previewMap = new Map<string, string>();

let resolvedFfmpeg: string | undefined;
let resolvedFfprobe: string | undefined;

try {
  const candidateFfmpegPaths = [
    process.env.FFMPEG_PATH,
    process.env.FFMPEG,
    "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
    "C:\\tools\\ffmpeg\\ffmpeg.exe",
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ].filter(Boolean) as string[];

  const candidateFfprobePaths = [
    process.env.FFPROBE_PATH,
    process.env.FFPROBE,
    "C:\\tools\\ffmpeg\\bin\\ffprobe.exe",
    "C:\\tools\\ffmpeg\\ffprobe.exe",
    "/usr/bin/ffprobe",
    "/usr/local/bin/ffprobe",
  ].filter(Boolean) as string[];

  // 1. Resolve ffmpeg path
  for (const p of candidateFfmpegPaths) {
    if (typeof p === 'string' && fs.existsSync(p)) {
      resolvedFfmpeg = p;
      break;
    }
  }

  if (!resolvedFfmpeg) {
    const pkgFfmpeg = (ffmpegPath as any)?.path ?? (ffmpegPath as any);
    if (typeof pkgFfmpeg === 'string') {
      resolvedFfmpeg = pkgFfmpeg;
    }
  }

  // 2. Resolve ffprobe path
  for (const p of candidateFfprobePaths) {
    if (typeof p === 'string' && fs.existsSync(p)) {
      resolvedFfprobe = p;
      break;
    }
  }

  if (!resolvedFfprobe) {
    const pkgFfprobe = (ffprobeStatic as any)?.path ?? (ffprobeStatic as any);
    if (typeof pkgFfprobe === 'string') {
      resolvedFfprobe = pkgFfprobe;
    }
  }

  console.log(`[downloader] Final resolved ffmpeg: ${resolvedFfmpeg}`);
  console.log(`[downloader] Final resolved ffprobe: ${resolvedFfprobe}`);

  try {
    if (resolvedFfmpeg) process.env.FFMPEG_PATH = resolvedFfmpeg;
    if (resolvedFfprobe) process.env.FFPROBE_PATH = resolvedFfprobe;

    ffmpeg = require("fluent-ffmpeg");

    if (resolvedFfmpeg) ffmpeg.setFfmpegPath(resolvedFfmpeg);
    if (resolvedFfprobe) ffmpeg.setFfprobePath(resolvedFfprobe);

  } catch (err) {
    console.log(`[downloader] ffmpeg initialization failed: ${(err as any).message}`);
  }
} catch (e) {
  console.log(`[downloader] path resolution failed:`, e);
}


export const tempDir = path.join(os.tmpdir(), "discord-lastfm-bot");

fsp.mkdir(tempDir, { recursive: true }).catch(() => { });

export async function downloadMP3(url: string, trackId: string): Promise<string> {
  const mp3Path = path.join(tempDir, `${trackId}.mp3`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download preview (${res.status})`);

  try {
    const arrayBuf = await res.arrayBuffer();
    await fsp.writeFile(mp3Path, Buffer.from(arrayBuf));
    return mp3Path;
  } catch (err) {
    console.error("[downloader] Error downloading MP3:", err);
    throw err;
  }
}

export async function downloadAndConvert(url: string, trackId: string, duration?: number): Promise<string> {
  const mp3Path = await downloadMP3(url, trackId);
  const oggPath = path.join(tempDir, `${trackId}.ogg`);

  await new Promise((resolve, reject) => {
    let command = ffmpeg(mp3Path)
      .noVideo()
      .audioChannels(1)
      .audioCodec("libopus")
      .format("ogg")
      .outputOptions(["-vbr on"]);

    if (duration) {
      command = command.duration(duration);
    }

    command
      .output(oggPath)
      .on("end", () => resolve(true))
      .on("error", (err: any) => reject(err))
      .run();
  });

  await fsp.unlink(mp3Path).catch(() => { });
  return oggPath;
}

export async function getAudioSignalAndSr(trackId: string, url: string): Promise<{ signal: Float32Array; sampleRate: number }> {
  const mp3Path = await downloadMP3(url, trackId);
  let rawPath: string | undefined;
  try {
    const metadata: any = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(mp3Path, (err: any, data: any) => {
        if (err) reject(err);
        else resolve(data);
      });
    });

    // Safely parse sample rate
    const audioStream = metadata?.streams?.find((s: any) => s.codec_type === "audio");
    const sampleRateStr = audioStream?.sample_rate;
    const sampleRate = sampleRateStr ? Number(sampleRateStr) : 44100;

    console.log(`[downloader] downloaded mp3=${mp3Path} size=${fs.statSync(mp3Path).size} bytes, sampleRate=${sampleRate}`);

    rawPath = path.join(tempDir, `${trackId}.raw`);
    await new Promise((resolve, reject) => {
      ffmpeg(mp3Path)
        .audioChannels(1)
        .audioCodec("pcm_f32le")
        .format("f32le")
        .output(rawPath!)
        .on("end", () => resolve(true))
        .on("error", (err: any) => reject(err))
        .run();
    });

    const buffer = await fsp.readFile(rawPath);
    const signal = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
    console.log(`[downloader] raw=${rawPath} size=${buffer.length} bytes, samples=${signal.length}`);

    return { signal, sampleRate };
  } finally {
    await fsp.unlink(mp3Path).catch(() => { });
    if (rawPath) await fsp.unlink(rawPath).catch(() => { });
  }
}

export async function createAuraVideo(imagePath: string, audioUrl: string, trackId: string): Promise<string> {
  const audioPath = await downloadMP3(audioUrl, trackId);
  const pngPath = path.join(tempDir, `${trackId}_frame.png`);
  const videoPath = path.join(tempDir, `${trackId}.mp4`);

  // Step 1: Convert webp → png (Railway's FFmpeg may not support webp as video input)
  await new Promise((resolve, reject) => {
    ffmpeg(imagePath)
      .output(pngPath)
      .on("end", () => resolve(true))
      .on("error", (err: any) => {
        console.error('[aura] FFmpeg webp→png conversion failed:', err.message);
        reject(err);
      })
      .run();
  });
  console.log(`[aura] Converted image to PNG: ${pngPath}`);

  // Step 2: Create video from png + audio (memory-optimized for Railway)
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(pngPath)
      .inputOptions(["-loop 1"])
      .input(audioPath)
      .outputOptions([
        "-c:v libx264",
        "-preset ultrafast",
        "-tune stillimage",
        "-crf 28",
        "-c:a aac",
        "-b:a 128k",
        "-pix_fmt yuv420p",
        "-shortest",
        "-vf scale=720:720",
        "-movflags +faststart",
        "-threads 1"
      ])
      .duration(30)
      .output(videoPath)
      .on("end", () => resolve(true))
      .on("error", (err: any) => {
        console.error('[aura] FFmpeg video creation failed:', err.message);
        reject(err);
      })
      .run();
  });

  await fsp.unlink(audioPath).catch(() => { });
  await fsp.unlink(pngPath).catch(() => { });
  return videoPath;
}

