'use strict';
// A plain-language checklist of what is ready and what still needs doing.
// Shown on the dashboard's Start here page and by Check Setup.cmd.
//   node src/setup-check.js
const fs = require('fs');
const path = require('path');
const { PATHS, loadConfig, readJson } = require('./lib/util');

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return '';
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' minutes ago';
  if (s < 86400) return Math.round(s / 3600) + ' hours ago';
  return Math.round(s / 86400) + ' days ago';
}

function folderMb(dir) {
  let bytes = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else { try { bytes += fs.statSync(p).size; } catch { /* skip */ } }
    }
  };
  walk(dir);
  return bytes / 1048576;
}

function runningScrape() {
  const l = readJson(path.join(PATHS.data, 'run.lock'));
  if (!l) return null;
  try { process.kill(l.pid, 0); } catch { return null; }
  return Date.now() - l.startedAt < 36 * 3600e3 ? l : null;
}

/**
 * Each item: { id, status, title, detail, action }
 *   status: 'ok' (ready), 'todo' (needs doing), 'optional' (not needed to start), 'info'
 *   action: a short hint of what to do next, or null
 */
function checkSetup() {
  const items = [];
  const add = (id, status, title, detail, action) => items.push({ id, status, title, detail, action: action || null });

  // 1. Node.js
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 18 ? 'ok' : 'todo', 'Node.js is installed', major >= 18 ? `Version ${process.versions.node}.` : `Version ${process.versions.node} is too old.`,
    major >= 18 ? null : 'Install the current LTS version from nodejs.org, then open the dashboard again.');

  // 2. Libraries
  const missing = ['cheerio', 'exceljs', 'pdf-parse'].filter((m) => { try { require.resolve(m); return false; } catch { return true; } });
  add('libs', missing.length ? 'todo' : 'ok', 'Program libraries are installed', missing.length ? `Missing: ${missing.join(', ')}.` : 'All three are installed.',
    missing.length ? 'Double-click Start Dashboard.cmd (it installs them), or run: npm install' : null);

  // 3. Workbook
  const list = readJson(PATHS.schools), template = readJson(PATHS.template);
  if (list && template) {
    const fields = template.rows.filter((r) => r.kind === 'field').length;
    const file = list.workbook ? path.basename(list.workbook) : 'the workbook';
    let newer = false;
    try { newer = list.workbook && fs.statSync(list.workbook).mtimeMs > Date.parse(list.importedAt) + 60000; } catch { /* the file moved: nothing to compare */ }
    add('workbook', newer ? 'todo' : 'ok', 'Your School Information Sheet is loaded',
      `${list.schools.length} schools and ${fields} template rows, from "${file}", loaded ${ago(list.importedAt)}.` + (newer ? ' The file has changed since then.' : ''),
      newer ? 'Choose the file again on the Start here page to pick up the changes.' : null);
  } else {
    add('workbook', 'todo', 'Load your School Information Sheet', 'No workbook has been loaded yet, so there is no school list.',
      'On the Start here page choose your sheet as an Excel (.xlsx) file. In Google Sheets: File, Download, Microsoft Excel.');
  }

  // 4. Scrape results
  let scraped = 0, bad = 0;
  try {
    for (const f of fs.readdirSync(PATHS.resultsDir)) {
      const r = readJson(path.join(PATHS.resultsDir, f));
      if (r && r.status === 'ok') scraped++; else if (r) bad++;
    }
  } catch { /* no results folder yet */ }
  const total = list ? list.schools.length : 0;
  const running = runningScrape();
  if (running) add('scrape', 'info', 'A scrape is running now', `${running.label}: ${running.done || 0} of ${running.schools} schools done.`, 'Leave this window open. You can follow it on the Run scraper page.');
  else if (scraped) add('scrape', 'ok', 'Schools have been scraped', `${scraped} of ${total || '?'} schools read${bad ? `, ${bad} could not be read` : ''}.`, scraped < total ? 'Run scraper, "Not scraped yet", reads the rest.' : null);
  else add('scrape', list ? 'todo' : 'info', 'Scrape some schools', list ? 'None of the schools have been scraped yet.' : 'Load your sheet first.', list ? 'On the Run scraper page press Tier 1 (about an hour for 65 schools).' : null);

  // 5. Google Sheet export (optional). The file route needs nothing saved on this computer; the web app route saves an address.
  const cfgFile = readJson(path.join(PATHS.data, 'export-config.json'));
  add('google', 'optional', 'Send results to a Google Sheet copy',
    'Optional. On a school page (or Start here) press "Download file for Google Sheet", then load it from the School Info menu inside your sheet copy.' + (cfgFile && cfgFile.url ? ' A one-click web app address is also saved on this computer.' : ''),
    'One-time setup of the menu is in docs/GOOGLE-SHEET-EXPORT.md.');

  // 5b. The Ask page's AI assistant (optional)
  try {
    const { createSettings } = require('./agent/settings');
    const v = createSettings(path.join(PATHS.data, 'agent-settings.json')).publicView();
    add('ask', v.configured ? 'ok' : 'optional', 'Ask page: the AI assistant',
      v.configured ? `Connected (${v.provider === 'groq' ? 'Groq, the test model' : 'Claude'}).` : 'Optional. Ask questions about the school data in plain English. It needs an API key.',
      v.configured ? null : 'On the Ask page, open "Connect the AI" and paste a key. Details are in docs/ASK.md.');
  } catch { /* an optional extra must never make the checklist fail */ }

  // 6. Saved files
  const mb = folderMb(PATHS.cacheDir);
  add('cache', 'info', 'Saved web pages', `${mb < 1 ? 'Under 1' : Math.round(mb)} MB in data/cache. They only save time on the next scrape, so the folder is safe to delete.`);

  return items;
}

module.exports = { checkSetup };

if (require.main === module) {
  const mark = { ok: '[ OK ]', todo: '[TODO]', optional: '[ -- ]', info: '[ i  ]' };
  console.log('\nSchool Info Sheet: setup check\n');
  const items = checkSetup();
  for (const i of items) {
    console.log(`${mark[i.status]} ${i.title}\n       ${i.detail}`);
    if (i.action && i.status !== 'ok') console.log(`       -> ${i.action}`);
  }
  const todo = items.filter((i) => i.status === 'todo');
  console.log(todo.length ? `\n${todo.length} thing${todo.length === 1 ? '' : 's'} to do. Start with: ${todo[0].title}.` : '\nEverything needed is ready. Double-click Start Dashboard.cmd to open the dashboard.');
  console.log('');
}
