'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { collectProcess } = require('./process-runner');

const probeScript = process.env.REMOTE_PCL_PROBE_SCRIPT || path.join(__dirname, '..', 'scripts', 'window-probe.ps1');

async function enumerateWindows(includeAll = false) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScript, '-Action', 'List'];
  if (includeAll) args.push('-IncludeAll');
  const result = await collectProcess('powershell.exe', args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || 'Window enumeration failed.');
  if (!result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function printCandidates(candidates) {
  console.log('\nDetected candidate windows:\n');
  candidates.forEach((w, index) => {
    console.log(`[${index + 1}]`);
    console.log(`PID:     ${w.pid}`);
    console.log(`HWND:    ${w.hwndHex}`);
    console.log(`Process: ${w.processName}`);
    console.log(`Title:   ${w.title}`);
    console.log(`Client:  ${w.width}x${w.height}`);
    if (w.executablePath) console.log(`Path:    ${w.executablePath}`);
    console.log('');
  });
}

async function chooseWindow(candidates, requestedPid, requestedHwnd) {
  let matches = candidates;
  if (requestedPid !== undefined) matches = matches.filter((w) => w.pid === requestedPid);
  if (requestedHwnd !== undefined) {
    const normalized = BigInt(requestedHwnd).toString();
    matches = matches.filter((w) => BigInt(w.hwnd).toString() === normalized);
  }
  if (requestedPid !== undefined || requestedHwnd !== undefined) {
    if (matches.length !== 1) throw new Error(`Target selector matched ${matches.length} windows; expected exactly one.`);
    return matches[0];
  }

  printCandidates(candidates);
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('Select capture target: ');
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      throw new Error('Invalid selection. No capture was started.');
    }
    return candidates[index];
  } finally {
    rl.close();
  }
}

module.exports = { enumerateWindows, chooseWindow, printCandidates, probeScript };
