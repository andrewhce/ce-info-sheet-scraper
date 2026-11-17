'use strict';
// Starts the dashboard silently in the background on Windows so no console window stays open.
// If the dashboard is already running on its port, it just opens the browser tab to it.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { PATHS, loadConfig } = require('./lib/util');

const cfg = loadConfig();
const PORT = Number(process.env.PORT) || cfg.port || 4477;
const ADDR = `http://localhost:${PORT}`;

function checkHealth(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(res.statusCode === 200 && body.trim() === 'ok'));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

(async () => {
  if (await checkHealth(PORT)) {
    openBrowser(ADDR);
    process.exit(0);
  }

  fs.mkdirSync(PATHS.data, { recursive: true });
  const logFile = path.join(PATHS.data, 'dashboard.log');
  const logFd = fs.openSync(logFile, 'w');
  let exited = null;

  const child = spawn(process.execPath, [path.join(PATHS.src, 'server.js')], {
    cwd: PATHS.root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  child.on('exit', (code) => { exited = code == null ? 1 : code; });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await checkHealth(PORT)) process.exit(0);
    if (exited !== null) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  console.error('Could not start the School Info Sheet dashboard.');
  try {
    const text = fs.readFileSync(logFile, 'utf8').trim();
    if (text) console.error('\nDetails:\n' + text);
  } catch { /* ignore */ }
  process.exit(1);
})();
