#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { WebSocketServer, WebSocket } = require('ws');
const { enumerateWindows, chooseWindow, probeScript } = require('../src/window-selector');
const { spawnProcess } = require('../src/process-runner');
const { FfmpegPipeline } = require('../src/ffmpeg-pipeline');
const { normalizeInputMessage, toBridgeCommand } = require('../src/remote/input-contract');
const { WindowsInputBridge } = require('../src/remote/windows-input-bridge');

const mobileRoot = process.env.REMOTE_PCL_MOBILE_ROOT || path.resolve(__dirname, '..', 'mobile');
const logRoot = process.env.REMOTE_PCL_LOG_ROOT || path.resolve(__dirname, '..', 'logs');
const ffmpegPath = process.env.FFMPEG_PATH || path.resolve(__dirname, '..', 'vendor', 'ffmpeg-gfxcapture-runtime', 'ffmpeg.exe');
const types = new Map([['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8']]);
const VIDEO_PACKET_MAGIC = 'RPCL';
const VIDEO_PACKET_VERSION = 2;
const VIDEO_PACKET_HEADER_BYTES = 96;

function parseArgs(argv) {
  const options = { host: '0.0.0.0', port: 4173, fps: 60, bitrate: '12M' };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--hwnd') { options.hwnd = value; index += 1; }
    else if (key === '--pid') { options.pid = Number(value); index += 1; }
    else if (key === '--host') { options.host = value; index += 1; }
    else if (key === '--port') { options.port = Number(value); index += 1; }
    else if (key === '--fps') { options.fps = Number(value); index += 1; }
    else if (key === '--bitrate') { options.bitrate = value; index += 1; }
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (options.hwnd === undefined && options.pid === undefined) throw new Error('Use --hwnd N or --pid N to lock the remote Minecraft target.');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('--port must be an integer from 1024 to 65535.');
  return options;
}

function addresses() {
  return [...new Set(Object.values(os.networkInterfaces()).flat().filter((item) =>
    item && item.family === 'IPv4' && !item.internal && !item.address.startsWith('198.18.'),
  ).map((item) => item.address))];
}

function createJpegParser(onFrame) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (true) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { pending = pending.subarray(Math.max(0, pending.length - 1)); return; }
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { if (start > 0) pending = pending.subarray(start); return; }
      onFrame(pending.subarray(start, end + 2));
      pending = pending.subarray(end + 2);
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidates = await enumerateWindows(false);
  const target = await chooseWindow(candidates, options.pid, options.hwnd);
  fs.mkdirSync(logRoot, { recursive: true });
  const logPath = path.join(logRoot, `RemotePCL-Remote-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const pairingPin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const bridge = new WindowsInputBridge(target, { onEvent: (event) => {
    log('BRIDGE', event.type, JSON.stringify(event));
    if (event.type === 'bridge-exit' && !shuttingDown) {
      criticalStatus('TARGET_INPUT_LOST', 'Minecraft B 输入适配器已断开；远程输入已停止，且不会回退到 Windows 全局输入。');
      setTimeout(() => shutdown('Target input adapter disconnected; remote input stopped without fallback.'), 80);
    }
  } });
  const videoClients = new Set();
  const videoSockets = new Set();
  const h264Sockets = new Map();
  let pairedSocket = null;
  let sessionToken = null;
  let shuttingDown = false;
  let resourcesCleaned = false;
  let watcher = null;
  let mediaFrames = 0;
  let mediaBytes = 0;
  let h264Frames = 0;
  let h264Bytes = 0;
  let targetGui = { width: target.captureWidth, height: target.captureHeight };
  let targetScreen = { open: false, className: '' };
  const appliedInputTimings = [];
  const pairFailuresByAddress = new Map();

  function log(level, event, detail = '') {
    const line = `[${new Date().toISOString()}] [${level}] ${event}${detail ? ` | ${String(detail).replace(/\r?\n/g, ' ↩ ')}` : ''}`;
    fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    console.log(line);
  }

  function send(socket, value) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
  }

  function criticalStatus(code, message) {
    log('ERROR', code, message);
    if (pairedSocket) send(pairedSocket, { type: 'critical-status', code, message });
    console.log(`REMOTE_PCL_EVENT ${JSON.stringify({ type: 'critical-status', code, message })}`);
  }

  const preview = new PassThrough({ highWaterMark: 2 * 1024 * 1024 });
  const hostPreview = process.env.REMOTE_PCL_PREVIEW_FD ? fs.createWriteStream(null, { fd: Number(process.env.REMOTE_PCL_PREVIEW_FD), autoClose: false }) : null;
  preview.on('data', createJpegParser((jpeg) => {
    mediaFrames += 1;
    mediaBytes += jpeg.length;
    if (hostPreview && hostPreview.writableLength < 2 * 1024 * 1024) hostPreview.write(jpeg);
    for (const socket of videoSockets) {
      if (socket.readyState !== WebSocket.OPEN) { videoSockets.delete(socket); continue; }
      if (socket.bufferedAmount > Math.max(512 * 1024, jpeg.length * 2)) continue;
      socket.send(jpeg, { binary: true });
    }
    const header = Buffer.from(`--remotepcl-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    for (const response of videoClients) {
      if (response.destroyed || response.writableLength > 2 * 1024 * 1024) {
        videoClients.delete(response);
        response.destroy();
        log('WARN', 'VIDEO_CLIENT_DROPPED', 'slow or closed client');
        continue;
      }
      response.write(header);
      response.write(jpeg);
      response.write('\r\n');
    }
  }));

  const pipeline = new FfmpegPipeline(target, {
    fps: options.fps, bitrate: options.bitrate, bufferSize: '3M', metricsIntervalMs: 2000,
    ffmpegPath, previewOutput: preview, previewFps: options.fps, previewJpegQuality: 2, previewMaxWidth: target.captureWidth,
  });
  let h264Config = null;
  function h264CodecString(config) {
    const sps = config.sps[0];
    let offset = sps[2] === 1 ? 3 : 4;
    offset += 1; // NAL header
    return `avc1.${sps.subarray(offset, offset + 3).toString('hex')}`;
  }
  pipeline.addEncodedConsumer({
    configure(config) {
      h264Config = { type: 'video-config', codec: h264CodecString(config), width: target.captureWidth, height: target.captureHeight, format: 'annexb', packetVersion: VIDEO_PACKET_VERSION, packetHeaderBytes: VIDEO_PACKET_HEADER_BYTES };
    },
    consume(frame) {
      h264Frames += 1;
      h264Bytes += frame.data.length;
      const hostSendNs = process.hrtime.bigint();
      while (appliedInputTimings.length && hostSendNs - appliedInputTimings[0].hostAppliedNs > 5_000_000_000n) appliedInputTimings.shift();
      let inputTiming = null;
      if (h264Sockets.size > 0) {
        for (let index = appliedInputTimings.length - 1; index >= 0; index -= 1) {
          if (appliedInputTimings[index].hostAppliedNs <= frame.captureTimestamp) {
            inputTiming = appliedInputTimings[index];
            appliedInputTimings.splice(0, index + 1);
            break;
          }
        }
      }
      for (const [socket, state] of h264Sockets) {
        if (socket.readyState !== WebSocket.OPEN) { h264Sockets.delete(socket); continue; }
        if (state.awaitKeyFrame && !frame.keyFrame) continue;
        if (socket.bufferedAmount > 96 * 1024) {
          log('WARN', 'H264_QUEUE_RESET', `buffered=${socket.bufferedAmount}`);
          socket.close(4008, 'Stale video queue reset');
          h264Sockets.delete(socket);
          continue;
        }
        if (state.awaitKeyFrame) {
          if (!h264Config) continue;
          socket.send(JSON.stringify(h264Config));
          state.awaitKeyFrame = false;
        }
        const header = Buffer.alloc(VIDEO_PACKET_HEADER_BYTES);
        header.write(VIDEO_PACKET_MAGIC, 0, 'ascii');
        header.writeUInt8(VIDEO_PACKET_VERSION, 4);
        header.writeUInt8(frame.keyFrame ? 1 : 0, 5);
        header.writeUInt16LE(VIDEO_PACKET_HEADER_BYTES, 6);
        header.writeUInt32LE(Number(frame.frameId & 0xffffffffn), 8);
        header.writeUInt16LE(frame.width, 12);
        header.writeUInt16LE(frame.height, 14);
        header.writeDoubleLE(Number(frame.pts / 1000n), 16);
        header.writeDoubleLE(Number(frame.captureTimestamp), 24);
        header.writeDoubleLE(Number(frame.encodeCompleteTimestamp), 32);
        header.writeDoubleLE(Number(hostSendNs), 40);
        header.writeUInt32LE(inputTiming ? inputTiming.seq : 0xffffffff, 48);
        header.writeDoubleLE(inputTiming ? Number(inputTiming.hostReceivedNs) : 0, 52);
        header.writeDoubleLE(inputTiming ? Number(inputTiming.hostAppliedNs) : 0, 60);
        header.writeDoubleLE(inputTiming?.clientEventMonoMs || 0, 68);
        header.writeDoubleLE(inputTiming?.clientSendMonoMs || 0, 76);
        socket.send(Buffer.concat([header, frame.data]), { binary: true });
      }
    },
  });

  const mediaStatsTimer = setInterval(() => {
    if (pairedSocket) send(pairedSocket, { type: 'media-stats', videoFps: h264Frames, videoKbps: Math.round(h264Bytes * 8 / 1000), fallbackFps: mediaFrames, fallbackKbps: Math.round(mediaBytes * 8 / 1000) });
    mediaFrames = 0;
    mediaBytes = 0;
    h264Frames = 0;
    h264Bytes = 0;
  }, 1000);
  mediaStatsTimer.unref();

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/session-info') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ pairingRequired: true, target: { title: target.title, width: target.captureWidth, height: target.captureHeight }, video: { codec: 'H264', format: 'ANNEX_B', bitrate: options.bitrate, fps: options.fps }, audio: { available: false, reason: 'Minecraft process-loopback audio is not installed yet.' } }));
      return;
    }
    if (url.pathname === '/media/video.mjpeg') {
      if (!sessionToken || url.searchParams.get('token') !== sessionToken || !pairedSocket || pairedSocket.readyState !== WebSocket.OPEN) {
        response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Pairing required');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=remotepcl-frame',
        'Cache-Control': 'no-store, no-cache, must-revalidate', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff',
      });
      videoClients.add(response);
      request.on('close', () => videoClients.delete(response));
      log('INFO', 'VIDEO_CLIENT_CONNECTED', request.socket.remoteAddress || 'unknown');
      return;
    }
    if (url.pathname === '/media/audio') {
      response.writeHead(501, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ type: 'audio-status', available: false, reason: 'Exact Minecraft process audio capture is not installed yet.' }));
      return;
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(mobileRoot, relative);
    if (file !== mobileRoot && !file.startsWith(`${mobileRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(); return; }
      response.writeHead(200, {
        'Content-Type': types.get(path.extname(file)) || 'application/octet-stream', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws:",
      });
      response.end(data);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const videoWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const h264Wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const expectedOrigin = `http://${request.headers.host}`;
    if (request.headers.origin !== expectedOrigin) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (url.pathname === '/control') {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
      return;
    }
    if (url.pathname === '/media/video' && sessionToken && url.searchParams.get('token') === sessionToken && pairedSocket?.readyState === WebSocket.OPEN) {
      videoWss.handleUpgrade(request, socket, head, (ws) => videoWss.emit('connection', ws, request));
      return;
    }
    if (url.pathname === '/media/video.h264' && sessionToken && url.searchParams.get('token') === sessionToken && pairedSocket?.readyState === WebSocket.OPEN) {
      h264Wss.handleUpgrade(request, socket, head, (ws) => h264Wss.emit('connection', ws, request));
      return;
    }
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });

  videoWss.on('connection', (socket, request) => {
    videoSockets.add(socket);
    log('INFO', 'VIDEO_SOCKET_CONNECTED', request.socket.remoteAddress || 'unknown');
    socket.on('close', () => { videoSockets.delete(socket); log('INFO', 'VIDEO_SOCKET_DISCONNECTED'); });
  });
  h264Wss.on('connection', (socket, request) => {
    h264Sockets.set(socket, { awaitKeyFrame: true });
    log('INFO', 'H264_SOCKET_CONNECTED', request.socket.remoteAddress || 'unknown');
    socket.on('close', () => { h264Sockets.delete(socket); log('INFO', 'H264_SOCKET_DISCONNECTED'); });
  });

  wss.on('connection', (socket, request) => {
    let paired = false;
    const remoteAddress = request.socket.remoteAddress || 'unknown';
    const pairingTimeout = setTimeout(() => socket.close(4001, 'Pairing timed out'), 30000);
    pairingTimeout.unref();
    log('INFO', 'CONTROL_CLIENT_CONNECTED', remoteAddress);
    send(socket, { type: 'hello', pairingRequired: true, protocolVersion: 1 });
    socket.on('message', async (data, isBinary) => {
      if (isBinary) { socket.close(4002, 'Binary control messages are not supported'); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { send(socket, { type: 'error', code: 'INVALID_JSON' }); return; }
      if (!paired) {
        if (message.type !== 'pair' || String(message.pin) !== pairingPin) {
          const now = Date.now();
          const previous = pairFailuresByAddress.get(remoteAddress);
          const failures = !previous || previous.resetAt <= now ? { count: 1, resetAt: now + 5 * 60 * 1000 } : { count: previous.count + 1, resetAt: previous.resetAt };
          pairFailuresByAddress.set(remoteAddress, failures);
          log('WARN', 'PAIRING_REJECTED', `attempt=${failures.count}, remote=${remoteAddress}`);
          send(socket, { type: 'pair-result', ok: false, attemptsRemaining: Math.max(0, 5 - failures.count) });
          if (failures.count >= 5) socket.close(4003, 'Too many pairing failures');
          return;
        }
        if (pairedSocket && pairedSocket !== socket) pairedSocket.close(4004, 'A new phone paired');
        paired = true;
        pairFailuresByAddress.delete(remoteAddress);
        pairedSocket = socket;
        sessionToken = crypto.randomBytes(24).toString('base64url');
        clearTimeout(pairingTimeout);
        log('INFO', 'PHONE_PAIRED', remoteAddress);
        send(socket, { type: 'pair-result', ok: true, sessionToken, h264SocketUrl: `/media/video.h264?token=${encodeURIComponent(sessionToken)}`, videoSocketUrl: `/media/video?token=${encodeURIComponent(sessionToken)}`, videoUrl: `/media/video.mjpeg?token=${encodeURIComponent(sessionToken)}`, audio: { available: false, reason: 'Minecraft process-loopback audio pending.' }, video: { codec: 'H264', format: 'ANNEX_B', bitrate: options.bitrate, fps: options.fps }, target: { title: target.title, width: target.captureWidth, height: target.captureHeight, guiWidth: targetGui.width, guiHeight: targetGui.height, screenOpen: targetScreen.open, screenClass: targetScreen.className } });
        return;
      }
      if (message.type === 'ping') { send(socket, { type: 'pong', echo: message.clientMonoMs, serverMonoNs: process.hrtime.bigint().toString() }); return; }
      if (message.type === 'client-stats') {
        const displayedFps = Math.max(0, Math.min(240, Number(message.displayedFps) || 0));
        const decoderQueue = Math.max(0, Math.min(1000, Number(message.decoderQueue) || 0));
        log('MEDIA', 'PHONE_RENDER_STATS', `fps=${displayedFps}, transport=${String(message.transport || 'unknown').slice(0, 32)}, decoderQueue=${decoderQueue}, h264=${Number(message.h264Frames) || 0}, jpeg=${Number(message.jpegFrames) || 0}, fallback=${String(message.fallbackReason || 'none').slice(0, 96)}, touchToSend=${Number(message.touchToSendMs) || 0}ms, uplink=${Number(message.inputUplinkMs) || 0}ms, hostInput=${Number(message.hostInputMs) || 0}ms, inputToCapture=${Number(message.inputToCaptureMs) || 0}ms, encode=${Number(message.encodeMs) || 0}ms, sendQueue=${Number(message.sendQueueMs) || 0}ms, downlink=${Number(message.downlinkMs) || 0}ms, decode=${Number(message.decodeMs) || 0}ms, display=${Number(message.displayMs) || 0}ms, e2e=${Number(message.endToEndMs) || 0}ms`);
        return;
      }
      try {
        const input = normalizeInputMessage(message);
        const receivedNs = process.hrtime.bigint();
        log('INPUT', 'INPUT_RECEIVED', `seq=${input.seq}, action=${input.action}, phase=${input.phase}`);
        const ack = await bridge.send(toBridgeCommand(input));
        const hostAppliedNs = process.hrtime.bigint();
        appliedInputTimings.push({ seq: input.seq, hostReceivedNs: receivedNs, hostAppliedNs, clientEventMonoMs: input.clientEventMonoMs, clientSendMonoMs: input.clientSendMonoMs });
        while (appliedInputTimings.length > 128) appliedInputTimings.shift();
        if (ack.guiWidth > 0 && ack.guiHeight > 0) targetGui = { width: ack.guiWidth, height: ack.guiHeight };
        targetScreen = { open: Boolean(ack.screenOpen), className: ack.screenClass || '' };
        send(socket, { type: 'input-ack', ok: true, seq: input.seq, action: input.action, phase: input.phase, clientEventMonoMs: input.clientEventMonoMs, clientSendMonoMs: input.clientSendMonoMs, serverReceivedNs: receivedNs.toString(), serverAppliedNs: hostAppliedNs.toString(), screenOpen: ack.screenOpen, screenClass: ack.screenClass, guiWidth: targetGui.width, guiHeight: targetGui.height });
        log('INPUT', 'INPUT_APPLIED', `seq=${input.seq}, action=${input.action}`);
      } catch (error) {
        const seq = Number.isInteger(Number(message.seq)) ? Number(message.seq) : null;
        send(socket, { type: 'input-ack', ok: false, seq, error: error.message });
        log('ERROR', 'INPUT_REJECTED', `seq=${seq}, ${error.message}`);
      }
    });
    socket.on('close', () => {
      clearTimeout(pairingTimeout);
      if (pairedSocket === socket) {
        pairedSocket = null;
        sessionToken = null;
        bridge.send({ seq: 0xfffffffe, kind: 'releaseAll' }).catch(() => {});
        for (const client of videoClients) client.destroy();
        videoClients.clear();
        for (const videoSocket of videoSockets) videoSocket.close(1001, 'Control session ended');
        videoSockets.clear();
        for (const h264Socket of h264Sockets.keys()) h264Socket.close(1001, 'Control session ended');
        h264Sockets.clear();
      }
      log('INFO', 'CONTROL_CLIENT_DISCONNECTED');
    });
  });

  async function cleanupResources() {
    if (resourcesCleaned) return;
    resourcesCleaned = true;
    for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
    for (const socket of videoWss.clients) socket.close(1001, 'Server shutting down');
    for (const socket of h264Wss.clients) socket.close(1001, 'Server shutting down');
    for (const client of videoClients) client.destroy();
    clearInterval(mediaStatsTimer);
    pipeline.stop();
    if (watcher && !watcher.killed) watcher.kill();
    await bridge.stop();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', 'REMOTE_SESSION_STOPPING', reason || 'shutdown');
    await cleanupResources();
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await bridge.start();
    const initialInputState = await bridge.send({ seq: 0xfffffffd, kind: 'queryState' });
    if (initialInputState.guiWidth > 0 && initialInputState.guiHeight > 0) targetGui = { width: initialInputState.guiWidth, height: initialInputState.guiHeight };
    targetScreen = { open: Boolean(initialInputState.screenOpen), className: initialInputState.screenClass || '' };
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, options.host, resolve); });
    pipeline.start();
    watcher = spawnProcess('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScript,
      '-Action', 'Watch', '-Hwnd', target.hwnd, '-TargetPid', String(target.pid),
      '-StartTimeUtcTicks', String(target.startTimeUtcTicks), '-Width', String(target.width), '-Height', String(target.height),
    ]);
    watcher.on('close', (code) => {
      if (shuttingDown || !code) return;
      if (code === 20) criticalStatus('TARGET_LOST', 'Minecraft B 已关闭或身份发生变化；远程输入已停止，且不会切换到其他窗口。');
      else if (code === 21) criticalStatus('TARGET_RESOLUTION_CHANGED', 'Minecraft B 分辨率发生变化；为避免错误缩放，当前会话将停止，请重新启动串流以按新分辨率编码。');
      else criticalStatus('TARGET_WATCHDOG_FAILED', `目标监视器异常退出（${code}）。`);
      setTimeout(() => shutdown(`Target watchdog exited with code ${code}.`), 80);
    });
  } catch (error) {
    shuttingDown = true;
    log('ERROR', 'REMOTE_SESSION_START_FAILED', error.stack || error.message);
    await cleanupResources();
    throw error;
  }

  log('INFO', 'REMOTE_SESSION_STARTED', `PID=${target.pid}, HWND=${target.hwndHex}, ${target.captureWidth}x${target.captureHeight}`);
  log('MEDIA', 'VIDEO_CONFIGURATION', `codec=H264, format=ANNEX_B, capture=${target.captureWidth}x${target.captureHeight}, encode=${target.captureWidth + (target.captureWidth % 2)}x${target.captureHeight + (target.captureHeight % 2)}, bitrate=${options.bitrate}, fps=${options.fps}, jpegFallback=${target.captureWidth}x${target.captureHeight}`);
  console.log(`\nPairing PIN: ${pairingPin}`);
  for (const address of addresses()) console.log(`Phone: http://${address}:${options.port}`);
  console.log(`Log: ${logPath}`);
  console.log(`REMOTE_PCL_EVENT ${JSON.stringify({ type: 'pairing-code', pin: pairingPin, phoneUrls: addresses().map((address) => `http://${address}:${options.port}`), logPath })}`);
  console.log('Video and control/response use separate endpoints. Audio remains unavailable until exact-process loopback is installed.\n');
}

main().catch((error) => { console.error(`Fatal: ${error.stack || error.message}`); process.exitCode = 1; });
