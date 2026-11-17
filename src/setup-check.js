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
  add('node', major >= 18 ? 'ok' : 'todo', 'App runtime is ready', major >= 18 ? `Running smoothly (version ${process.versions.node}).` : `Runtime version ${process.versions.node} needs an update.`,
    major >= 18 ? null : 'Install the latest LTS version from nodejs.org, then open the dashboard again.');

  // 2. Libraries
  const missing = ['cheerio', 'exceljs', 'pdf-parse'].filter((m) => { try { require.resolve(m); return false; } catch { return true; } });
  add('libs', missing.length ? 'todo' : 'ok', 'Required helper tools are installed', missing.length ? `Missing helper packages.` : 'Ready to read Excel sheets, web pages and PDFs.',
    missing.length ? 'Double-click Start Dashboard.cmd while connected to the internet to finish installing.' : null);

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
  else if (scraped) add('scrape', 'ok', 'Schools have been scraped', `${scraped} of ${total || '?'} schools read${bad ? `, ${bad} could not be read` : ''}.`, scraped < total ? 'On Run scraper choose "Not checked yet", then press Start scraping to read the rest.' : null);
  else add('scrape', list ? 'todo' : 'info', 'Scrape some schools', list ? 'None of the schools have been scraped yet.' : 'Load your sheet first.', list ? 'On the Run scraper page choose Tier 1, then press Start scraping.' : null);

  // 5. Google Sheet export (optional). The file route needs nothing saved on this computer; the web app route saves an address.
  // A saved address is not proof of a connection, so this reports what the last call to it actually did.
  const sheetCfg = require('./lib/sheet-export').publicConfig();
  const googleBase = 'Optional. You can always download a plain Excel (.xlsx) or CSV spreadsheet with one click. For color-coded updates straight inside Google Sheets, use the setup guide under Advanced below.';
  if (sheetCfg.health === 'working') {
    add('google', 'ok', 'Optional: Direct Google Sheet menu', `${googleBase} One-click send works (last checked ${ago(sheetCfg.lastCheckAt)}).`, null);
  } else if (sheetCfg.health === 'untested') {
    add('google', 'optional', 'Optional: Direct Google Sheet menu', `${googleBase} A one-click address is saved but has not been tested, so it may not work.`,
      'In the Advanced panel on this page press "Test the connection".');
  } else if (sheetCfg.health === 'failing') {
    const why = /only open to your organization/i.test(sheetCfg.lastError || '')
      ? 'Google asked this computer to sign in, which it cannot do for a web app that is only open to your organization.'
      : (sheetCfg.lastError || 'Google did not answer correctly.');
    add('google', 'optional', 'Optional: Direct Google Sheet menu', `${googleBase} The saved one-click address does NOT work (${ago(sheetCfg.lastCheckAt)}): ${why}`,
      'Use "Download file for Google Sheet" instead, or press "Remove saved address" in the Advanced panel.');
  } else {
    add('google', 'optional', 'Optional: Direct Google Sheet menu', googleBase, null);
  }

  // 5b. The Ask page's AI assistant (optional)
  try {
    const { createSettings } = require('./agent/settings');
    const v = createSettings(path.join(PATHS.data, 'agent-settings.json')).publicView();
    add('ask', v.configured ? 'ok' : 'optional', 'Optional: AI assistant (Ask tab)',
      v.configured ? `Connected (${v.provider === 'groq' ? 'Groq test model' : 'Claude'}).` : 'Optional. Lets you ask questions in plain English once an admin connects an API key.',
      null);
  } catch { /* an optional extra must never make the checklist fail */ }

  // 5c. Headless browser renderer (optional)
  try {
    const { findBrowser } = require('./lib/browser-fetch');
    const browser = findBrowser();
    add('browser', browser ? 'ok' : 'optional', 'Optional: JavaScript page renderer',
      browser ? `Using ${path.basename(browser)} automatically if a school page needs JavaScript.` : 'Install Chrome or Edge to read JavaScript-heavy school websites automatically.',
      null);
  } catch { /* optional */ }

  // 6. Saved files
  const mb = folderMb(PATHS.cacheDir);
  add('cache', 'info', 'Saved data & offline web cache', `Saved web pages use ${mb < 1 ? 'under 1' : Math.round(mb)} MB to speed up repeat runs. Your sheet and results are safely stored in ${PATHS.data}.`);

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
