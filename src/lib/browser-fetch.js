'use strict';
// Optional lightweight headless Chromium/Edge DOM renderer for static-empty SPA school sites.
// Uses an already-installed Chrome/Edge binary with a disposable empty profile, never bypasses
// robots.txt or bot challenges, and re-enforces assertPublicUrl before launching.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const CANDIDATES = process.platform === 'win32'
  ? [
    process.env.HEADLESS_BROWSER_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ]
  : process.platform === 'darwin'
    ? [
      process.env.HEADLESS_BROWSER_PATH,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    : [
      process.env.HEADLESS_BROWSER_PATH,
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
    ];

let cachedBrowser;
function findBrowser() {
  if (cachedBrowser !== undefined) return cachedBrowser;
  for (const p of CANDIDATES) {
    if (!p) continue;
    try {
      if (fs.statSync(p).isFile()) { cachedBrowser = p; return cachedBrowser; }
    } catch { /* try next */ }
  }
  cachedBrowser = null;
  return null;
}

/**
 * Renders a validated public HTTP(S) page using headless Edge/Chrome and returns its DOM HTML string.
 * Returns null cleanly if no local browser is installed or rendering fails/times out.
 */
async function fetchRenderedHtml(url, { timeoutMs = 16000, budgetMs = 4500, assertPublic } = {}) {
  const bin = findBrowser();
  if (!bin) return null;
  if (typeof assertPublic === 'function') await assertPublic(url);

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sis-headless-'));
  try {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      ...(process.env.HEADLESS_NO_SANDBOX === '1' ? ['--no-sandbox', '--disable-setuid-sandbox'] : []),
      `--user-data-dir=${profileDir}`,
      `--virtual-time-budget=${Math.max(1000, Math.min(12000, Number(budgetMs) || 5000))}`,
      '--dump-dom',
      url,
    ];
    const { stdout } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return typeof stdout === 'string' && stdout.trim().length > 0 ? stdout : null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

module.exports = { findBrowser, fetchRenderedHtml };
