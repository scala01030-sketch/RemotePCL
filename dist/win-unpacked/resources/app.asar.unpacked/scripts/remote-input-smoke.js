#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const baseUrl = process.argv[2];
const pin = process.argv[3];
const requestedAction = process.argv[4] || 'ESC';
if (!/^http:\/\/[^/]+$/.test(baseUrl || '') || !/^\d{6}$/.test(pin || '')) {
  console.error('Usage: node scripts/remote-input-smoke.js http://HOST:PORT PIN');
  process.exit(2);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const wsBase = baseUrl.replace(/^http/, 'ws');

function decodeGray(jpeg) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('vendor\\ffmpeg-gfxcapture-runtime\\ffmpeg.exe', [
      '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-i', 'pipe:0',
      '-vf', 'scale=160:90', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { windowsHide: true });
    const chunks = [];
    let errors = '';
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => { errors += chunk; });
    ffmpeg.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errors || `ffmpeg exited ${code}`)));
    ffmpeg.stdin.end(jpeg);
  });
}

function meanAbsoluteDifference(first, second) {
  if (first.length !== second.length || first.length === 0) throw new Error('Decoded frame size mismatch');
  let total = 0;
  for (let index = 0; index < first.length; index += 1) total += Math.abs(first[index] - second[index]);
  return total / first.length;
}

async function main() {
  const control = new WebSocket(`${wsBase}/control`, { origin: baseUrl });
  let latestFrame = null;
  let inputSeq = 900001;
  let ackResolve = null;
  let ackReject = null;
  const paired = new Promise((resolve, reject) => {
    control.on('open', () => control.send(JSON.stringify({ type: 'pair', pin })));
    control.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'pair-result') {
        if (!message.ok) reject(new Error('Pairing rejected')); else resolve(message);
      } else if (message.type === 'input-ack' && message.seq === inputSeq && ackResolve) {
        const done = ackResolve;
        const fail = ackReject;
        ackResolve = null;
        ackReject = null;
        if (!message.ok) fail(new Error(message.error || 'Input rejected')); else done(message);
      }
    });
    control.on('error', reject);
  });
  const result = await paired;
  const video = new WebSocket(`${wsBase}${result.videoSocketUrl}`, { origin: baseUrl });
  video.on('message', (frame) => { latestFrame = Buffer.from(frame); });
  await new Promise((resolve, reject) => { video.on('open', resolve); video.on('error', reject); });
  for (let attempts = 0; attempts < 50 && !latestFrame; attempts += 1) await delay(100);
  if (!latestFrame) throw new Error('No video frame received');
  const before = Buffer.from(latestFrame);

  const sendPayload = async (payload) => {
    inputSeq += 1;
    const ack = new Promise((resolve, reject) => { ackResolve = resolve; ackReject = reject; });
    const now = performance.now();
    control.send(JSON.stringify({ type: 'input', seq: inputSeq, clientMonoMs: now, clientEventMonoMs: now, clientSendMonoMs: now, ...payload }));
    await ack;
  };

  const heldActions = new Set(['FORWARD', 'BACK', 'LEFT', 'RIGHT', 'JUMP', 'SPRINT', 'SNEAK', 'ATTACK', 'USE']);
  if (requestedAction === 'LOOK') await sendPayload({ action: 'LOOK', phase: 'delta', dx: 180, dy: 0 });
  else if (requestedAction === 'SPRINT') {
    await sendPayload({ action: 'FORWARD', phase: 'down' });
    await sendPayload({ action: 'SPRINT', phase: 'down' });
  } else if (heldActions.has(requestedAction)) await sendPayload({ action: requestedAction, phase: 'down' });
  else await sendPayload({ action: requestedAction, phase: 'tap' });
  await delay(800);
  const changed = Buffer.from(latestFrame);
  if (requestedAction === 'LOOK') await sendPayload({ action: 'LOOK', phase: 'delta', dx: -180, dy: 0 });
  else if (requestedAction === 'SPRINT') {
    await sendPayload({ action: 'SPRINT', phase: 'up' });
    await sendPayload({ action: 'FORWARD', phase: 'up' });
  } else if (heldActions.has(requestedAction)) await sendPayload({ action: requestedAction, phase: 'up' });
  else await sendPayload({ action: requestedAction, phase: 'tap' });
  await delay(300);

  const beforeGray = await decodeGray(before);
  const changedGray = await decodeGray(changed);
  const difference = meanAbsoluteDifference(beforeGray, changedGray);
  video.close(1000, 'Smoke complete');
  control.close(1000, 'Smoke complete');
  console.log(`REMOTE_INPUT_SMOKE_OK action=${requestedAction} windowFrameMeanDiff=${difference.toFixed(2)}`);
  if (difference < 1) throw new Error(`Minecraft frame did not visibly react to ${requestedAction} (mean difference ${difference.toFixed(2)})`);
}

main().catch((error) => {
  console.error(`REMOTE_INPUT_SMOKE_FAILED ${error.message}`);
  process.exitCode = 1;
});
