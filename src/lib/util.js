'use strict';
// Shared helpers: paths, config, small text utilities.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');   // the school-info-scraper folder
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');   // on a server: the folder that survives restarts
const PATHS = {
  root: ROOT,
  src: path.join(ROOT, 'src'),
  public: path.join(ROOT, 'src', 'public'),
  data: DATA,
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
  const n = Number(process.env.CRAWL_PARALLEL_SITES);          // lets a small server read fewer websites at once
  if (n >= 1 && n <= 12) cfg.crawl.parallelSites = Math.floor(n);
  return cfg;
}

/** The workbook to read: the file chosen in the dashboard if there is one, else the path in config.json. */
function resolveWorkbook(cfg = loadConfig()) {
  return fs.existsSync(PATHS.workbook) ? PATHS.workbook : (cfg.workbookPath || null);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
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

module.exports = { PATHS, loadConfig, resolveWorkbook, readJson, writeJson, slug, alnum, squash, oneLine, clip, baseDomain };
