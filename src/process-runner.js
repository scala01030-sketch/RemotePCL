'use strict';

const { spawn } = require('node:child_process');

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

function collectProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

module.exports = { spawnProcess, collectProcess };
