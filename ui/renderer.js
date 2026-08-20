'use strict';

const elements = {
  status: document.querySelector('#statusBadge'),
  windowSelect: document.querySelector('#windowSelect'),
  windowHint: document.querySelector('#windowHint'),
  refresh: document.querySelector('#refreshButton'),
  fps: document.querySelector('#fpsSelect'),
  bitrate: document.querySelector('#bitrateSelect'),
  start: document.querySelector('#startButton'),
  stop: document.querySelector('#stopButton'),
  clear: document.querySelector('#clearLogButton'),
  output: document.querySelector('#logOutput'),
  logPath: document.querySelector('#logPath'),
  previewImage: document.querySelector('#previewImage'),
  previewStage: document.querySelector('.preview-stage'),
  previewStatus: document.querySelector('#previewStatus'),
  pairingBackdrop: document.querySelector('#pairingBackdrop'),
  pairingDialog: document.querySelector('#pairingDialog'),
  pairingPin: document.querySelector('#hostPairingPin'),
  phoneUrl: document.querySelector('#hostPhoneUrl'),
  copyPairing: document.querySelector('#copyPairingButton'),
  closePairing: document.querySelector('#closePairingButton'),
};

let windows = [];
let running = false;
let previewUrl = null;
let pairingText = '';

function timestamp() { return new Date().toISOString(); }
function formatTime(value) { return new Date(value).toLocaleTimeString('zh-CN', { hour12: false }); }

function addLog(level, event, detail = '', time = timestamp()) {
  const line = document.createElement('div');
  line.className = `log-line ${String(level).toLowerCase() === 'error' ? 'error' : ''}`;
  line.innerHTML = `<span class="log-time"></span><span class="log-level"></span><span class="log-message"></span>`;
  line.querySelector('.log-time').textContent = formatTime(time);
  line.querySelector('.log-level').textContent = level;
  line.querySelector('.log-message').textContent = `${event}${detail ? ` · ${detail}` : ''}`;
  elements.output.appendChild(line);
  while (elements.output.children.length > 500) elements.output.firstChild.remove();
  elements.output.scrollTop = elements.output.scrollHeight;
}

function recordClick(event, detail = '') {
  addLog('UI', event, detail);
  window.remotePcl.recordUiEvent(event, detail);
}

function updateState(isRunning, message) {
  running = isRunning;
  elements.status.className = `status-badge ${running ? 'running' : 'idle'}`;
  elements.status.querySelector('strong').textContent = message || (running ? '正在运行' : '尚未运行');
  elements.start.disabled = running || !elements.windowSelect.value;
  elements.stop.disabled = !running;
  elements.refresh.disabled = running;
  elements.windowSelect.disabled = running;
  elements.fps.disabled = running;
  elements.bitrate.disabled = running;
}

async function refreshWindows() {
  recordClick('CLICK_REFRESH_WINDOWS', '刷新 Java/Minecraft 窗口');
  elements.refresh.disabled = true;
  elements.windowHint.textContent = '正在扫描，请稍候…';
  const result = await window.remotePcl.listWindows();
  windows = result.windows || [];
  elements.windowSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = windows.length ? '请选择用于远程预览的 Minecraft' : '未找到 Java/Minecraft 窗口';
  elements.windowSelect.appendChild(placeholder);
  for (const item of windows) {
    const option = document.createElement('option');
    option.value = item.hwnd;
    option.textContent = `${item.title}  ·  PID ${item.pid}  ·  ${item.width}×${item.height}`;
    elements.windowSelect.appendChild(option);
  }
  elements.windowHint.textContent = result.ok ? `找到 ${windows.length} 个候选窗口。请根据 PID 和尺寸确认 Minecraft B。` : result.error;
  elements.refresh.disabled = running;
  updateState(running);
}

elements.refresh.addEventListener('click', refreshWindows);
elements.windowSelect.addEventListener('change', () => {
  const selected = windows.find((item) => item.hwnd === elements.windowSelect.value);
  recordClick('SELECT_TARGET_WINDOW', selected ? `PID=${selected.pid}, HWND=${selected.hwndHex}, ${selected.title}` : '取消选择');
  elements.windowHint.textContent = selected ? `已锁定 PID ${selected.pid} / ${selected.hwndHex}。目标消失时会停止，不会切换实例。` : '请选择一个目标。';
  updateState(running);
});
elements.fps.addEventListener('change', () => recordClick('CHANGE_FPS', elements.fps.value));
elements.bitrate.addEventListener('change', () => recordClick('CHANGE_BITRATE', elements.bitrate.value));
elements.start.addEventListener('click', async () => {
  const selected = windows.find((item) => item.hwnd === elements.windowSelect.value);
  recordClick('CLICK_START_PIPELINE', selected ? `PID=${selected.pid}, FPS=${elements.fps.value}, bitrate=${elements.bitrate.value}` : '无目标');
  updateState(true, '正在启动…');
  const result = await window.remotePcl.startPipeline({ hwnd: elements.windowSelect.value, fps: elements.fps.value, bitrate: elements.bitrate.value });
  if (!result.ok) { addLog('ERROR', 'START_REJECTED', result.error); updateState(false, '启动失败'); }
});
elements.stop.addEventListener('click', async () => {
  recordClick('CLICK_STOP_PIPELINE', '用户手动停止');
  await window.remotePcl.stopPipeline();
  updateState(false, '正在停止…');
});
elements.clear.addEventListener('click', () => {
  recordClick('CLICK_CLEAR_VISIBLE_LOG', '仅清空界面，磁盘日志保留');
  elements.output.replaceChildren();
  addLog('INFO', 'VISIBLE_LOG_CLEARED', '磁盘日志未删除');
});
elements.copyPairing.addEventListener('click', async () => {
  await window.remotePcl.copyText(pairingText);
  recordClick('COPY_PAIRING_INFO', '配对地址与配对码已复制');
  elements.copyPairing.textContent = '已复制';
});
elements.closePairing.addEventListener('click', () => { elements.pairingDialog.hidden = true; elements.pairingBackdrop.hidden = true; recordClick('CLOSE_PAIRING_DIALOG'); });

window.remotePcl.onLog((entry) => addLog(entry.level, entry.event, entry.detail, entry.timestamp));
window.remotePcl.onPipelineState((state) => updateState(state.running, state.message));
window.remotePcl.onPreviewState((state) => {
  elements.previewStage.classList.toggle('ready', state.ready);
  elements.previewStatus.textContent = state.ready ? '画面已连接' : (running ? '正在等待画面' : '等待启动');
  if (state.ready) updateState(true, '正在运行');
  if (!state.ready && previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    elements.previewImage.removeAttribute('src');
  }
});
window.remotePcl.onPreviewFrame((data) => {
  const nextUrl = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' }));
  elements.previewImage.src = nextUrl;
  elements.previewStage.classList.add('ready');
  elements.previewStatus.textContent = '画面已连接';
  updateState(true, '正在运行');
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = nextUrl;
});
window.remotePcl.onPairingCode((data) => {
  const url = data.phoneUrls?.[0] || '未找到局域网地址';
  elements.pairingPin.textContent = data.pin;
  elements.phoneUrl.textContent = url;
  pairingText = `RemotePCL\n地址：${url}\n配对码：${data.pin}`;
  elements.copyPairing.textContent = '复制配对信息';
  elements.pairingBackdrop.hidden = false;
  elements.pairingDialog.hidden = false;
  recordClick('SHOW_PAIRING_CODE', `url=${url}`);
});

(async () => {
  const info = await window.remotePcl.getAppInfo();
  elements.logPath.textContent = info.logPath;
  elements.logPath.title = info.logPath;
  addLog('INFO', 'UI_READY', `RemotePCL v${info.version}`);
  await window.remotePcl.recordUiEvent('UI_READY', `version=${info.version}`);
  updateState(info.running);
})();
