'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BEDROCK_TO_JAVA, normalizeInputMessage, toBridgeCommand } = require('../src/remote/input-contract');
const { WindowsInputBridge } = require('../src/remote/windows-input-bridge');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('Bedrock-style controls map only to fixed Java default bindings', () => {
  assert.deepEqual(BEDROCK_TO_JAVA.FORWARD, { kind: 'key', virtualKey: 0x57, mode: 'hold', label: '前进 / W' });
  assert.equal(BEDROCK_TO_JAVA.JUMP.virtualKey, 0x20);
  assert.equal(BEDROCK_TO_JAVA.SPRINT.virtualKey, 0xA2);
  assert.equal(BEDROCK_TO_JAVA.SNEAK.virtualKey, 0xA0);
  assert.equal(BEDROCK_TO_JAVA.ATTACK.button, 'left');
  assert.equal(BEDROCK_TO_JAVA.USE.button, 'right');
  assert.equal(BEDROCK_TO_JAVA.LOOK.kind, 'mouseMove');
  assert.equal(BEDROCK_TO_JAVA.GUI_POINTER.kind, 'pointerAbsolute');
});

test('input contract preserves hold phases and bounds relative look deltas', () => {
  const down = normalizeInputMessage({ type: 'input', seq: 7, action: 'FORWARD', phase: 'down', clientMonoMs: 12.5 });
  assert.deepEqual(toBridgeCommand(down), { seq: 7, kind: 'key', virtualKey: 0x57, phase: 'down' });
  const look = normalizeInputMessage({ type: 'input', seq: 8, action: 'LOOK', phase: 'delta', dx: 12.2, dy: -4.8, clientMonoMs: 13 });
  assert.deepEqual(toBridgeCommand(look), { seq: 8, kind: 'mouseMove', dx: 12, dy: -5 });
  const guiTap = normalizeInputMessage({ type: 'input', seq: 12, action: 'GUI_POINTER', phase: 'tap', x: 0.25, y: 0.75, clientMonoMs: 17 });
  assert.deepEqual(toBridgeCommand(guiTap), { seq: 12, kind: 'pointerAbsolute', phase: 'tap', x: 0.25, y: 0.75 });
  const attackTap = normalizeInputMessage({ type: 'input', seq: 14, action: 'ATTACK', phase: 'tap', clientMonoMs: 18 });
  assert.deepEqual(toBridgeCommand(attackTap), { seq: 14, kind: 'mouseButton', button: 'left', phase: 'tap' });
  const useDown = normalizeInputMessage({ type: 'input', seq: 17, action: 'USE', phase: 'down', clientMonoMs: 20 });
  assert.deepEqual(toBridgeCommand(useDown), { seq: 17, kind: 'mouseButton', button: 'right', phase: 'down' });
  const useUp = normalizeInputMessage({ type: 'input', seq: 18, action: 'USE', phase: 'up', clientMonoMs: 21 });
  assert.deepEqual(toBridgeCommand(useUp), { seq: 18, kind: 'mouseButton', button: 'right', phase: 'up' });
  const pickBlock = normalizeInputMessage({ type: 'input', seq: 19, action: 'PICK_BLOCK', phase: 'tap', clientMonoMs: 22 });
  assert.deepEqual(toBridgeCommand(pickBlock), { seq: 19, kind: 'mouseButton', button: 'middle', phase: 'tap' });
  const chat = normalizeInputMessage({ type: 'input', seq: 15, action: 'CHAT_TEXT', phase: 'submit', text: 'hello 世界', clientMonoMs: 19 });
  assert.deepEqual(toBridgeCommand(chat), { seq: 15, kind: 'text', text: 'hello 世界' });
  assert.throws(() => normalizeInputMessage({ type: 'input', seq: 9, action: 'FORWARD', phase: 'tap', clientMonoMs: 14 }), /requires phase/);
  assert.throws(() => normalizeInputMessage({ type: 'input', seq: 10, action: 'LOOK', phase: 'delta', dx: 999, dy: 0, clientMonoMs: 15 }), /dx must be between/);
  assert.throws(() => normalizeInputMessage({ type: 'input', seq: 11, action: 'ARBITRARY_KEY', phase: 'tap', clientMonoMs: 16 }), /Unsupported/);
  assert.throws(() => normalizeInputMessage({ type: 'input', seq: 13, action: 'GUI_POINTER', phase: 'tap', x: 2, y: 0, clientMonoMs: 18 }), /x must be between/);
  assert.throws(() => normalizeInputMessage({ type: 'input', seq: 16, action: 'CHAT_TEXT', phase: 'submit', text: '', clientMonoMs: 20 }), /1 to 256/);
});

test('remote session separates video, audio status, and control-response endpoints', () => {
  const server = read('scripts/remote-session-server.js');
  assert.match(server, /\/media\/video\.mjpeg/);
  assert.match(server, /\/media\/video/);
  assert.match(server, /videoSocketUrl/);
  assert.match(server, /h264SocketUrl/);
  assert.match(server, /video\.h264/);
  assert.match(server, /PHONE_RENDER_STATS/);
  assert.match(server, /bufferedAmount/);
  assert.match(server, /VIDEO_PACKET_VERSION = 2/);
  assert.match(server, /serverAppliedNs/);
  assert.match(server, /clientEventMonoMs/);
  assert.match(server, /screenOpen: targetScreen\.open/);
  assert.match(server, /appliedInputTimings\.splice/);
  assert.match(server, /TARGET_RESOLUTION_CHANGED/);
  assert.match(server, /\/media\/audio/);
  assert.match(server, /\/control/);
  assert.match(server, /WebSocketServer\(\{ noServer: true/);
  assert.match(server, /request\.headers\.origin !== expectedOrigin/);
  assert.match(server, /crypto\.randomInt/);
  assert.match(server, /crypto\.randomBytes/);
  assert.match(server, /pairFailuresByAddress/);
  assert.match(server, /INPUT_APPLIED/);
  assert.match(server, /releaseAll/);
  assert.match(server, /REMOTE_SESSION_START_FAILED/);
  assert.match(server, /cleanupResources/);
  assert.match(server, /let watcher = null/);
});

test('target JVM input adapter is PID-bound and has no Windows-global input fallback', () => {
  const bridge = read('src/remote/windows-input-bridge.js');
  const agent = read('src/remote/agent/RemoteInputAgent.java');
  assert.match(bridge, /--pid', String\(this\.target\.pid\)/);
  assert.match(bridge, /TARGET_INPUT_AGENT_IDENTITY_MISMATCH/);
  assert.match(bridge, /releaseAll/);
  assert.match(agent, /VirtualMachine\.attach/);
  assert.match(agent, /net\.minecraft\.client\.Minecraft/);
  assert.match(agent, /KeyMapping\/player\/screen state/);
  assert.doesNotMatch(`${bridge}\n${agent}`, /SendInput|SetCursorPos|SetForegroundWindow|GetForegroundWindow|AttachThreadInput|PostMessage/);
  assert.match(agent, /void look\(double dx, double dy\)/);
  assert.match(agent, /void pointer\(String phase/);
  assert.match(agent, /void releaseAll\(\)/);
});

test('input agent selection is explicit and does not depend on extracted file timestamps', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remotepcl-agent-test-'));
  try {
    const oldJar = path.join(directory, 'remote-input-agent-000000000001.jar');
    const currentJar = path.join(directory, 'remote-input-agent-ffffffffffff.jar');
    fs.writeFileSync(oldJar, 'old');
    fs.writeFileSync(currentJar, 'current');
    const sameTime = new Date('2026-08-20T00:00:00.000Z');
    fs.utimesSync(oldJar, sameTime, sameTime);
    fs.utimesSync(currentJar, sameTime, sameTime);
    fs.writeFileSync(path.join(directory, 'current-agent.txt'), path.basename(currentJar));
    assert.equal(WindowsInputBridge.resolveAgentJar(directory), currentJar);

    fs.rmSync(path.join(directory, 'current-agent.txt'));
    const packagedJar = path.join(directory, 'remote-input-agent.jar');
    fs.writeFileSync(packagedJar, 'packaged');
    assert.equal(WindowsInputBridge.resolveAgentJar(directory), packagedJar);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('input timing contract separates touch creation from send start', () => {
  const input = normalizeInputMessage({ type: 'input', seq: 22, action: 'LOOK', phase: 'delta', dx: 3, dy: 4, clientEventMonoMs: 10, clientSendMonoMs: 12 });
  assert.equal(input.clientEventMonoMs, 10);
  assert.equal(input.clientSendMonoMs, 12);
  assert.throws(() => normalizeInputMessage({ type: 'input', seq: 23, action: 'LOOK', phase: 'delta', dx: 1, dy: 1, clientEventMonoMs: 13, clientSendMonoMs: 12 }), /clientEventMonoMs/);
});
