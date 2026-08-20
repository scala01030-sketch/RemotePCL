#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const port = Number(process.argv[2] || 9222);
const hwnd = String(process.argv[3] || '');
const stopOnly = hwnd === '--stop';
if (!Number.isInteger(port) || (!stopOnly && !/^\d+$/.test(hwnd))) {
  console.error('Usage: node scripts/electron-ui-smoke.js PORT HWND|--stop');
  process.exit(2);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function main() {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page' && item.title === 'RemotePCL');
  if (!target?.webSocketDebuggerUrl) throw new Error('RemotePCL DevTools target not found');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });

  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await delay(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  await waitFor('Boolean(window.remotePcl && document.querySelector("#refreshButton"))', 5000, 'renderer readiness');
  if (stopOnly) {
    await evaluate('document.querySelector("#stopButton").click(); true');
    await waitFor('document.querySelector("#stopButton").disabled && !document.querySelector(".preview-stage").classList.contains("ready")', 10000, 'pipeline stop');
    socket.close();
    console.log('ELECTRON_UI_STOP_OK');
    return;
  }
  await evaluate('document.querySelector("#refreshButton").click(); true');
  await waitFor(`Boolean(document.querySelector('#windowSelect option[value="${hwnd}"]'))`, 10000, 'target window option');
  await evaluate(`(() => { const select = document.querySelector('#windowSelect'); select.value = '${hwnd}'; select.dispatchEvent(new Event('change', { bubbles: true })); return !document.querySelector('#startButton').disabled; })()`);
  await evaluate('document.querySelector("#startButton").click(); true');
  await waitFor('document.querySelector(".preview-stage").classList.contains("ready") && document.querySelector("#previewImage").src.startsWith("blob:")', 20000, 'decoded local preview');
  await waitFor('document.querySelector("#hostPairingPin").textContent.trim().length === 6', 5000, 'pairing details');

  const state = await evaluate(`(() => ({
    status: document.querySelector('#statusBadge strong').textContent,
    previewStatus: document.querySelector('#previewStatus').textContent,
    previewWidth: document.querySelector('#previewImage').naturalWidth,
    previewHeight: document.querySelector('#previewImage').naturalHeight,
    pin: document.querySelector('#hostPairingPin').textContent.trim(),
    phoneUrl: document.querySelector('#hostPhoneUrl').textContent.trim(),
    logHasPreviewReady: document.querySelector('#logOutput').textContent.includes('PREVIEW_READY'),
    selectedHwnd: document.querySelector('#windowSelect').value,
  }))()`);
  socket.close();
  console.log(`ELECTRON_UI_SMOKE_OK ${JSON.stringify(state)}`);
}

main().catch((error) => {
  console.error(`ELECTRON_UI_SMOKE_FAILED ${error.message}`);
  process.exitCode = 1;
});
