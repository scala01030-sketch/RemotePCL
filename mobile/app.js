'use strict';

const views = [...document.querySelectorAll('[data-view]')];
const tabs = [...document.querySelectorAll('[data-tab]')];
const logOutput = document.querySelector('#logOutput');
const eventCount = document.querySelector('#eventCount');
const sheet = document.querySelector('#infoSheet');
const backdrop = document.querySelector('#sheetBackdrop');
const sheetTitle = document.querySelector('#sheetTitle');
const sheetContent = document.querySelector('#sheetContent');
const sheetConfirm = document.querySelector('#sheetConfirmButton');
const toast = document.querySelector('#toast');
const statusButton = document.querySelector('#statusButton');
const previewCard = document.querySelector('.preview-card');
const previewStage = document.querySelector('.preview-stage');
const remoteVideo = document.querySelector('#remoteVideo');
const videoCanvas = document.querySelector('#videoCanvas');
const videoContext = videoCanvas.getContext('2d', { alpha: false, desynchronized: true });
videoContext.imageSmoothingEnabled = true;
videoContext.imageSmoothingQuality = 'high';
const hudDisplayFps = document.querySelector('#hudDisplayFps');
const hudSourceFps = document.querySelector('#hudSourceFps');
const hudInputState = document.querySelector('#hudInputState');
const gameLookLayer = document.querySelector('#gameLookLayer');
const fullscreenButton = document.querySelector('#fullscreenButton');
const gameControlsOverlay = document.querySelector('.game-controls-overlay');
const settingsButton = document.querySelector('#settingsButton');
const gameSettingsPanel = document.querySelector('#gameSettingsPanel');
const closeSettingsButton = document.querySelector('#closeSettingsButton');
const sensitivityRange = document.querySelector('#sensitivityRange');
const sensitivityValue = document.querySelector('#sensitivityValue');
const chatComposer = document.querySelector('#chatComposer');
const chatInput = document.querySelector('#chatInput');
const cancelChatButton = document.querySelector('#cancelChatButton');
const guiDoneButton = document.querySelector('#guiDoneButton');
const moveJoystick = document.querySelector('#moveJoystick');
const joystickKnob = document.querySelector('#joystickKnob');
let events = [];
let toastTimer = null;
let sheetKind = null;
let socket = null;
let paired = false;
let sequence = 1;
let lookPointer = null;
let lookX = 0;
let lookY = 0;
let lookPointerKind = null;
let lookStartX = 0;
let lookStartY = 0;
let lookMoved = false;
let attackHoldTimer = null;
let attackHeld = false;
let interactionMode = 'look';
let joystickPointer = null;
const joystickHeld = new Set();
let videoSocket = null;
let pendingVideoFrame = null;
let videoRendering = false;
let h264Decoder = null;
let videoTransport = 'none';
let fallbackVideoUrl = null;
let fallbackSocketPath = null;
let videoGeneration = 0;
let firstFrameTimer = null;
let renderedVideoFrames = 0;
let videoFirstFrameSeen = false;
const pendingInputs = new Map();
const inputHistory = new Map();
const activeControls = new Set();
const activePointers = new Map();
let immersive = false;
let nativeFullscreenRequested = false;
let lookSensitivity = Math.max(25, Math.min(300, Number(localStorage.getItem('remotePcl.lookSensitivity')) || 100)) / 100;
let mediaStatsLogCounter = 0;
let sourceVideoFps = 0;
let targetGuiWidth = 0;
let targetGuiHeight = 0;
let h264DecodedFrames = 0;
let jpegFallbackFrames = 0;
let fallbackReason = '';
let serverClockOffsetMs = null;
let latestVideoTimings = { touchToSendMs: 0, inputUplinkMs: 0, hostInputMs: 0, inputToCaptureMs: 0, encodeMs: 0, sendQueueMs: 0, downlinkMs: 0, decodeMs: 0, displayMs: 0, endToEndMs: 0 };
const h264Metadata = new Map();

function setHudInputState(text, state = 'waiting') {
  hudInputState.textContent = text;
  hudInputState.className = state;
}

function isoNow() { return new Date().toISOString(); }
function displayTime(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }

function renderLogs() {
  eventCount.textContent = `${events.length} 个事件`;
  logOutput.replaceChildren();
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = '还没有事件。\n点击任意功能后会在这里显示。';
    logOutput.appendChild(empty);
    return;
  }
  for (const entry of [...events].reverse()) {
    const line = document.createElement('div');
    line.className = 'log-line';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = displayTime(entry.timestamp);
    const message = document.createElement('span');
    message.className = 'log-event';
    message.textContent = entry.event;
    if (entry.detail) {
      const detail = document.createElement('small');
      detail.className = 'log-detail';
      detail.textContent = entry.detail;
      message.appendChild(detail);
    }
    line.append(time, message);
    logOutput.appendChild(line);
  }
}

function record(event, detail = '') {
  events.push({ timestamp: isoNow(), event, detail });
  if (events.length > 500) events = events.slice(-500);
  renderLogs();
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function releaseVideoResources() {
  videoGeneration += 1;
  clearTimeout(firstFrameTimer);
  if (videoSocket && videoSocket.readyState <= WebSocket.OPEN) videoSocket.close(1000, 'Control session ended');
  videoSocket = null;
  pendingVideoFrame = null;
  videoRendering = false;
  if (h264Decoder) {
    try { h264Decoder.close(); } catch {}
    h264Decoder = null;
  }
  videoTransport = 'none';
  h264Metadata.clear();
  inputHistory.clear();
  fallbackVideoUrl = null;
  fallbackSocketPath = null;
  videoFirstFrameSeen = false;
  remoteVideo.removeAttribute('src');
  previewStage.classList.remove('fallback-video');
  videoContext.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
}

async function renderLatestVideoFrame() {
  if (videoRendering || !pendingVideoFrame) return;
  const frame = pendingVideoFrame;
  pendingVideoFrame = null;
  videoRendering = true;
  try {
    const bitmap = await createImageBitmap(frame);
    if (videoCanvas.width !== bitmap.width || videoCanvas.height !== bitmap.height) {
      videoCanvas.width = bitmap.width;
      videoCanvas.height = bitmap.height;
    }
    videoContext.drawImage(bitmap, 0, 0);
    bitmap.close();
    renderedVideoFrames += 1;
    if (videoTransport === 'jpeg-fallback') jpegFallbackFrames += 1;
    if (!videoFirstFrameSeen) { videoFirstFrameSeen = true; record('VIDEO_STREAM_READY', 'canvas-latest-frame'); }
  } catch (error) {
    record('VIDEO_FRAME_DECODE_FAILED', error.name || error.message);
    useVideoFallback('bitmap-decode-failed');
  } finally {
    videoRendering = false;
    if (pendingVideoFrame) renderLatestVideoFrame();
  }
}

function useVideoFallback(reason) {
  if (!paired || !fallbackVideoUrl) return;
  if (videoTransport === 'jpeg-fallback') return;
  videoGeneration += 1;
  clearTimeout(firstFrameTimer);
  record('VIDEO_SOCKET_FALLBACK', reason);
  fallbackReason = reason;
  videoTransport = 'jpeg-fallback';
  showToast(`视频已切换至兼容模式：H.264 不可用（${reason}），当前使用 JPEG，画质和延迟可能受到影响。`);
  previewStage.classList.remove('fallback-video');
  pendingVideoFrame = null;
  if (videoSocket?.readyState <= WebSocket.OPEN) videoSocket.close(1000, 'Using JPEG fallback');
  videoSocket = null;
  try { h264Decoder?.close(); } catch {}
  h264Decoder = null;
  h264Metadata.clear();
  if (fallbackSocketPath) openVideoSocket(fallbackSocketPath, fallbackVideoUrl, true);
  else {
    previewStage.classList.add('fallback-video');
    remoteVideo.src = fallbackVideoUrl;
  }
}

function openH264Socket(path, jpegSocketPath, fallbackUrl) {
  const generation = ++videoGeneration;
  clearTimeout(firstFrameTimer);
  fallbackSocketPath = jpegSocketPath;
  fallbackVideoUrl = fallbackUrl;
  if (!('VideoDecoder' in window) || !('EncodedVideoChunk' in window)) {
    record('H264_UNAVAILABLE', 'WebCodecs missing');
    useVideoFallback('webcodecs-missing');
    return;
  }
  videoTransport = 'h264-webcodecs';
  fallbackReason = '';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  videoSocket = new WebSocket(`${protocol}//${location.host}${path}`);
  videoSocket.binaryType = 'arraybuffer';
  h264Decoder = new VideoDecoder({
    output(frame) {
      const decodeCompleteMs = performance.now();
      const metadata = h264Metadata.get(frame.timestamp);
      h264Metadata.delete(frame.timestamp);
      if (videoCanvas.width !== frame.displayWidth || videoCanvas.height !== frame.displayHeight) {
        videoCanvas.width = frame.displayWidth;
        videoCanvas.height = frame.displayHeight;
      }
      videoContext.drawImage(frame, 0, 0);
      frame.close();
      h264DecodedFrames += 1;
      if (!videoFirstFrameSeen) {
        videoFirstFrameSeen = true;
        record('VIDEO_STREAM_READY', 'h264-webcodecs');
        showToast('H.264 硬件解码已启用');
      }
      requestAnimationFrame(() => {
        renderedVideoFrames += 1;
        if (metadata) {
          const displayCompleteMs = performance.now();
          latestVideoTimings.decodeMs = decodeCompleteMs - metadata.receivedMs;
          latestVideoTimings.displayMs = displayCompleteMs - decodeCompleteMs;
          latestVideoTimings.encodeMs = Math.max(0, (metadata.encodeNs - metadata.captureNs) / 1e6);
          latestVideoTimings.sendQueueMs = Math.max(0, (metadata.hostSendNs - metadata.encodeNs) / 1e6);
          latestVideoTimings.downlinkMs = serverClockOffsetMs === null ? 0 : Math.max(0, metadata.receivedMs - (metadata.hostSendNs / 1e6 - serverClockOffsetMs));
          if (metadata.inputSeq !== 0xffffffff) {
            const input = inputHistory.get(metadata.inputSeq) || { eventMs: metadata.inputClientEventMs, sendMs: metadata.inputClientSendMs };
            const eventMs = Number(input.eventMs);
            const sendMs = Number(input.sendMs);
            latestVideoTimings.touchToSendMs = Math.max(0, sendMs - eventMs);
            latestVideoTimings.inputUplinkMs = serverClockOffsetMs === null ? 0 : Math.max(0, metadata.inputHostReceivedNs / 1e6 - serverClockOffsetMs - sendMs);
            latestVideoTimings.hostInputMs = Math.max(0, (metadata.inputHostAppliedNs - metadata.inputHostReceivedNs) / 1e6);
            latestVideoTimings.inputToCaptureMs = Math.max(0, (metadata.captureNs - metadata.inputHostAppliedNs) / 1e6);
            latestVideoTimings.endToEndMs = Math.max(0, displayCompleteMs - eventMs);
            if (inputHistory.has(metadata.inputSeq)) {
              inputHistory.delete(metadata.inputSeq);
              record('INPUT_VIDEO_FEEDBACK', `seq=${metadata.inputSeq}, uplink=${latestVideoTimings.inputUplinkMs.toFixed(1)}ms, host=${latestVideoTimings.hostInputMs.toFixed(1)}ms, capture=${latestVideoTimings.inputToCaptureMs.toFixed(1)}ms, encode=${latestVideoTimings.encodeMs.toFixed(1)}ms, queue=${latestVideoTimings.sendQueueMs.toFixed(1)}ms, downlink=${latestVideoTimings.downlinkMs.toFixed(1)}ms, decode=${latestVideoTimings.decodeMs.toFixed(1)}ms, display=${latestVideoTimings.displayMs.toFixed(1)}ms, e2e=${latestVideoTimings.endToEndMs.toFixed(1)}ms`);
            }
          }
        }
      });
    },
    error(error) {
      record('H264_DECODE_FAILED', error.message);
      useVideoFallback('h264-decode-failed');
    },
  });
  videoSocket.addEventListener('open', () => record('H264_SOCKET_CONNECTED', 'Annex B latest-frame transport'));
  videoSocket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        const config = JSON.parse(event.data);
        if (config.type === 'video-config') {
          h264Decoder.configure({ codec: config.codec, codedWidth: config.width, codedHeight: config.height, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
          record('H264_INITIALIZED', `codec=${config.codec}, ${config.width}x${config.height}, format=${config.format}`);
        }
      } catch (error) { record('H264_CONFIG_FAILED', error.message); useVideoFallback('h264-config-failed'); }
      return;
    }
    if (!h264Decoder || h264Decoder.state !== 'configured') return;
    if (h264Decoder.decodeQueueSize > 2) {
      record('H264_CLIENT_QUEUE_RESET', `decodeQueue=${h264Decoder.decodeQueueSize}`);
      videoSocket.close(4008, 'Client decode queue stale');
      return;
    }
    const packet = new Uint8Array(event.data);
    if (packet.byteLength <= 37) return;
    const versioned = packet[0] === 0x52 && packet[1] === 0x50 && packet[2] === 0x43 && packet[3] === 0x4c && packet[4] === 2;
    const headerBytes = versioned ? new DataView(packet.buffer, packet.byteOffset, 8).getUint16(6, true) : 37;
    if (headerBytes < 37 || headerBytes > packet.byteLength) return;
    const view = new DataView(packet.buffer, packet.byteOffset, headerBytes);
    try {
      const timestamp = view.getFloat64(versioned ? 16 : 1, true);
      h264Metadata.set(timestamp, versioned ? {
        receivedMs: performance.now(), captureNs: view.getFloat64(24, true), encodeNs: view.getFloat64(32, true), hostSendNs: view.getFloat64(40, true),
        inputSeq: view.getUint32(48, true), inputHostReceivedNs: view.getFloat64(52, true), inputHostAppliedNs: view.getFloat64(60, true),
        inputClientEventMs: view.getFloat64(68, true), inputClientSendMs: view.getFloat64(76, true),
      } : { receivedMs: performance.now(), captureNs: view.getFloat64(13, true), encodeNs: view.getFloat64(21, true), hostSendNs: view.getFloat64(29, true), inputSeq: 0xffffffff });
      while (h264Metadata.size > 8) h264Metadata.delete(h264Metadata.keys().next().value);
      h264Decoder.decode(new EncodedVideoChunk({ type: view.getUint8(versioned ? 5 : 0) ? 'key' : 'delta', timestamp, data: packet.subarray(headerBytes) }));
    } catch (error) { record('H264_CHUNK_REJECTED', error.message); useVideoFallback('h264-chunk-rejected'); }
  });
  videoSocket.addEventListener('error', () => useVideoFallback('h264-socket-error'));
  videoSocket.addEventListener('close', (event) => {
    if (videoTransport !== 'h264-webcodecs') return;
    if (event.code === 4008 && paired) {
      record('H264_LATEST_FRAME_RECONNECT', event.reason || 'stale queue reset');
      try { h264Decoder?.close(); } catch {}
      h264Decoder = null;
      h264Metadata.clear();
      setTimeout(() => { if (paired && videoTransport === 'h264-webcodecs' && generation === videoGeneration) openH264Socket(path, jpegSocketPath, fallbackUrl); }, 60);
      return;
    }
    useVideoFallback(`h264-socket-closed-${event.code}`);
  });
  firstFrameTimer = setTimeout(() => { if (generation === videoGeneration && !videoFirstFrameSeen) useVideoFallback('h264-first-frame-timeout'); }, 3000);
}

function openVideoSocket(path, fallbackUrl, explicitFallback = false) {
  const generation = ++videoGeneration;
  clearTimeout(firstFrameTimer);
  fallbackVideoUrl = fallbackUrl;
  fallbackSocketPath = path;
  if (explicitFallback) videoTransport = 'jpeg-fallback';
  previewStage.classList.remove('fallback-video');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  videoSocket = new WebSocket(`${protocol}//${location.host}${path}`);
  videoSocket.binaryType = 'blob';
  videoSocket.addEventListener('open', () => record('VIDEO_SOCKET_CONNECTED', 'latest-frame mode'));
  videoSocket.addEventListener('message', (event) => {
    pendingVideoFrame = event.data;
    renderLatestVideoFrame();
  });
  videoSocket.addEventListener('error', () => {
    record('JPEG_SOCKET_ERROR');
    if (videoTransport === 'jpeg-fallback') { previewStage.classList.add('fallback-video'); remoteVideo.src = fallbackVideoUrl; }
  });
  videoSocket.addEventListener('close', () => { if (generation === videoGeneration && videoTransport === 'jpeg-fallback') record('JPEG_SOCKET_CLOSED'); });
  firstFrameTimer = setTimeout(() => {
    if (generation !== videoGeneration || videoFirstFrameSeen) return;
    record('JPEG_FIRST_FRAME_TIMEOUT');
    previewStage.classList.add('fallback-video');
    remoteVideo.src = fallbackVideoUrl;
  }, 2500);
}

function setConnectionState(state, detail = '') {
  statusButton.querySelector('span:last-child').textContent = state;
  statusButton.classList.toggle('connected', state === '已连接');
  record('CONNECTION_STATE', `${state}${detail ? ` · ${detail}` : ''}`);
}

function setInteractionMode(mode, source) {
  interactionMode = mode;
  const gui = mode === 'gui';
  gameLookLayer.classList.toggle('gui-mode', gui);
  gameControlsOverlay.classList.toggle('gui-mode', gui);
  record('INTERACTION_MODE', `mode=${mode}, source=${source}`);
}

function selectTab(name) {
  for (const view of views) {
    const selected = view.dataset.view === name;
    view.hidden = !selected;
    view.classList.toggle('active', selected);
  }
  for (const tab of tabs) {
    const selected = tab.dataset.tab === name;
    tab.classList.toggle('active', selected);
    if (selected) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
  }
  record('NAVIGATE_TAB', `target=${name}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openSheet(kind) {
  sheetKind = kind;
  if (kind === 'search') {
    sheetTitle.textContent = '连接电脑';
    sheetContent.innerHTML = '<p>请输入电脑端显示的 6 位配对码。</p><label class="pairing-label" for="pairingPin">配对码</label><input id="pairingPin" class="pairing-input" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000"><p id="pairingError" class="pairing-error" role="alert"></p>';
    sheetConfirm.textContent = '连接电脑';
  } else {
    sheetTitle.textContent = '连接前准备';
    sheetContent.innerHTML = '<ul><li><strong>电脑端启动远程会话</strong><small>命令行会显示手机地址和一次性配对码。</small></li><li><strong>位于同一网络</strong><small>手机与电脑处于同一 Wi-Fi 或局域网。</small></li><li><strong>保持目标窗口可操作</strong><small>电脑只向已锁定的 Minecraft HWND/PID 注入输入。</small></li></ul>';
    sheetConfirm.textContent = '我知道了';
  }
  backdrop.hidden = false;
  sheet.hidden = false;
  if (kind === 'search') document.querySelector('#pairingPin').focus(); else document.querySelector('#closeSheetButton').focus();
  record('OPEN_CONNECTION_SHEET', `kind=${kind}`);
}

function closeSheet(source) {
  if (sheet.hidden) return;
  sheet.hidden = true;
  backdrop.hidden = true;
  sheetKind = null;
  record('CLOSE_CONNECTION_SHEET', `source=${source}`);
}

function disconnect(reason) {
  if (immersive) setImmersive(false, 'disconnect');
  paired = false;
  activeControls.clear();
  activePointers.clear();
  for (const button of document.querySelectorAll('[data-control].pressed')) { button.classList.remove('pressed'); button.setAttribute('aria-pressed', 'false'); }
  joystickHeld.clear();
  joystickPointer = null;
  joystickKnob.style.transform = 'translate(-50%,-50%)';
  clearTimeout(attackHoldTimer);
  attackHeld = false;
  setInteractionMode('look', 'disconnect');
  pendingInputs.clear();
  setHudInputState('输入等待');
  previewStage.classList.remove('ready');
  releaseVideoResources();
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close(1000, reason || 'Client disconnect');
  socket = null;
  setConnectionState('未连接', reason);
}

function connectWithPin(pin) {
  if (!/^\d{6}$/.test(pin)) {
    document.querySelector('#pairingError').textContent = '请输入完整的 6 位数字。';
    return;
  }
  if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
  setConnectionState('连接中');
  sheetConfirm.disabled = true;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/control`);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'pair', pin }));
    record('PAIRING_REQUEST_SENT');
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { record('INVALID_SERVER_MESSAGE'); return; }
    if (message.type === 'pair-result') {
      sheetConfirm.disabled = false;
      if (!message.ok) {
        const error = document.querySelector('#pairingError');
        if (error) error.textContent = `配对码不正确，还可尝试 ${message.attemptsRemaining} 次。`;
        record('PAIRING_REJECTED', `remaining=${message.attemptsRemaining}`);
        return;
      }
      paired = true;
      targetGuiWidth = Number(message.target?.guiWidth) || Number(message.target?.width) || 0;
      targetGuiHeight = Number(message.target?.guiHeight) || Number(message.target?.height) || 0;
      if (typeof message.target?.screenOpen === 'boolean') setInteractionMode(message.target.screenOpen ? 'gui' : 'look', `pair-screen:${message.target.screenClass || 'game'}`);
      setConnectionState('已连接', message.target?.title || 'Minecraft');
      if (message.h264SocketUrl) openH264Socket(message.h264SocketUrl, message.videoSocketUrl, message.videoUrl);
      else if (message.videoSocketUrl) openVideoSocket(message.videoSocketUrl, message.videoUrl);
      else remoteVideo.src = message.videoUrl;
      previewStage.classList.add('ready');
      document.querySelector('.stream-stats span:nth-child(1) strong').textContent = `${message.target.width}×${message.target.height}`;
      document.querySelector('.stream-stats span:nth-child(2) strong').textContent = '测量中';
      document.querySelector('.stream-stats span:nth-child(3) strong').textContent = '测量中';
      hudDisplayFps.textContent = '—';
      hudSourceFps.textContent = '—';
      setHudInputState('输入就绪', 'ok');
      closeSheet('paired');
      record('PHONE_PAIRED', `video=${message.video?.codec || 'unknown'}/${message.video?.format || 'unknown'}, bitrate=${message.video?.bitrate || 'unknown'}, audio=${message.audio?.available === true}`);
      if (!message.audio?.available) showToast('视频和控制已连接；游戏音频接口尚未安装');
    } else if (message.type === 'input-ack') {
      const pending = pendingInputs.get(message.seq);
      pendingInputs.delete(message.seq);
      const rtt = pending === undefined ? null : performance.now() - pending.sendMs;
      const hostInputMs = message.serverReceivedNs && message.serverAppliedNs ? Math.max(0, (Number(message.serverAppliedNs) - Number(message.serverReceivedNs)) / 1e6) : null;
      if (hostInputMs !== null) latestVideoTimings.hostInputMs = hostInputMs;
      record(message.ok ? 'INPUT_ACK' : 'INPUT_REJECTED', `seq=${message.seq}, action=${message.action || ''}${rtt === null ? '' : `, rtt=${rtt.toFixed(1)}ms`}${hostInputMs === null ? '' : `, host=${hostInputMs.toFixed(1)}ms`}${message.error ? `, ${message.error}` : ''}`);
      if (rtt !== null) document.querySelector('.stream-stats span:nth-child(3) strong').textContent = `${Math.round(rtt)} ms`;
      setHudInputState(message.ok ? `输入 ✓${rtt === null ? '' : ` ${Math.round(rtt)}ms`}` : '输入失败', message.ok ? 'ok' : 'error');
      if (!message.ok) showToast(`电脑未执行输入：${message.error}`);
      if (message.ok && typeof message.screenOpen === 'boolean') setInteractionMode(message.screenOpen ? 'gui' : 'look', `host-screen:${message.screenClass || 'game'}`);
      if (message.ok && Number(message.guiWidth) > 0 && Number(message.guiHeight) > 0) {
        targetGuiWidth = Number(message.guiWidth);
        targetGuiHeight = Number(message.guiHeight);
      }
    } else if (message.type === 'pong') {
      const receivedMs = performance.now();
      const rtt = receivedMs - Number(message.echo);
      serverClockOffsetMs = Number(message.serverMonoNs) / 1e6 - (Number(message.echo) + receivedMs) / 2;
      document.querySelector('.stream-stats span:nth-child(3) strong').textContent = `${Math.round(rtt)} ms`;
      record('PING_RESPONSE', `rtt=${rtt.toFixed(1)}ms`);
    } else if (message.type === 'media-stats') {
      sourceVideoFps = Number(message.videoFps) || 0;
      hudSourceFps.textContent = sourceVideoFps ? sourceVideoFps.toFixed(0) : '—';
      mediaStatsLogCounter += 1;
      if (mediaStatsLogCounter % 5 === 0) record('VIDEO_SOURCE_STATS', `fps=${message.videoFps}, bitrate=${message.videoKbps}kbps`);
    } else if (message.type === 'critical-status') {
      record(message.code || 'CRITICAL_STATUS', message.message || 'Host critical status');
      setHudInputState('目标不可用', 'error');
      showToast(message.message || '电脑端发生关键错误，远程输入已停止');
    } else if (message.type === 'focus-status') {
      record(message.ok ? 'TARGET_FOCUSED' : 'TARGET_FOCUS_FAILED', message.error || 'Minecraft ready for input');
      if (!message.ok) showToast('电脑未能聚焦 Minecraft，请查看日志');
    }
  });
  socket.addEventListener('close', (event) => {
    if (immersive) setImmersive(false, 'socket-close');
    sheetConfirm.disabled = false;
    const wasPaired = paired;
    paired = false;
    clearTimeout(attackHoldTimer);
    attackHeld = false;
    activeControls.clear();
    activePointers.clear();
    for (const button of document.querySelectorAll('[data-control].pressed')) { button.classList.remove('pressed'); button.setAttribute('aria-pressed', 'false'); }
    joystickHeld.clear();
    joystickPointer = null;
    joystickKnob.style.transform = 'translate(-50%,-50%)';
    setInteractionMode('look', 'socket-close');
    previewStage.classList.remove('ready');
    releaseVideoResources();
    setConnectionState('未连接', `code=${event.code}`);
    if (wasPaired) showToast('与电脑的连接已断开，全部按键已释放');
  });
  socket.addEventListener('error', () => {
    sheetConfirm.disabled = false;
    const error = document.querySelector('#pairingError');
    if (error) error.textContent = '无法连接电脑，请确认远程会话仍在运行。';
    record('CONTROL_SOCKET_ERROR');
  });
}

function sendInput(action, phase, extra = {}) {
  if (!paired || !socket || socket.readyState !== WebSocket.OPEN) {
    record('INPUT_BLOCKED_NOT_PAIRED', `action=${action}, phase=${phase}`);
    showToast('请先连接电脑');
    return false;
  }
  const seq = sequence++ >>> 0;
  const details = { ...extra };
  const eventMs = Number.isFinite(details.clientEventMonoMs) ? details.clientEventMonoMs : performance.now();
  delete details.clientEventMonoMs;
  const sendMs = performance.now();
  const message = { type: 'input', seq, action, phase, clientMonoMs: sendMs, clientEventMonoMs: eventMs, clientSendMonoMs: sendMs, ...details };
  pendingInputs.set(seq, { eventMs, sendMs });
  inputHistory.set(seq, { eventMs, sendMs });
  while (inputHistory.size > 128) inputHistory.delete(inputHistory.keys().next().value);
  setHudInputState('输入发送中', 'pending');
  socket.send(JSON.stringify(message));
  record('INPUT_SENT', `seq=${seq}, action=${action}, phase=${phase}`);
  return true;
}

for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
statusButton.addEventListener('click', () => paired ? disconnect('用户断开') : openSheet('requirements'));
document.querySelector('#connectButton').addEventListener('click', () => openSheet('search'));
document.querySelector('#requirementsButton').addEventListener('click', () => openSheet('requirements'));
document.querySelector('#closeSheetButton').addEventListener('click', () => closeSheet('close-button'));
sheetConfirm.addEventListener('click', () => {
  if (sheetKind === 'search') connectWithPin(document.querySelector('#pairingPin').value.trim()); else closeSheet('confirm-button');
});
backdrop.addEventListener('click', () => closeSheet('backdrop'));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeSheet('escape-key'); });

function setImmersive(enabled, source) {
  immersive = enabled;
  previewCard.classList.toggle('immersive', enabled);
  document.body.classList.toggle('immersive-mode', enabled);
  fullscreenButton.textContent = enabled ? '退出' : '沉浸';
  fullscreenButton.setAttribute('aria-label', enabled ? '退出沉浸模式' : '进入沉浸模式');
  record('IMMERSIVE_MODE', `enabled=${enabled}, source=${source}`);
}

fullscreenButton.addEventListener('click', async () => {
  record('CLICK_FULLSCREEN', `paired=${paired}, immersive=${immersive}`);
  if (!paired) { showToast('连接电脑后才能进入沉浸模式'); return; }
  if (immersive) {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen().catch(() => {});
    else if (document.webkitFullscreenElement && document.webkitExitFullscreen) document.webkitExitFullscreen();
    setImmersive(false, 'button');
    nativeFullscreenRequested = false;
    return;
  }
  setImmersive(true, 'button');
  const requestNative = previewStage.requestFullscreen || previewStage.webkitRequestFullscreen;
  if (requestNative) {
    try {
      await requestNative.call(previewStage);
      nativeFullscreenRequested = true;
      record('NATIVE_FULLSCREEN_ENTERED');
    } catch (error) {
      record('NATIVE_FULLSCREEN_UNAVAILABLE', error.name || 'rejected');
      showToast('已使用兼容沉浸模式');
    }
  } else {
    record('NATIVE_FULLSCREEN_UNAVAILABLE', 'api-missing');
    showToast('已使用兼容沉浸模式');
  }
});

function nativeFullscreenChanged() {
  const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  if (!active && nativeFullscreenRequested) {
    nativeFullscreenRequested = false;
    setImmersive(false, 'native-exit');
  }
}
document.addEventListener('fullscreenchange', nativeFullscreenChanged);
document.addEventListener('webkitfullscreenchange', nativeFullscreenChanged);

for (const button of document.querySelectorAll('[data-control]')) {
  const action = button.dataset.control;
  if (button.dataset.mode === 'tap') {
    button.addEventListener('click', (event) => {
      if (!sendInput(action, 'tap', { clientEventMonoMs: event.timeStamp })) return;
      gameSettingsPanel.hidden = true;
      if (action === 'ESC') setInteractionMode(interactionMode === 'gui' ? 'look' : 'gui', 'menu-button');
      else if (action === 'INVENTORY') setInteractionMode('gui', 'inventory-button');
      else if (action === 'CHAT') {
        setInteractionMode('gui', 'chat-button');
        chatComposer.hidden = false;
        setTimeout(() => chatInput.focus(), 80);
        record('OPEN_CHAT_COMPOSER');
      }
      if (/^SLOT_[1-9]$/.test(action)) {
        for (const slot of document.querySelectorAll('[data-control^="SLOT_"]')) slot.classList.toggle('selected', slot.dataset.control === action);
        record('HOTBAR_SELECTED', action);
      }
    });
    continue;
  }
  if (button.dataset.mode === 'toggle') {
    button.addEventListener('click', (event) => {
      const enabled = !activeControls.has(action);
      if (!sendInput(action, enabled ? 'down' : 'up', { clientEventMonoMs: event.timeStamp })) return;
      if (enabled) activeControls.add(action); else activeControls.delete(action);
      button.classList.toggle('pressed', enabled);
      button.setAttribute('aria-pressed', String(enabled));
      record('TOGGLE_CONTROL', `action=${action}, enabled=${enabled}`);
    });
    continue;
  }
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (!activeControls.has(action) && sendInput(action, 'down', { clientEventMonoMs: event.timeStamp })) {
      activeControls.add(action);
      activePointers.set(event.pointerId, action);
      button.classList.add('pressed');
    }
    try { button.setPointerCapture(event.pointerId); } catch (error) { record('POINTER_CAPTURE_FALLBACK', `${action}, ${error.name}`); }
  });
  const release = (event) => {
    if (activePointers.get(event.pointerId) !== action) return;
    activePointers.delete(event.pointerId);
    if (activeControls.delete(action)) sendInput(action, 'up', { clientEventMonoMs: event.timeStamp });
    button.classList.remove('pressed');
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

function releasePointer(event) {
  const action = activePointers.get(event.pointerId);
  if (!action) return;
  activePointers.delete(event.pointerId);
  if (activeControls.delete(action)) sendInput(action, 'up', { clientEventMonoMs: event.timeStamp });
  document.querySelector(`[data-control="${action}"]`)?.classList.remove('pressed');
}
window.addEventListener('pointerup', releasePointer);
window.addEventListener('pointercancel', releasePointer);

settingsButton.addEventListener('click', () => {
  gameSettingsPanel.hidden = !gameSettingsPanel.hidden;
  record('TOGGLE_TOUCH_SETTINGS', `open=${!gameSettingsPanel.hidden}`);
});
closeSettingsButton.addEventListener('click', () => {
  gameSettingsPanel.hidden = true;
  record('CLOSE_TOUCH_SETTINGS');
});
guiDoneButton.addEventListener('click', () => setInteractionMode('look', 'gui-done-button'));
function renderSensitivity() {
  const percent = Math.round(lookSensitivity * 100);
  sensitivityRange.value = String(percent);
  sensitivityValue.value = `${percent}%`;
  sensitivityValue.textContent = `${percent}%`;
}
sensitivityRange.addEventListener('input', () => {
  lookSensitivity = Number(sensitivityRange.value) / 100;
  localStorage.setItem('remotePcl.lookSensitivity', sensitivityRange.value);
  renderSensitivity();
  record('CHANGE_LOOK_SENSITIVITY', `value=${sensitivityRange.value}%`);
});
renderSensitivity();

chatComposer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  if (sendInput('CHAT_TEXT', 'submit', { text, clientEventMonoMs: event.timeStamp })) {
    record('SUBMIT_CHAT_TEXT', `length=${text.length}`);
    chatInput.value = '';
    chatComposer.hidden = true;
    setInteractionMode('look', 'chat-submit');
  }
});
cancelChatButton.addEventListener('click', (event) => {
  sendInput('ESC', 'tap', { clientEventMonoMs: event.timeStamp });
  chatInput.value = '';
  chatComposer.hidden = true;
  setInteractionMode('look', 'chat-cancel');
  record('CANCEL_CHAT_TEXT');
});

function normalizedVideoPoint(event) {
  const rect = previewStage.getBoundingClientRect();
  const sourceWidth = videoCanvas.width || remoteVideo.naturalWidth || 16;
  const sourceHeight = videoCanvas.height || remoteVideo.naturalHeight || 9;
  const sourceRatio = sourceWidth / sourceHeight;
  const stageRatio = rect.width / rect.height;
  const renderedWidth = stageRatio > sourceRatio ? rect.height * sourceRatio : rect.width;
  const renderedHeight = stageRatio > sourceRatio ? rect.height : rect.width / sourceRatio;
  const offsetX = rect.left + (rect.width - renderedWidth) / 2;
  const offsetY = rect.top + (rect.height - renderedHeight) / 2;
  return {
    x: Math.max(0, Math.min(1, (event.clientX - offsetX) / renderedWidth)),
    y: Math.max(0, Math.min(1, (event.clientY - offsetY) / renderedHeight)),
  };
}

function nativeHotbarSlot(point) {
  const guiWidth = Math.max(1, targetGuiWidth || videoCanvas.width || 854);
  const guiHeight = Math.max(1, targetGuiHeight || videoCanvas.height || 480);
  const halfWidth = Math.min(0.42, 91 / guiWidth);
  const left = 0.5 - halfWidth;
  const right = 0.5 + halfWidth;
  const top = Math.max(0.82, 1 - 24 / guiHeight);
  if (point.y < top || point.x < left || point.x > right) return null;
  return Math.max(1, Math.min(9, Math.floor((point.x - left) / ((right - left) / 9)) + 1));
}

function bindLookSurface(surface, supportsGuiPointer = false) {
  surface.addEventListener('pointerdown', (event) => {
    if (!paired) { showToast('请先连接电脑'); return; }
    if (supportsGuiPointer && interactionMode === 'look' && event.pointerType === 'touch' && lookPointer !== null && event.pointerId !== lookPointer) {
      clearTimeout(attackHoldTimer);
      lookMoved = true;
      if (attackHeld) { sendInput('ATTACK', 'up'); attackHeld = false; }
      sendInput('USE', 'tap', { clientEventMonoMs: event.timeStamp });
      record('TWO_FINGER_USE');
      return;
    }
    lookPointer = event.pointerId;
    lookPointerKind = supportsGuiPointer && interactionMode === 'gui' ? 'gui' : 'look';
    if (supportsGuiPointer && interactionMode === 'look') {
      const hotbarSlot = nativeHotbarSlot(normalizedVideoPoint(event));
      if (hotbarSlot) lookPointerKind = `hotbar-${hotbarSlot}`;
    }
    lookX = event.clientX;
    lookY = event.clientY;
    lookStartX = lookX;
    lookStartY = lookY;
    lookMoved = false;
    try { surface.setPointerCapture(event.pointerId); } catch (error) { record('LOOK_POINTER_FALLBACK', error.name); }
    surface.classList.add('active');
    if (lookPointerKind === 'gui') sendInput('GUI_POINTER', 'down', { ...normalizedVideoPoint(event), clientEventMonoMs: event.timeStamp });
    else if (lookPointerKind.startsWith('hotbar-')) { /* Selection occurs on pointerup. */ }
    else if (supportsGuiPointer) {
      clearTimeout(attackHoldTimer);
      attackHoldTimer = setTimeout(() => {
        if (!lookMoved && lookPointer === event.pointerId && sendInput('ATTACK', 'down', { clientEventMonoMs: event.timeStamp })) attackHeld = true;
      }, 320);
    }
  });
  surface.addEventListener('pointermove', (event) => {
    if (event.pointerId !== lookPointer) return;
    if (lookPointerKind?.startsWith('hotbar-')) return;
    if (lookPointerKind === 'gui') {
      sendInput('GUI_POINTER', 'move', { ...normalizedVideoPoint(event), clientEventMonoMs: event.timeStamp });
      return;
    }
    if (Math.hypot(event.clientX - lookStartX, event.clientY - lookStartY) > 8) {
      lookMoved = true;
      clearTimeout(attackHoldTimer);
    }
    const dx = Math.max(-400, Math.min(400, (event.clientX - lookX) * 1.4 * lookSensitivity));
    const dy = Math.max(-400, Math.min(400, (event.clientY - lookY) * 1.4 * lookSensitivity));
    lookX = event.clientX;
    lookY = event.clientY;
    if (Math.abs(dx) >= 1 || Math.abs(dy) >= 1) sendInput('LOOK', 'delta', { dx, dy, clientEventMonoMs: event.timeStamp });
  });
  const end = (event) => {
    if (event.pointerId !== lookPointer) return;
    clearTimeout(attackHoldTimer);
    if (lookPointerKind === 'gui') sendInput('GUI_POINTER', 'up', { ...normalizedVideoPoint(event), clientEventMonoMs: event.timeStamp });
    else if (lookPointerKind?.startsWith('hotbar-') && event.type === 'pointerup') {
      const slot = Number(lookPointerKind.slice('hotbar-'.length));
      sendInput(`SLOT_${slot}`, 'tap', { clientEventMonoMs: event.timeStamp });
      record('NATIVE_HOTBAR_SELECTED', `slot=${slot}`);
    }
    else if (supportsGuiPointer && attackHeld) { sendInput('ATTACK', 'up', { clientEventMonoMs: event.timeStamp }); attackHeld = false; }
    else if (supportsGuiPointer && !lookMoved && event.type === 'pointerup') sendInput('ATTACK', 'tap', { clientEventMonoMs: event.timeStamp });
    lookPointer = null;
    lookPointerKind = null;
    surface.classList.remove('active');
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', end);
}
bindLookSurface(gameLookLayer, true);

function setJoystickActions(desired, clientEventMonoMs = performance.now()) {
  for (const action of [...joystickHeld]) {
    if (!desired.has(action)) {
      joystickHeld.delete(action);
      activeControls.delete(action);
      sendInput(action, 'up', { clientEventMonoMs });
    }
  }
  for (const action of desired) {
    if (!joystickHeld.has(action) && sendInput(action, 'down', { clientEventMonoMs })) {
      joystickHeld.add(action);
      activeControls.add(action);
    }
  }
}

function updateJoystick(event) {
  const ring = moveJoystick.querySelector('.joystick-ring');
  const rect = ring.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const maxTravel = Math.max(1, rect.width / 2 - joystickKnob.offsetWidth / 2);
  let dx = event.clientX - centerX;
  let dy = event.clientY - centerY;
  const distance = Math.hypot(dx, dy);
  if (distance > maxTravel) { dx = dx / distance * maxTravel; dy = dy / distance * maxTravel; }
  joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  const nx = dx / maxTravel;
  const ny = dy / maxTravel;
  const desired = new Set();
  if (ny < -0.22) desired.add('FORWARD');
  if (ny > 0.22) desired.add('BACK');
  if (nx < -0.22) desired.add('LEFT');
  if (nx > 0.22) desired.add('RIGHT');
  setJoystickActions(desired, event.timeStamp);
}

moveJoystick.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  if (!paired || interactionMode === 'gui') { showToast(paired ? '请先完成菜单操作' : '请先连接电脑'); return; }
  joystickPointer = event.pointerId;
  moveJoystick.classList.add('active');
  try { moveJoystick.setPointerCapture(event.pointerId); } catch (error) { record('JOYSTICK_POINTER_FALLBACK', error.name); }
  updateJoystick(event);
});
moveJoystick.addEventListener('pointermove', (event) => { if (event.pointerId === joystickPointer) updateJoystick(event); });
function releaseJoystick(event) {
  if (event.pointerId !== joystickPointer) return;
  joystickPointer = null;
  moveJoystick.classList.remove('active');
  setJoystickActions(new Set(), event.timeStamp);
  joystickKnob.style.transform = 'translate(-50%,-50%)';
}
moveJoystick.addEventListener('pointerup', releaseJoystick);
moveJoystick.addEventListener('pointercancel', releaseJoystick);
moveJoystick.addEventListener('lostpointercapture', releaseJoystick);
gameControlsOverlay.addEventListener('contextmenu', (event) => event.preventDefault());

document.querySelector('#clearLogButton').addEventListener('click', () => {
  events = [];
  renderLogs();
  record('VISIBLE_LOG_CLEARED', '仅清空手机界面，电脑日志保留');
});

remoteVideo.addEventListener('load', () => {
  if (previewStage.classList.contains('fallback-video')) { renderedVideoFrames += 1; jpegFallbackFrames += 1; }
  if (!videoFirstFrameSeen) {
    videoFirstFrameSeen = true;
    record('VIDEO_STREAM_READY');
  }
});
remoteVideo.addEventListener('error', () => { if (paired) record('VIDEO_STREAM_ERROR'); });
setInterval(() => {
  if (paired) {
    document.querySelector('.stream-stats span:nth-child(2) strong').textContent = `${renderedVideoFrames} / ${sourceVideoFps || '—'}`;
    hudDisplayFps.textContent = String(renderedVideoFrames);
    hudSourceFps.textContent = sourceVideoFps ? sourceVideoFps.toFixed(0) : '—';
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'client-stats', displayedFps: renderedVideoFrames, transport: videoTransport, decoderQueue: h264Decoder?.decodeQueueSize || 0, h264Frames: h264DecodedFrames, jpegFrames: jpegFallbackFrames, fallbackReason, ...latestVideoTimings, clientMonoMs: performance.now() }));
      socket.send(JSON.stringify({ type: 'ping', clientMonoMs: performance.now() }));
    }
  }
  renderedVideoFrames = 0;
}, 1000);
window.addEventListener('beforeunload', () => {
  if (paired && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'input', seq: sequence++ >>> 0, action: 'RELEASE_ALL', phase: 'tap', clientMonoMs: performance.now() }));
  }
});

renderLogs();
record('MOBILE_UI_READY', 'controlProtocol=1, mediaSeparate=true');
