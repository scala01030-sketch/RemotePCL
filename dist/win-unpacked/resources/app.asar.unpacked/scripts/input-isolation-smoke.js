#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const WebSocket = require('ws');

const baseUrl = process.argv[2];
const pin = process.argv[3];
const otherHwnd = process.argv[4];
if (!/^http:\/\/[^/]+$/.test(baseUrl || '') || !/^\d{6}$/.test(pin || '')) {
  console.error('Usage: node scripts/input-isolation-smoke.js http://HOST:PORT PIN [OTHER_HWND]');
  process.exit(2);
}

const ffmpegPath = 'vendor\\ffmpeg-gfxcapture-runtime\\ffmpeg.exe';
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cursorPosition() {
  const source = 'using System; using System.Runtime.InteropServices; public static class RemotePclCursorProbe { [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; } [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point); }';
  const command = `Add-Type -TypeDefinition '${source.replaceAll("'", "''")}'; $p=[RemotePclCursorProbe+POINT]::new(); [void][RemotePclCursorProbe]::GetCursorPos([ref]$p); \"$($p.X),$($p.Y)\"`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'Cursor probe failed');
  return result.stdout.trim();
}

function captureWindow(hwnd) {
  const result = spawnSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-filter_complex',
    `gfxcapture=hwnd=${hwnd}:capture_cursor=0:capture_border=0:display_border=0:max_framerate=60:width=-2:height=-2,hwdownload,format=bgra,scale=160:90,format=gray[c]`,
    '-map', '[c]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString().trim() || `Window capture failed for ${hwnd}`);
  return result.stdout;
}

function decodeGray(jpeg) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', 'pipe:0',
      '-vf', 'scale=160:90', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { windowsHide: true });
    const chunks = [];
    let errors = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => { errors += chunk; });
    ffmpeg.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errors || `JPEG decode exited ${code}`)));
    ffmpeg.stdin.end(jpeg);
  });
}

function meanAbsoluteDifference(first, second) {
  if (!first || !second || first.length !== second.length || first.length === 0) throw new Error('Frame size mismatch');
  let total = 0;
  for (let index = 0; index < first.length; index += 1) total += Math.abs(first[index] - second[index]);
  return total / first.length;
}

async function main() {
  const wsBase = baseUrl.replace(/^http/, 'ws');
  const control = new WebSocket(`${wsBase}/control`, { origin: baseUrl });
  let latestFrame = null;
  let result;
  const responses = new Map();
  control.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'input-ack' && responses.has(message.seq)) {
      const pending = responses.get(message.seq);
      responses.delete(message.seq);
      if (message.ok) pending.resolve(message); else pending.reject(new Error(message.error || 'Input rejected'));
    }
  });
  await new Promise((resolve, reject) => {
    control.once('open', () => control.send(JSON.stringify({ type: 'pair', pin })));
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'pair-result') return;
      control.off('message', handler);
      if (!message.ok) reject(new Error('Pairing rejected')); else { result = message; resolve(); }
    };
    control.on('message', handler);
    control.once('error', reject);
  });
  const video = new WebSocket(`${wsBase}${result.videoSocketUrl}`, { origin: baseUrl });
  video.on('message', (data) => { latestFrame = Buffer.from(data); });
  await new Promise((resolve, reject) => { video.once('open', resolve); video.once('error', reject); });
  for (let index = 0; index < 50 && !latestFrame; index += 1) await delay(100);
  if (!latestFrame) throw new Error('No target video frame');

  let seq = 910000;
  const sendLook = async (dx) => {
    seq += 1;
    const now = performance.now();
    const ack = new Promise((resolve, reject) => responses.set(seq, { resolve, reject }));
    control.send(JSON.stringify({ type: 'input', seq, action: 'LOOK', phase: 'delta', dx, dy: 0, clientMonoMs: now, clientEventMonoMs: now, clientSendMonoMs: now }));
    await ack;
  };

  const cursorBefore = cursorPosition();
  const targetBefore = Buffer.from(latestFrame);
  const otherBefore = otherHwnd ? captureWindow(otherHwnd) : null;
  await sendLook(180);
  await delay(500);
  const targetAfter = Buffer.from(latestFrame);
  const otherAfter = otherHwnd ? captureWindow(otherHwnd) : null;
  const cursorAfter = cursorPosition();
  await sendLook(-180);

  const targetDifference = meanAbsoluteDifference(await decodeGray(targetBefore), await decodeGray(targetAfter));
  const otherDifference = otherHwnd ? meanAbsoluteDifference(otherBefore, otherAfter) : 0;
  video.close(1000, 'Isolation smoke complete');
  control.close(1000, 'Isolation smoke complete');
  console.log(`INPUT_ISOLATION_RESULT targetDiff=${targetDifference.toFixed(2)} otherDiff=${otherDifference.toFixed(2)} cursorBefore=${cursorBefore} cursorAfter=${cursorAfter}`);
  if (targetDifference < 5) throw new Error('Selected Minecraft B did not visibly respond');
  if (cursorBefore !== cursorAfter) throw new Error('Windows cursor moved during target-only LOOK');
  if (otherHwnd && otherDifference > Math.max(3, targetDifference * 0.25)) throw new Error('Non-target Minecraft changed too much during target-only LOOK');
  console.log('INPUT_ISOLATION_SMOKE_OK');
}

main().catch((error) => {
  console.error(`INPUT_ISOLATION_SMOKE_FAILED ${error.message}`);
  process.exitCode = 1;
});
