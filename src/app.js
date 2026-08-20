#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnProcess, collectProcess } = require('./process-runner');
const { enumerateWindows, chooseWindow, probeScript } = require('./window-selector');
const { FfmpegPipeline } = require('./ffmpeg-pipeline');

function parseArgs(argv) {
  const developmentFfmpeg = path.join(__dirname, '..', 'vendor', 'ffmpeg-gfxcapture-runtime', 'ffmpeg.exe');
  const config = {
    fps: 60,
    bitrate: '12M',
    bufferSize: '4M',
    metricsIntervalMs: 2000,
    ffmpegPath: process.env.FFMPEG_PATH || (fs.existsSync(developmentFfmpeg) ? developmentFfmpeg : undefined),
    includeAll: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--pid') { config.pid = Number(value); i += 1; }
    else if (key === '--hwnd') { config.hwnd = value; i += 1; }
    else if (key === '--fps') { config.fps = Number(value); i += 1; }
    else if (key === '--bitrate') { config.bitrate = value; i += 1; }
    else if (key === '--ffmpeg') { config.ffmpegPath = path.resolve(value); i += 1; }
    else if (key === '--all-windows') config.includeAll = true;
    else if (key === '--help') config.help = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!Number.isInteger(config.fps) || config.fps < 1 || config.fps > 240) throw new Error('--fps must be an integer from 1 to 240.');
  return config;
}

async function verifyTool(command, label) {
  const result = await collectProcess(command, ['-hide_banner', '-version']);
  if (result.code !== 0) throw new Error(`${label} is unavailable. Run npm run doctor for setup guidance.`);
}

function printHelp() {
  console.log(`Usage: node src/app.js [options]\n\n  --pid N          Select a unique candidate by PID\n  --hwnd N|0xHEX   Select exact HWND\n  --fps N          Capture rate (default 60)\n  --bitrate RATE   NVENC bitrate (default 12M)\n  --ffmpeg PATH    Explicit ffmpeg.exe path\n  --all-windows    Show non-Java windows (diagnostic only)\n`);
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) return printHelp();
  const ffmpeg = config.ffmpegPath || 'ffmpeg.exe';
  await verifyTool(ffmpeg, 'FFmpeg');

  const candidates = await enumerateWindows(config.includeAll);
  if (!candidates.length) throw new Error(config.includeAll ? 'No capturable top-level windows found.' : 'No visible java/javaw windows found. Start both Minecraft instances first.');
  const target = await chooseWindow(candidates, config.pid, config.hwnd);
  console.log(`\nLocked target: PID ${target.pid}, HWND ${target.hwndHex}, ${target.width}x${target.height}`);
  console.log('Target identity will never be substituted automatically.');

  let previewOutput = null;
  if (process.env.REMOTE_PCL_PREVIEW_FD) {
    previewOutput = fs.createWriteStream(null, { fd: Number(process.env.REMOTE_PCL_PREVIEW_FD), autoClose: false });
  }
  const pipeline = new FfmpegPipeline(target, { ...config, ffmpegPath: ffmpeg, previewOutput });
  const watcher = spawnProcess('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScript,
    '-Action', 'Watch', '-Hwnd', target.hwnd, '-TargetPid', String(target.pid),
    '-StartTimeUtcTicks', String(target.startTimeUtcTicks), '-Width', String(target.width), '-Height', String(target.height),
  ]);
  watcher.stdout.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) console.log(`[target] ${message}`);
  });
  watcher.stderr.on('data', (chunk) => console.error(`[target] ${chunk.toString().trim()}`));
  watcher.on('close', (code) => {
    if (code === 20) console.error('\nTarget window/process unavailable. Capture stopped; no alternate window was selected.');
    else if (code === 21) console.error('\nTarget resolution changed. Capture stopped cleanly; restart to reinitialize.');
    else if (code && code !== 0) console.error(`\nTarget watchdog failed with code ${code}.`);
    pipeline.stop();
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping and releasing capture/codec/preview processes...');
    pipeline.stop();
    if (!watcher.killed) watcher.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => { pipeline.stop(); if (!watcher.killed) watcher.kill(); });
  pipeline.start();
  console.log(`Pipeline started. Preview is decoded H.264 output (${previewOutput ? 'embedded UI' : 'local SDL window'}). Press Ctrl+C to stop.`);
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exitCode = 1;
});
