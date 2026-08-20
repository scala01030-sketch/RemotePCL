#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const hwnd = process.argv[2];
const outputPath = process.argv[3] && !process.argv[3].startsWith('--') ? path.resolve(process.argv[3]) : null;
const includeAll = process.argv.includes('--all-windows');
const frameArgIndex = process.argv.indexOf('--frames');
const requiredFrames = frameArgIndex >= 0 ? Number(process.argv[frameArgIndex + 1]) : 30;
if (!Number.isInteger(requiredFrames) || requiredFrames < 1 || requiredFrames > 3600) {
  console.error('--frames must be an integer from 1 to 3600');
  process.exit(2);
}
if (!hwnd || !/^0x[0-9a-f]+$|^\d+$/i.test(hwnd)) {
  console.error('Usage: node scripts/live-preview-smoke.js HWND');
  process.exit(2);
}

const root = path.join(__dirname, '..');
const childArgs = [
  path.join(root, 'src', 'app.js'), '--hwnd', hwnd, '--fps', '60', '--bitrate', '12M',
];
if (includeAll) childArgs.push('--all-windows');
const child = spawn(process.execPath, childArgs, {
  cwd: root,
  env: { ...process.env, REMOTE_PCL_PREVIEW_FD: '3' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
});

let buffer = Buffer.alloc(0);
let frames = 0;
let bytes = 0;
let settled = false;
let stderr = '';

child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stdio[3].on('data', (chunk) => {
  bytes += chunk.length;
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
    const end = start < 0 ? -1 : buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (start < 0 || end < 0) break;
    const frame = buffer.subarray(start, end + 2);
    frames += 1;
    buffer = buffer.subarray(end + 2);
    if (frames === 1 && outputPath) fs.writeFileSync(outputPath, frame);
    if (frames >= requiredFrames && !settled) {
      settled = true;
      console.log(`\nLIVE_PREVIEW_OK frames=${frames} bytes=${bytes} hwnd=${hwnd}`);
      child.kill();
    }
  }
});

const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  console.error(`\nLIVE_PREVIEW_TIMEOUT frames=${frames} bytes=${bytes}`);
  console.error(stderr.slice(-4000));
  child.kill();
  process.exitCode = 1;
}, Math.max(20000, Math.ceil(requiredFrames / 20) * 1000));

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(`LIVE_PREVIEW_PROCESS_ERROR ${error.message}`);
  process.exitCode = 1;
});

child.on('close', () => {
  clearTimeout(timeout);
  if (!settled || frames < requiredFrames) process.exitCode = 1;
});
