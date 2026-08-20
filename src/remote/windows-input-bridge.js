'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

function encode(value) { return Buffer.from(String(value), 'utf8').toString('base64url'); }
function decode(value) { return Buffer.from(String(value || ''), 'base64url').toString('utf8'); }

class WindowsInputBridge {
  constructor(target, {
    agentJar = process.env.REMOTE_PCL_INPUT_AGENT_JAR || process.env.REMOTE_PCL_INPUT_AGENT_DIR || path.join(__dirname, '..', '..', 'vendor', 'remote-input-agent'),
    onEvent = () => {},
  } = {}) {
    this.target = target;
    this.agentJar = WindowsInputBridge.resolveAgentJar(agentJar);
    this.onEvent = onEvent;
    this.pending = new Map();
    this.closed = false;
  }

  static resolveAgentJar(candidate) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return candidate;
    const manifestPath = path.join(candidate, 'current-agent.txt');
    if (fs.existsSync(manifestPath)) {
      const selectedName = fs.readFileSync(manifestPath, 'utf8').trim();
      if (!/^remote-input-agent-[0-9a-f]+\.jar$/i.test(selectedName)) {
        throw new Error(`TARGET_INPUT_AGENT_MANIFEST_INVALID: ${manifestPath}`);
      }
      const selectedJar = path.join(candidate, selectedName);
      if (!fs.existsSync(selectedJar) || !fs.statSync(selectedJar).isFile()) {
        throw new Error(`TARGET_INPUT_AGENT_MANIFEST_TARGET_MISSING: ${selectedJar}`);
      }
      return selectedJar;
    }
    const packagedJar = path.join(candidate, 'remote-input-agent.jar');
    if (fs.existsSync(packagedJar) && fs.statSync(packagedJar).isFile()) return packagedJar;
    const jars = fs.readdirSync(candidate).filter((name) => /^remote-input-agent-[0-9a-f]+\.jar$/i.test(name))
      .map((name) => ({ path: path.join(candidate, name), modified: fs.statSync(path.join(candidate, name)).mtimeMs }))
      .sort((left, right) => right.modified - left.modified);
    return jars[0]?.path || path.join(candidate, 'remote-input-agent.jar');
  }

  async start() {
    if (this.socket) return;
    if (!fs.existsSync(this.agentJar)) throw new Error(`TARGET_INPUT_AGENT_MISSING: ${this.agentJar}`);
    const executable = this.resolveJavaExecutable();
    this.token = crypto.randomBytes(24).toString('base64url');
    this.server = net.createServer((socket) => this.acceptAgent(socket));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off('listening', resolve); reject(error); };
      this.server.once('error', onError);
      this.server.once('listening', () => { this.server.off('error', onError); resolve(); });
      this.server.listen(0, '127.0.0.1');
    });
    const port = this.server.address().port;
    this.attacher = spawn(executable, [
      '--add-modules', 'jdk.attach', '-jar', this.agentJar,
      '--pid', String(this.target.pid), '--port', String(port), '--token', this.token,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.attacher.stdout.on('data', (chunk) => this.onEvent({ type: 'agent-loader', level: 'info', detail: chunk.toString().trim() }));
    this.attacher.stderr.on('data', (chunk) => this.onEvent({ type: 'agent-loader', level: 'error', detail: chunk.toString().trim() }));
    this.attacher.once('error', (error) => this.readyReject?.(error));
    this.attacher.once('close', (code) => {
      if (code !== 0 && !this.socket && !this.closed) this.readyReject?.(new Error(`Target input agent attach failed with code ${code}.`));
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Target input agent startup timed out.')), 10000);
      this.readyResolve = (value) => { clearTimeout(timer); resolve(value); };
      this.readyReject = (error) => { clearTimeout(timer); reject(error); };
    }).catch(async (error) => {
      await this.stop();
      throw error;
    });
    this.server.close();
    this.server = null;
  }

  resolveJavaExecutable() {
    const candidate = this.target.executablePath;
    if (!candidate) throw new Error('TARGET_JAVA_PATH_UNAVAILABLE');
    const java = path.join(path.dirname(candidate), 'java.exe');
    if (!fs.existsSync(java)) throw new Error(`TARGET_JAVA_ATTACH_RUNTIME_UNAVAILABLE: ${java}`);
    return java;
  }

  acceptAgent(socket) {
    if (this.socket || this.closed) { socket.destroy(); return; }
    socket.setNoDelay(true);
    const lines = readline.createInterface({ input: socket });
    let authenticated = false;
    lines.on('line', (line) => {
      const fields = line.split('\t');
      if (!authenticated) {
        if (fields[0] === 'ERROR' && fields[1] === this.token && Number(fields[2]) === Number(this.target.pid)) {
          const error = new Error(`TARGET_INPUT_AGENT_INITIALIZATION_FAILED: ${decode(fields[3])}`);
          this.readyReject?.(error);
          socket.destroy();
          return;
        }
        if (fields[0] !== 'READY' || fields[1] !== this.token || Number(fields[2]) !== Number(this.target.pid)) {
          socket.destroy(new Error('TARGET_INPUT_AGENT_IDENTITY_MISMATCH'));
          this.readyReject?.(new Error('Target input agent identity check failed.'));
          return;
        }
        authenticated = true;
        this.socket = socket;
        this.onEvent({ type: 'ready', ok: true, pid: this.target.pid, hwnd: String(this.target.hwnd), adapter: decode(fields[3]) });
        this.readyResolve?.({ ok: true });
        return;
      }
      this.handleAgentLine(fields);
    });
    socket.on('error', (error) => {
      if (!this.closed) this.onEvent({ type: 'bridge-log', level: 'error', detail: error.message });
    });
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      if (!this.closed) {
        const error = new Error('TARGET_INPUT_AGENT_DISCONNECTED');
        for (const { reject } of this.pending.values()) reject(error);
        this.pending.clear();
        this.onEvent({ type: 'bridge-exit', code: 1, error: error.message });
      }
    });
  }

  handleAgentLine(fields) {
    if (fields[0] !== 'ACK') {
      this.onEvent({ type: 'bridge-log', level: 'error', detail: `Invalid target agent response: ${fields.join('\t')}` });
      return;
    }
    const seq = Number(fields[1]);
    const ok = fields[2] === 'OK';
    const message = {
      type: 'input-ack', ok, seq,
      appliedTicks: fields[3],
      screenOpen: fields[4] === '1',
      screenClass: ok ? decode(fields[5]) : '',
      guiWidth: ok ? Number(fields[6]) || 0 : 0,
      guiHeight: ok ? Number(fields[7]) || 0 : 0,
      error: ok ? undefined : decode(fields[5]),
    };
    this.onEvent(message);
    const pending = this.pending.get(seq);
    if (!pending) return;
    this.pending.delete(seq);
    if (ok) pending.resolve(message); else pending.reject(new Error(message.error || 'Target input agent rejected the command.'));
  }

  commandLine(command) {
    const seq = Number(command.seq) >>> 0;
    if (command.kind === 'key') return `${seq}\tkey\t${command.phase}\t${Number(command.virtualKey)}`;
    if (command.kind === 'mouseButton') return `${seq}\tmouseButton\t${command.phase}\t${command.button}`;
    if (command.kind === 'mouseMove') return `${seq}\tmouseMove\t${Number(command.dx)}\t${Number(command.dy)}`;
    if (command.kind === 'pointerAbsolute') return `${seq}\tpointerAbsolute\t${command.phase}\t${Number(command.x)}\t${Number(command.y)}`;
    if (command.kind === 'text') return `${seq}\ttext\t${encode(command.text)}`;
    if (command.kind === 'releaseAll') return `${seq}\treleaseAll`;
    if (command.kind === 'queryState') return `${seq}\tqueryState`;
    throw new Error(`UNSUPPORTED_BRIDGE_COMMAND:${command.kind}`);
  }

  send(command) {
    if (!this.socket || this.closed) return Promise.reject(new Error('Target input agent is not connected.'));
    let line;
    try { line = this.commandLine(command); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const seq = Number(command.seq) >>> 0;
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error('Target input acknowledgement timed out.'));
      }, 1800);
      timer.unref();
      this.pending.set(seq, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.write(`${line}\n`);
    });
  }

  async stop() {
    if (this.closed) return;
    if (this.socket) {
      try { await this.send({ seq: 0xffffffff, kind: 'releaseAll' }); } catch {}
    }
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error('Target input bridge stopped.'));
    this.pending.clear();
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve)).catch(() => {});
      this.server = null;
    }
    if (this.attacher && !this.attacher.killed) this.attacher.kill();
  }
}

module.exports = { WindowsInputBridge };
