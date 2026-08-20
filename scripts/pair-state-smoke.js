#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const baseUrl = process.argv[2];
const pin = process.argv[3];
if (!/^http:\/\/[^/]+$/.test(baseUrl || '') || !/^\d{6}$/.test(pin || '')) {
  console.error('Usage: node scripts/pair-state-smoke.js http://HOST:PORT PIN');
  process.exit(2);
}

const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/control`;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { origin: baseUrl });
    socket.once('open', () => socket.send(JSON.stringify({ type: 'pair', pin })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'pair-result') return;
      if (!message.ok) reject(new Error('Pairing rejected'));
      else resolve({ socket, result: message });
    });
    socket.once('error', reject);
  });
}

function input(socket, seq, action) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'input-ack' || message.seq !== seq) return;
      socket.off('message', onMessage);
      if (message.ok) resolve(message);
      else reject(new Error(message.error || 'Input rejected'));
    };
    socket.on('message', onMessage);
    const now = performance.now();
    socket.send(JSON.stringify({ type: 'input', seq, action, phase: 'tap', clientEventMonoMs: now, clientSendMonoMs: now }));
  });
}

async function main() {
  const first = await connect();
  const opened = await input(first.socket, 930001, 'ESC');
  if (!opened.screenOpen || !/PauseScreen$/.test(opened.screenClass || '')) throw new Error('ESC did not open PauseScreen');

  const second = await connect();
  if (!second.result.target?.screenOpen || !/PauseScreen$/.test(second.result.target?.screenClass || '')) {
    throw new Error(`Pair result omitted current PauseScreen state: ${JSON.stringify(second.result.target)}`);
  }
  const closed = await input(second.socket, 930002, 'ESC');
  if (closed.screenOpen) throw new Error('ESC did not close PauseScreen');
  first.socket.close(1000, 'Replaced');
  second.socket.close(1000, 'Smoke complete');
  console.log(`PAIR_STATE_SMOKE_OK screenOpen=${second.result.target.screenOpen} screenClass=${second.result.target.screenClass}`);
}

main().catch((error) => {
  console.error(`PAIR_STATE_SMOKE_FAILED ${error.message}`);
  process.exitCode = 1;
});
