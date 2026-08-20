'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('mobile UI exposes stream, control, and log navigation for beginners', () => {
  const html = read('mobile/index.html');
  for (const text of ['开始串流', '连接你的电脑', '只需三步', '触控操作', '运行日志', '串流', '控制', '日志']) {
    assert.ok(html.includes(text), `missing mobile label: ${text}`);
  }
  assert.match(html, /name="viewport"/);
  assert.match(html, /viewport-fit=cover/);
});

test('mobile UI keeps control, response, and video responsibilities explicit', () => {
  const html = read('mobile/index.html');
  const script = read('mobile/app.js');
  assert.match(html, /当前默认基岩版触控 → Java 默认键位/);
  assert.match(html, /6 位配对码/);
  assert.match(script, /new WebSocket/);
  assert.match(script, /\/control/);
  assert.match(script, /message\.videoUrl/);
  assert.match(script, /INPUT_ACK/);
  assert.match(html, /class="game-controls-overlay"/);
  assert.match(html, /id="gameLookLayer"/);
  assert.match(html, /id="moveJoystick"/);
  assert.doesNotMatch(html, /id="overlayHotbar"/);
  assert.match(html, /id="videoCanvas"/);
  assert.match(html, /id="hudDisplayFps"/);
  assert.match(html, /id="hudSourceFps"/);
  assert.match(html, /id="hudInputState"/);
  assert.match(html, /id="sensitivityRange"/);
  assert.match(html, /id="chatComposer"/);
  assert.match(html, /data-control="PERSPECTIVE"/);
  assert.match(html, /data-control="PICK_BLOCK" data-mode="tap"/);
  assert.match(html, /data-control="USE" data-mode="hold"/);
  assert.match(html, /class="bedrock-crosshair"/);
  assert.match(html, /data-control="SNEAK"/);
  assert.match(html, /data-control="SPRINT" data-mode="toggle"/);
  assert.match(html, /data-control="SNEAK" data-mode="toggle"/);
  assert.match(html, /data-control="INVENTORY"/);
  assert.match(script, /NATIVE_FULLSCREEN_UNAVAILABLE/);
  assert.match(script, /setImmersive\(true/);
  assert.match(script, /POINTER_CAPTURE_FALLBACK/);
  assert.match(script, /GUI_POINTER/);
  assert.match(script, /pair-screen:/);
  assert.match(script, /lookSensitivity/);
  assert.match(script, /media-stats/);
  assert.match(script, /videoSocketUrl/);
  assert.match(script, /pendingVideoFrame/);
  assert.match(script, /createImageBitmap/);
  assert.match(script, /new VideoDecoder/);
  assert.match(script, /new EncodedVideoChunk/);
  assert.match(script, /client-stats/);
  assert.match(script, /CHAT_TEXT/);
  assert.match(script, /setJoystickActions/);
  assert.match(script, /nativeHotbarSlot/);
  assert.match(script, /NATIVE_HOTBAR_SELECTED/);
  assert.match(script, /targetGuiWidth/);
  assert.match(script, /91 \/ guiWidth/);
  assert.match(script, /VIDEO_SOCKET_FALLBACK/);
  assert.match(script, /inputUplinkMs/);
  assert.match(script, /endToEndMs/);
  assert.match(script, /packet\[4\] === 2/);
  assert.match(script, /hudDisplayFps\.textContent = String\(renderedVideoFrames\)/);
  assert.match(script, /imageSmoothingQuality = 'high'/);
});

test('mobile interactions are timestamped and touch targets meet 48px baseline', () => {
  const script = read('mobile/app.js');
  const styles = read('mobile/styles.css');
  assert.match(script, /new Date\(\)\.toISOString\(\)/);
  assert.match(script, /MOBILE_UI_READY/);
  assert.match(script, /NAVIGATE_TAB/);
  assert.match(script, /OPEN_CONNECTION_SHEET/);
  assert.match(script, /performance\.now\(\)/);
  assert.match(styles, /button\s*\{[^}]*min-height:\s*48px/s);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
});

test('mobile preview server listens on LAN and advertises phone URLs', () => {
  const server = read('scripts/mobile-preview-server.js');
  assert.match(server, /const host = .*'0\.0\.0\.0'/);
  assert.match(server, /server\.listen\(port, host/);
  assert.match(server, /Phone browser \(same Wi-Fi\/LAN\)/);
  assert.match(server, /connect-src 'none'/);
});
