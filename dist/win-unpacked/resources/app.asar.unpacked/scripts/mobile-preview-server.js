'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', 'mobile');
const portArg = process.argv.find((value) => /^--port=\d+$/.test(value));
const hostArg = process.argv.find((value) => /^--host=[\w.:-]+$/.test(value));
const port = portArg ? Number(portArg.split('=')[1]) : 4173;
const host = hostArg ? hostArg.slice('--host='.length) : '0.0.0.0';
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
]);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (error, data) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }
    response.writeHead(200, {
      'Content-Type': types.get(path.extname(file)) || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'none'",
    });
    response.end(data);
  });
});

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((item) =>
    item && item.family === 'IPv4' && !item.internal && !item.address.startsWith('198.18.'),
  ).map((item) => item.address);
}

server.on('error', (error) => {
  console.error(`Mobile preview server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Computer browser: http://127.0.0.1:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    const addresses = [...new Set(lanAddresses())];
    if (addresses.length) {
      console.log('Phone browser (same Wi-Fi/LAN):');
      for (const address of addresses) console.log(`  http://${address}:${port}`);
    } else {
      console.log('No usable LAN IPv4 address was detected.');
    }
  } else {
    console.log(`Listening on: http://${host}:${port}`);
  }
  console.log('UI preview only: no device discovery, video transport, or remote input is active.');
});
