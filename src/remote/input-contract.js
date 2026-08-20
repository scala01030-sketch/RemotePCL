'use strict';

const ControlAction = Object.freeze({
  FORWARD: 'FORWARD', BACK: 'BACK', LEFT: 'LEFT', RIGHT: 'RIGHT',
  JUMP: 'JUMP', SPRINT: 'SPRINT', SNEAK: 'SNEAK',
  ATTACK: 'ATTACK', USE: 'USE', PICK_BLOCK: 'PICK_BLOCK', LOOK: 'LOOK',
  GUI_POINTER: 'GUI_POINTER',
  ESC: 'ESC', INVENTORY: 'INVENTORY', CHAT: 'CHAT', CHAT_TEXT: 'CHAT_TEXT', DROP: 'DROP', PERSPECTIVE: 'PERSPECTIVE',
  SLOT_1: 'SLOT_1', SLOT_2: 'SLOT_2', SLOT_3: 'SLOT_3', SLOT_4: 'SLOT_4', SLOT_5: 'SLOT_5',
  SLOT_6: 'SLOT_6', SLOT_7: 'SLOT_7', SLOT_8: 'SLOT_8', SLOT_9: 'SLOT_9',
  RELEASE_ALL: 'RELEASE_ALL',
});

// Java Edition default bindings presented through a Bedrock-style touch layout.
const BEDROCK_TO_JAVA = Object.freeze({
  FORWARD: { kind: 'key', virtualKey: 0x57, mode: 'hold', label: '前进 / W' },
  BACK: { kind: 'key', virtualKey: 0x53, mode: 'hold', label: '后退 / S' },
  LEFT: { kind: 'key', virtualKey: 0x41, mode: 'hold', label: '左移 / A' },
  RIGHT: { kind: 'key', virtualKey: 0x44, mode: 'hold', label: '右移 / D' },
  JUMP: { kind: 'key', virtualKey: 0x20, mode: 'hold', label: '跳跃 / Space' },
  SPRINT: { kind: 'key', virtualKey: 0xA2, mode: 'hold', label: '疾跑 / Left Ctrl' },
  SNEAK: { kind: 'key', virtualKey: 0xA0, mode: 'hold', label: '潜行 / Left Shift' },
  ATTACK: { kind: 'mouseButton', button: 'left', mode: 'hold', label: '攻击/破坏 / 左键' },
  USE: { kind: 'mouseButton', button: 'right', mode: 'hold', label: '使用/放置 / 右键' },
  PICK_BLOCK: { kind: 'mouseButton', button: 'middle', mode: 'tap', label: '选取方块 / 中键' },
  LOOK: { kind: 'mouseMove', mode: 'delta', label: '滑动视角 / 相对鼠标' },
  GUI_POINTER: { kind: 'pointerAbsolute', mode: 'pointer', label: '菜单/背包直接点按' },
  ESC: { kind: 'key', virtualKey: 0x1B, mode: 'tap', label: '菜单 / Esc' },
  INVENTORY: { kind: 'key', virtualKey: 0x45, mode: 'tap', label: '背包 / E' },
  CHAT: { kind: 'key', virtualKey: 0x54, mode: 'tap', label: '聊天 / T' },
  CHAT_TEXT: { kind: 'text', mode: 'submit', label: '发送聊天文字 / Unicode + Enter' },
  DROP: { kind: 'key', virtualKey: 0x51, mode: 'tap', label: '丢弃 / Q' },
  PERSPECTIVE: { kind: 'key', virtualKey: 0x74, mode: 'tap', label: '视角 / F5' },
  SLOT_1: { kind: 'key', virtualKey: 0x31, mode: 'tap', label: '快捷栏 1' },
  SLOT_2: { kind: 'key', virtualKey: 0x32, mode: 'tap', label: '快捷栏 2' },
  SLOT_3: { kind: 'key', virtualKey: 0x33, mode: 'tap', label: '快捷栏 3' },
  SLOT_4: { kind: 'key', virtualKey: 0x34, mode: 'tap', label: '快捷栏 4' },
  SLOT_5: { kind: 'key', virtualKey: 0x35, mode: 'tap', label: '快捷栏 5' },
  SLOT_6: { kind: 'key', virtualKey: 0x36, mode: 'tap', label: '快捷栏 6' },
  SLOT_7: { kind: 'key', virtualKey: 0x37, mode: 'tap', label: '快捷栏 7' },
  SLOT_8: { kind: 'key', virtualKey: 0x38, mode: 'tap', label: '快捷栏 8' },
  SLOT_9: { kind: 'key', virtualKey: 0x39, mode: 'tap', label: '快捷栏 9' },
  RELEASE_ALL: { kind: 'releaseAll', mode: 'tap', label: '释放全部远程按键' },
});

function finiteNumber(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new TypeError(`${name} must be between ${min} and ${max}.`);
  return parsed;
}

function normalizeInputMessage(message) {
  if (!message || message.type !== 'input') throw new TypeError('Expected an input message.');
  const seq = finiteNumber(message.seq, 'seq', 0, 0xffffffff);
  if (!Number.isInteger(seq)) throw new TypeError('seq must be an integer.');
  const action = String(message.action || '');
  const mapping = BEDROCK_TO_JAVA[action];
  if (!mapping) throw new TypeError(`Unsupported control action: ${action}`);
  const clientSendMonoMs = finiteNumber(message.clientSendMonoMs ?? message.clientMonoMs, 'clientSendMonoMs', 0, Number.MAX_SAFE_INTEGER);
  const clientEventMonoMs = finiteNumber(message.clientEventMonoMs ?? clientSendMonoMs, 'clientEventMonoMs', 0, clientSendMonoMs);
  const timing = { clientMonoMs: clientSendMonoMs, clientEventMonoMs, clientSendMonoMs };

  if (mapping.kind === 'mouseMove') {
    return Object.freeze({ type: 'input', seq, action, phase: 'delta', dx: finiteNumber(message.dx, 'dx', -400, 400), dy: finiteNumber(message.dy, 'dy', -400, 400), ...timing });
  }
  if (mapping.kind === 'pointerAbsolute') {
    const phase = String(message.phase || '');
    if (!new Set(['down', 'move', 'up', 'tap']).has(phase)) throw new TypeError('GUI_POINTER requires phase down, move, up, or tap.');
    return Object.freeze({ type: 'input', seq, action, phase, x: finiteNumber(message.x, 'x', 0, 1), y: finiteNumber(message.y, 'y', 0, 1), ...timing });
  }
  if (mapping.kind === 'text') {
    const text = String(message.text || '');
    if (!text || text.length > 256 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new TypeError('CHAT_TEXT requires 1 to 256 printable characters.');
    if (message.phase !== 'submit') throw new TypeError('CHAT_TEXT requires phase submit.');
    return Object.freeze({ type: 'input', seq, action, phase: 'submit', text, ...timing });
  }
  if (mapping.kind === 'mouseButton' && message.phase === 'tap') {
    return Object.freeze({ type: 'input', seq, action, phase: 'tap', ...timing });
  }
  const allowed = mapping.mode === 'hold' ? new Set(['down', 'up']) : new Set(['tap']);
  const phase = String(message.phase || (mapping.mode === 'tap' ? 'tap' : ''));
  if (!allowed.has(phase)) throw new TypeError(`${action} requires phase ${[...allowed].join(' or ')}.`);
  return Object.freeze({ type: 'input', seq, action, phase, ...timing });
}

function toBridgeCommand(input) {
  const mapping = BEDROCK_TO_JAVA[input.action];
  if (mapping.kind === 'mouseMove') return { seq: input.seq, kind: 'mouseMove', dx: Math.round(input.dx), dy: Math.round(input.dy) };
  if (mapping.kind === 'pointerAbsolute') return { seq: input.seq, kind: 'pointerAbsolute', phase: input.phase, x: input.x, y: input.y };
  if (mapping.kind === 'text') return { seq: input.seq, kind: 'text', text: input.text };
  if (mapping.kind === 'releaseAll') return { seq: input.seq, kind: 'releaseAll' };
  if (mapping.kind === 'key') return { seq: input.seq, kind: 'key', virtualKey: mapping.virtualKey, phase: input.phase };
  return { seq: input.seq, kind: 'mouseButton', button: mapping.button, phase: input.phase };
}

module.exports = { ControlAction, BEDROCK_TO_JAVA, normalizeInputMessage, toBridgeCommand };
