'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('desktop package exposes UI and portable EXE build commands', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.main, 'ui/main.js');
  assert.equal(pkg.scripts.ui, 'electron .');
  assert.match(pkg.scripts.build, /electron-builder/);
  assert.equal(pkg.build.win.target, 'portable');
  assert.match(pkg.scripts['build:input-agent'], /build-input-agent\.ps1/);
  const inputAgentResource = pkg.build.extraResources.find((entry) => entry.to === 'input-agent');
  assert.equal(inputAgentResource.from, 'build/input-agent-package');
  assert.deepEqual(inputAgentResource.filter, ['remote-input-agent.jar']);
});

test('beginner UI contains the five-stage architecture and three primary steps', () => {
  const html = read('ui/index.html');
  for (const text of ['捕获', '编码', 'EncodedFrame', '解码', '预览', '选择游戏窗口', '画面设置', '开始预览', '后台日志']) {
    assert.ok(html.includes(text), `missing UI label: ${text}`);
  }
});

test('decoded preview is embedded in the control window', () => {
  const html = read('ui/index.html');
  const renderer = read('ui/renderer.js');
  const main = read('ui/main.js');
  assert.match(html, /id="previewImage"/);
  assert.match(renderer, /onPreviewFrame/);
  assert.match(main, /REMOTE_PCL_PREVIEW_FD/);
  assert.match(main, /PREVIEW_READY/);
  assert.match(main, /RemotePCL 启动失败/);
  assert.match(renderer, /updateState\(true, '正在运行'\)/);
});

test('host displays and copies pairing details without external developer tools', () => {
  const html = read('ui/index.html');
  const main = read('ui/main.js');
  const renderer = read('ui/renderer.js');
  assert.match(html, /id="pairingDialog"/);
  assert.match(html, /id="hostPairingPin"/);
  assert.match(html, /id="copyPairingButton"/);
  assert.match(main, /remote-session-server\.js/);
  assert.match(main, /'pairing-code'/);
  assert.match(renderer, /onPairingCode/);
});

test('every interactive control has a timestamped event-log path', () => {
  const renderer = read('ui/renderer.js');
  for (const event of [
    'CLICK_REFRESH_WINDOWS', 'SELECT_TARGET_WINDOW', 'CHANGE_FPS', 'CHANGE_BITRATE',
    'CLICK_START_PIPELINE', 'CLICK_STOP_PIPELINE', 'CLICK_CLEAR_VISIBLE_LOG',
  ]) assert.ok(renderer.includes(event), `missing event: ${event}`);
  const main = read('ui/main.js');
  assert.match(main, /new Date\(\)\.toISOString\(\)/);
  assert.match(main, /appendFileSync/);
  assert.match(main, /\.log`/);
});
