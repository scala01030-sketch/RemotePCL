#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const baseUrl = process.argv[2];
const pin = process.argv[3];
if (!/^http:\/\/[^/]+$/.test(baseUrl || '') || !/^\d{6}$/.test(pin || '')) {
  console.error('Usage: node scripts/gui-interaction-smoke.js http://HOST:PORT PIN');
  process.exit(2);
}

const wsBase = baseUrl.replace(/^http/, 'ws');

async function main() {
  const socket = new WebSocket(`${wsBase}/control`, { origin: baseUrl });
  let seq = 920000;
  const pending = new Map();

  const paired = new Promise((resolve, reject) => {
    socket.once('open', () => socket.send(JSON.stringify({ type: 'pair', pin })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'pair-result') {
        if (message.ok) resolve(message);
        else reject(new Error('Pairing rejected'));
        return;
      }
      if (message.type !== 'input-ack') return;
      const waiter = pending.get(message.seq);
      if (!waiter) return;
      pending.delete(message.seq);
      if (message.ok) waiter.resolve(message);
      else waiter.reject(new Error(message.error || 'Input rejected'));
    });
    socket.once('error', reject);
  });

  const pairResult = await paired;
  if (!(pairResult.target?.guiWidth > 0 && pairResult.target?.guiHeight > 0)) {
    throw new Error('Pair result did not include target GUI dimensions');
  }

  const input = (action, phase = 'tap', extra = {}) => new Promise((resolve, reject) => {
    seq += 1;
    pending.set(seq, { resolve, reject });
    const now = performance.now();
    socket.send(JSON.stringify({
      type: 'input', seq, action, phase,
      clientEventMonoMs: now, clientSendMonoMs: now,
      ...extra,
    }));
  });

  // Normalize an already-open inventory/pause screen back to gameplay.
  let ack = await input('ESC');
  if (ack.screenOpen) ack = await input('ESC');
  if (ack.screenOpen) throw new Error(`Unable to return to gameplay from ${ack.screenClass}`);

  ack = await input('ESC');
  if (!ack.screenOpen || !/PauseScreen$/.test(ack.screenClass || '')) {
    throw new Error(`ESC did not open PauseScreen: ${JSON.stringify(ack)}`);
  }

  ack = await input('GUI_POINTER', 'tap', { x: 0.5, y: 0.275 });
  if (ack.screenOpen) throw new Error(`Pause screen pointer click was not applied: ${ack.screenClass}`);

  ack = await input('INVENTORY');
  if (!ack.screenOpen || !/InventoryScreen$/.test(ack.screenClass || '')) {
    throw new Error(`INVENTORY did not open inventory: ${JSON.stringify(ack)}`);
  }

  ack = await input('ESC');
  if (ack.screenOpen) throw new Error(`ESC did not close inventory: ${ack.screenClass}`);

  socket.close(1000, 'Smoke complete');
  console.log(`GUI_INTERACTION_SMOKE_OK gui=${pairResult.target.guiWidth}x${pairResult.target.guiHeight} pausePointer=true inventory=true`);
}

main().catch((error) => {
  console.error(`GUI_INTERACTION_SMOKE_FAILED ${error.message}`);
  process.exitCode = 1;
});
