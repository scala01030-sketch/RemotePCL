'use strict';

const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

app.setName('RemotePCL');

let mainWindow = null;
let backend = null;
let backendStopRequested = false;
let logPath = null;

function isoNow() { return new Date().toISOString(); }

function appendDiskLog(level, event, detail = '') {
  if (!logPath) return;
  const cleanDetail = String(detail).replace(/\r?\n/g, ' ↩ ');
  fs.appendFileSync(logPath, `[${isoNow()}] [${level}] ${event}${cleanDetail ? ` | ${cleanDetail}` : ''}\n`, 'utf8');
}

function emitLog(level, event, detail = '') {
  appendDiskLog(level, event, detail);
  mainWindow?.webContents.send('app-log', { timestamp: isoNow(), level, event, detail: String(detail) });
}

function projectPath(...parts) {
  if (!app.isPackaged) return path.join(__dirname, '..', ...parts);
  return path.join(process.resourcesPath, 'app.asar', ...parts);
}

function probePath() {
  if (!app.isPackaged) return path.join(__dirname, '..', 'scripts', 'window-probe.ps1');
  return path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'window-probe.ps1');
}

function inputAgentPath() {
  if (!app.isPackaged) return path.join(__dirname, '..', 'vendor', 'remote-input-agent');
  return path.join(process.resourcesPath, 'input-agent');
}

function ffmpegPath() {
  if (!app.isPackaged) return path.join(__dirname, '..', 'vendor', 'ffmpeg-gfxcapture-runtime', 'ffmpeg.exe');
  return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#111111',
    title: 'RemotePCL — 本地串流控制台',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function runProbe() {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probePath(), '-Action', 'List',
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `窗口扫描失败，退出码 ${code}`));
      if (!stdout.trim()) return resolve([]);
      const parsed = JSON.parse(stdout);
      resolve(Array.isArray(parsed) ? parsed : [parsed]);
    });
  });
}

function stopBackend(reason = '用户请求停止') {
  if (!backend) return false;
  backendStopRequested = true;
  emitLog('INFO', 'PIPELINE_STOP_REQUESTED', reason);
  backend.kill();
  return true;
}

ipcMain.handle('get-app-info', () => ({ logPath, version: app.getVersion(), running: Boolean(backend) }));

ipcMain.handle('list-windows', async () => {
  emitLog('INFO', 'WINDOW_SCAN_STARTED', '用户点击刷新实例');
  try {
    const windows = await runProbe();
    emitLog('INFO', 'WINDOW_SCAN_COMPLETED', `发现 ${windows.length} 个 Java 窗口`);
    return { ok: true, windows };
  } catch (error) {
    emitLog('ERROR', 'WINDOW_SCAN_FAILED', error.message);
    return { ok: false, error: error.message, windows: [] };
  }
});

ipcMain.handle('record-ui-event', (_event, payload) => {
  appendDiskLog('UI', payload.event, payload.detail || '');
  return true;
});
ipcMain.handle('copy-text', (_event, text) => { clipboard.writeText(String(text)); return true; });

ipcMain.handle('start-pipeline', async (_event, options) => {
  if (backend) return { ok: false, error: '串流已经在运行。' };
  const hwnd = String(options.hwnd || '');
  if (!/^0x[0-9a-f]+$|^\d+$/i.test(hwnd)) return { ok: false, error: '请选择有效的 Minecraft 窗口。' };
  const fps = Number(options.fps);
  const bitrate = String(options.bitrate);
  emitLog('INFO', 'PIPELINE_START_REQUESTED', `HWND=${hwnd}, FPS=${fps}, bitrate=${bitrate}`);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    REMOTE_PCL_PROBE_SCRIPT: probePath(),
    REMOTE_PCL_INPUT_AGENT_DIR: inputAgentPath(),
    REMOTE_PCL_MOBILE_ROOT: projectPath('mobile'),
    REMOTE_PCL_LOG_ROOT: path.dirname(logPath),
    FFMPEG_PATH: ffmpegPath(),
  };
  backendStopRequested = false;
  let backendErrorDetail = '';
  let previewBuffer = Buffer.alloc(0);
  let previewReady = false;
  backend = spawn(process.execPath, [
    projectPath('scripts', 'remote-session-server.js'), '--hwnd', hwnd, '--fps', String(fps), '--bitrate', bitrate,
  ], {
    env: { ...env, REMOTE_PCL_PREVIEW_FD: '3' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  backend.stdio[3].on('data', (chunk) => {
    previewBuffer = Buffer.concat([previewBuffer, chunk]);
    while (true) {
      const start = previewBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { previewBuffer = previewBuffer.subarray(Math.max(0, previewBuffer.length - 1)); break; }
      const end = previewBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) { if (start > 0) previewBuffer = previewBuffer.subarray(start); break; }
      const frame = previewBuffer.subarray(start, end + 2);
      previewBuffer = previewBuffer.subarray(end + 2);
      if (!previewReady) {
        previewReady = true;
        emitLog('INFO', 'PREVIEW_READY', '控制台已收到首个解码画面');
        mainWindow?.webContents.send('preview-state', { ready: true });
      }
      mainWindow?.webContents.send('preview-frame', frame);
    }
    if (previewBuffer.length > 12 * 1024 * 1024) {
      previewBuffer = Buffer.alloc(0);
      emitLog('ERROR', 'PREVIEW_FRAME_RESET', '预览帧超过缓冲上限，已重新同步');
    }
  });
  let stdoutPending = '';
  backend.stdout.on('data', (data) => {
    stdoutPending += data.toString();
    const lines = stdoutPending.split(/\r?\n/);
    stdoutPending = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('REMOTE_PCL_EVENT ')) {
        try {
          const event = JSON.parse(line.slice('REMOTE_PCL_EVENT '.length));
          if (event.type === 'pairing-code') mainWindow?.webContents.send('pairing-code', event);
          else if (event.type === 'critical-status') {
            emitLog('ERROR', event.code || 'CRITICAL_STATUS', event.message || '后端关键错误');
            if (mainWindow) dialog.showMessageBox(mainWindow, { type: 'warning', title: 'RemotePCL 串流已停止', message: event.message || 'Minecraft B 当前不可用。', detail: '远程输入不会切换到其他窗口，也不会回退到 Windows 全局输入。' });
          }
        } catch (error) { emitLog('ERROR', 'BACKEND_EVENT_INVALID', error.message); }
      } else emitLog('BACKEND', 'STDOUT', line.trim());
    }
  });
  backend.stderr.on('data', (data) => {
    const detail = data.toString().trim();
    backendErrorDetail = `${backendErrorDetail}\n${detail}`.trim().slice(-4000);
    emitLog('ERROR', 'STDERR', detail);
  });
  backend.on('error', (error) => {
    emitLog('ERROR', 'PIPELINE_PROCESS_ERROR', error.message);
    mainWindow?.webContents.send('pipeline-state', { running: false, message: error.message });
    backend = null;
  });
  backend.on('close', (code) => {
    const expected = backendStopRequested || code === 0;
    emitLog(expected ? 'INFO' : 'ERROR', 'PIPELINE_EXITED', expected ? '已正常停止' : `退出码 ${code}`);
    backend = null;
    backendStopRequested = false;
    mainWindow?.webContents.send('preview-state', { ready: false });
    mainWindow?.webContents.send('pipeline-state', { running: false, message: `串流已停止（退出码 ${code}）` });
    if (!expected && mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'RemotePCL 启动失败',
        message: '串流后端未能启动，本地预览没有可显示的画面。',
        detail: backendErrorDetail || `后端退出码：${code}`,
      });
    }
  });
  mainWindow?.webContents.send('pipeline-state', { running: true, message: '串流启动中…' });
  return { ok: true };
});

ipcMain.handle('stop-pipeline', () => ({ ok: stopBackend() }));

app.whenReady().then(() => {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logPath = path.join(logDir, `RemotePCL-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  appendDiskLog('INFO', 'APPLICATION_STARTED', `version=${app.getVersion()}, packaged=${app.isPackaged}`);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => {
  appendDiskLog('INFO', 'APPLICATION_CLOSING');
  if (backend) backend.kill();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
