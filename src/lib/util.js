'use strict';
// Shared helpers: paths, config, small text utilities.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');   // the school-info-scraper folder

/**
 * Picks where saved workbooks, scrape results and settings live:
 *  1. DATA_DIR env var (servers, Docker, tests)
 *  2. %LocalAppData%\SchoolInfoSheet\data on Windows portable builds so unzipping an update keeps user data
 *     (unless this folder's own data/ already contains a workbook or imported school list)
 *  3. ./data inside the project folder
 */
function resolveDataDir(root = ROOT, env = process.env, platform = process.platform) {
  if (env.DATA_DIR) return path.resolve(env.DATA_DIR);
  const localData = path.join(root, 'data');
  if (platform === 'win32' && env.LOCALAPPDATA && fs.existsSync(path.join(root, '.portable-build'))) {
    const hasLocal = fs.existsSync(path.join(localData, 'schools.json')) || fs.existsSync(path.join(localData, 'workbook.xlsx'));
    if (!hasLocal) return path.join(env.LOCALAPPDATA, 'SchoolInfoSheet', 'data');
  }
  return localData;
}

const DATA = resolveDataDir();
const PATHS = {
  root: ROOT,
  src: path.join(ROOT, 'src'),
  public: path.join(ROOT, 'src', 'public'),
  data: DATA,
  isPortable: fs.existsSync(path.join(ROOT, '.portable-build')),
  config: path.join(ROOT, 'config.json'),
  workbook: path.join(DATA, 'workbook.xlsx'),      // the sheet chosen in the dashboard
  template: path.join(DATA, 'template.json'),
  schools: path.join(DATA, 'schools.json'),
  sheetDir: path.join(DATA, 'sheet'),
  resultsDir: path.join(DATA, 'results'),
  cacheDir: path.join(DATA, 'cache'),
};

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(PATHS.config, 'utf8'));
  const n = Number(process.env.CRAWL_PARALLEL_SITES);          // lets a small server or fast connection tune website concurrency
  if (n >= 1 && n <= 24) cfg.crawl.parallelSites = Math.floor(n);
  return cfg;
}

/** The workbook to read: the file chosen in the dashboard if there is one, else the path in config.json. */
function resolveWorkbook(cfg = loadConfig()) {
  return fs.existsSync(PATHS.workbook) ? PATHS.workbook : (cfg.workbookPath || null);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  const ws = opts && opts.mode ? { encoding: 'utf8', mode: opts.mode } : 'utf8';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), ws);
  fs.renameSync(tmp, file);
}

/** "St. Paul's School" -> "st-pauls-school" */
function slug(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/['’`]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Letters and digits only, lower case. Used to compare names loosely. */
function alnum(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function squash(s) {
  return String(s == null ? '' : s).replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function oneLine(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

/** example.com for www.example.com, admissions.example.com, example.co.uk etc. */
function baseDomain(host) {
  const parts = String(host).toLowerCase().replace(/^www\./, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const two = parts.slice(-2).join('.');
  if (/^(co|ac|org|gov|sch|edu|com|net)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join('.');
  return two;
}

/** Scrub API keys, Slack webhooks, bearer tokens, and secret query params before logging or displaying errors. */
function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]')
    .replace(/\bgsk_[A-Za-z0-9_-]{8,}/g, 'gsk_[REDACTED]')
    .replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, 'AIza[REDACTED]')
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, 'https://hooks.slack.com/services/[REDACTED]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|key|secret|api_key)=)[^&\s'"]+/gi, '$1[REDACTED]');
}

module.exports = { PATHS, resolveDataDir, loadConfig, resolveWorkbook, readJson, writeJson, slug, alnum, squash, oneLine, clip, baseDomain, redactSecrets };
