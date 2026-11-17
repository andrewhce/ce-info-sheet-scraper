'use strict';
// Manages an optional local Windows Task Scheduler background job so scheduled scrapes
// can still run automatically even when the dashboard window has been closed.
// Uses execFile (no shell interpolation) and points at the active runtime + scrape.js --run-due.
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { PATHS } = require('./util');

const execFileAsync = promisify(execFile);
const TASK_NAME = 'SchoolInfoSheet-AutoCheck';

function supported() {
  return process.platform === 'win32';
}

async function getStatus() {
  if (!supported()) return { supported: false, installed: false, taskName: TASK_NAME };
  try {
    const { stdout } = await execFileAsync('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST'], { windowsHide: true, timeout: 5000 });
    return {
      supported: true,
      installed: true,
      taskName: TASK_NAME,
      status: (/^Status:\s*(.+)$/im.exec(stdout) || [])[1] || 'Ready',
      nextRun: (/^Next Run Time:\s*(.+)$/im.exec(stdout) || [])[1] || null,
    };
  } catch {
    return { supported: true, installed: false, taskName: TASK_NAME };
  }
}

async function install() {
  if (!supported()) throw new Error('Background task setup is only available on Windows.');
  const script = path.join(PATHS.src, 'scrape.js');
  const cmd = `"${process.execPath}" "${script}" --run-due`;
  // Hourly wake check; scrape.js --run-due exits immediately when no schedule is due.
  await execFileAsync('schtasks.exe', [
    '/Create', '/SC', 'HOURLY', '/TN', TASK_NAME, '/TR', cmd, '/F',
  ], { windowsHide: true, timeout: 10000 });
  return getStatus();
}

async function remove() {
  if (!supported()) return { supported: false, installed: false, taskName: TASK_NAME };
  try {
    await execFileAsync('schtasks.exe', ['/Delete', '/TN', TASK_NAME, '/F'], { windowsHide: true, timeout: 10000 });
  } catch { /* ignore if already absent */ }
  return getStatus();
}

module.exports = { TASK_NAME, supported, getStatus, install, remove };
