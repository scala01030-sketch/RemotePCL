#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const baseUrl = process.argv[2];
const pin = process.argv[3];
if (!/^http:\/\/[^/]+$/.test(baseUrl || '') || !/^\d{6}$/.test(pin || '')) {
  console.error('Usage: node scripts/h264-transport-smoke.js http://HOST:PORT PIN');
  process.exit(2);
}
const wsBase = baseUrl.replace(/^http/, 'ws');
const control = new WebSocket(`${wsBase}/control`, { origin: baseUrl });
let timer = setTimeout(() => { console.error('H264_TRANSPORT_TIMEOUT'); process.exit(1); }, 10000);
control.on('open', () => control.send(JSON.stringify({ type: 'pair', pin })));
control.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type !== 'pair-result' || !message.ok) return;
  const video = new WebSocket(`${wsBase}${message.h264SocketUrl}`, { origin: baseUrl });
  let config = null;
  video.on('message', (data, binary) => {
    if (!binary) { config = JSON.parse(data.toString()); return; }
    const packet = Buffer.from(data);
    if (!config || config.format !== 'annexb' || !/^avc1\.[0-9a-f]{6}$/i.test(config.codec)) throw new Error('Missing H.264 config');
    const versioned = packet.subarray(0, 4).toString('ascii') === 'RPCL' && packet[4] === 2;
    const headerBytes = versioned ? packet.readUInt16LE(6) : 37;
    const keyFrame = versioned ? packet[5] === 1 : packet[0] === 1;
    if (packet.length <= headerBytes + 4 || !keyFrame) return;
    if (versioned && (config.packetVersion !== 2 || config.packetHeaderBytes !== headerBytes)) throw new Error('Video packet contract mismatch');
    const annexB = packet.subarray(headerBytes);
    if (!(annexB[0] === 0 && annexB[1] === 0 && (annexB[2] === 1 || (annexB[2] === 0 && annexB[3] === 1)))) throw new Error('Frame is not Annex B');
    clearTimeout(timer);
    timer = null;
    console.log(`H264_TRANSPORT_OK codec=${config.codec} bytes=${annexB.length} keyFrame=true`);
    video.close(1000, 'Smoke complete');
    control.close(1000, 'Smoke complete');
  });
});
control.on('error', (error) => { if (timer) { clearTimeout(timer); console.error(`H264_TRANSPORT_FAILED ${error.message}`); process.exit(1); } });
