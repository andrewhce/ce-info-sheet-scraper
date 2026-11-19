'use strict';
// Reads the saved data (imported workbook, scrape results) and shapes it for the dashboard.
// Used by the live dashboard (server.js) and by the read-only export (build-static.js),
// so both always show exactly the same thing.
const fs = require('fs');
const path = require('path');
const { PATHS, readJson } = require('./util');
const { compareField, sheetCells } = require('./compare');
const trust = require('./trust');

// Every file shown on the Script page, grouped by what it is for: [group, [[path, what it does], ...]]
const CODE = [
  ['Start the program', [
    ['src/server.js', 'The dashboard. Opens in your browser and runs the scraper when you press a button.'],
    ['src/launch.js', 'Starts the dashboard quietly in the background on Windows without keeping a terminal window open.'],
    ['src/scrape.js', 'The scraper. Picks the schools, reads each website once, applies the rules, saves the results.'],
    ['src/import-workbook.js', 'Reads your Excel sheet: the template, the PSTP Schools list and the existing school tabs.'],
    ['src/lib/school-list.js', 'Adds one school by hand (and removes it again) without loading the whole sheet; schools added this way survive a new sheet.'],
    ['src/setup-check.js', 'The checklist on the Start here page, also run by Check Setup.cmd.'],
    ['src/lib/xlsx-lean.js', 'Loads the big Excel sheet with a fraction of the memory, by cutting each tab down to the part that is read.'],
    ['src/lib/scheduler.js', 'Built-in auto-scraper schedule stored in data/schedule.json and triggered automatically by the server.'],
    ['src/lib/windows-task.js', 'Optional local Windows Task Scheduler integration so scheduled checks run even when closed.'],
    ['src/lib/changes.js', 'Compares new website findings against the previous check so updated schools are highlighted automatically.'],
    ['src/lib/slack.js', 'Posts scrape summaries and school website change alerts to a Slack Incoming Webhook.'],
  ]],
  ['Hand a copy to a teammate', [
    ['tools/make-portable.js', 'Builds a folder with Node.js inside that a teammate can unzip and double-click: nothing to install.'],
    ['src/lib/results-package.js', 'Saves your results to one file and adds a teammate\'s file, so the same schools are not scraped twice.'],
  ]],
  ['Run online for the team', [
    ['src/auth.js', 'Company Google sign-in, sessions, and the settings that let the program run on a server. Refuses to run open to the network without it.'],
    ['Dockerfile', 'Packages the program for a hosting service.'],
    ['docker-entrypoint.sh', 'Starts the packaged program and fixes the owner of the saved-data volume.'],
  ]],
  ['Reading school websites', [
    ['src/lib/crawl.js', 'Chooses which pages of a school website to read (admissions, tuition, at a glance, visit ...).'],
    ['src/lib/fetcher.js', 'Downloads pages politely: honest identity, robots.txt, pauses, cache. Reports blocks, never works around them.'],
    ['src/lib/browser-fetch.js', 'Optional local Chrome/Edge renderer for empty JavaScript-only pages (obeys robots.txt and never bypasses blocks).'],
    ['src/lib/html.js', 'Turns a page or PDF into plain text blocks, keeping headings, lists and tables.'],
    ['src/lib/textindex.js', 'Builds the facts, sentences and sections that the rules search.'],
    ['src/lib/manual-pages.js', 'Pages saved by hand from a school website that blocks automatic reading; read with the same rules.'],
    ['src/lib/sources.js', 'Pages saved by hand from Ravenna, Niche and the review sites: checks them, keeps them, and fills only the questions the website left empty, in that order.'],
    ['src/lib/source-readers.js', 'Reads the labelled facts (ratio, tuition, grades ...) from those saved pages, with the line they came from.'],
  ]],
  ['Deciding what each row says', [
    ['src/lib/rules.js', 'The field rules: one rule per row of the Master Template.'],
    ['src/lib/template.js', 'Maps the Master Template row labels to field keys.'],
    ['src/lib/trust.js', 'Trust score: gives each key fact a 1 to 99 score from the evidence on the page, with the reasons, and learns from the spot-checks.'],
    ['src/lib/review-queue.js', 'Review queue: lists only the key facts the trust score is unsure about, most doubtful first.'],
    ['src/lib/verification.js', 'Spot-checks and accuracy: saves a person\'s Right / Wrong checks, draws a sample, and works out how often the scraper is right (with a 95% range).'],
    ['src/lib/compare.js', 'Compares what the sheet says with what the scrape found.'],
  ]],
  ['The dashboard pages', [
    ['src/public/index.html', 'The page frame and the menu.'],
    ['src/public/app.js', 'Everything you see and click in the dashboard.'],
    ['src/public/styles.css', 'Colours, spacing and layout.'],
    ['src/lib/dashboard-data.js', 'Shapes the saved data for the dashboard pages.'],
    ['src/lib/util.js', 'Small shared helpers and folder locations.'],
  ]],
  ['Ask page: the AI assistant (reads only)', [
    ['src/agent/index.js', 'The assistant behind the Ask page: conversations, settings, memory, and persisted sessions.'],
    ['src/agent/agent.js', 'One question: streams AI responses, runs read-only tools, hands results back, and stops at limits.'],
    ['src/agent/tools.js', 'Nine read-only and button-proposal tools (school lookup, cached page search, schedule check, exports).'],
    ['src/agent/providers.js', 'The two AI services it can use: Claude (streaming + caching) and Groq (for trying the page out).'],
    ['src/agent/prompt.js', 'The standing school-only instructions, prompt injection filters, and memory parser.'],
    ['src/agent/scope-guard.js', 'Fast secondary AI scope gate for ambiguous or disguised non-school prompts.'],
    ['src/agent/memory.js', 'Persistent scoped Ask memory and saved chat history across restarts.'],
    ['src/agent/kb.js', 'Autonomous Q&A knowledge base that learns from past conversations automatically.'],
    ['src/agent/settings.js', 'The API keys, model and monthly cap. Keys stay on this computer and are never sent to the page.'],
    ['src/agent/usage.js', 'The spend meter: prices, a ledger of every call and the monthly cap.'],
  ]],
  ['Send results to your Google Sheet copy', [
    ['google-sheet/Code.gs', 'Goes inside the Google Sheet copy: adds the School Info menu, writes a school\'s findings into its tab, logs the export and sends the daily email.'],
    ['google-sheet/load-dialog.html', 'The window the sheet\'s menu opens to pick the export file. Its text is copied into Code.gs so the script stays one file.'],
    ['src/lib/sheet-export.js', 'Makes the export file for the Google Sheet (or sends it straight to the script).'],
    ['src/lib/spreadsheet-export.js', 'Exports school comparisons to plain Excel (.xlsx) and CSV spreadsheets.'],
  ]],
  ['Share a read-only copy online (set aside for now)', [
    ['deploy/build-static.js', 'Exports a read-only copy of the dashboard as plain files, for sharing with the team.'],
    ['deploy/deploy-copy.js', 'Uploads the read-only copy to Cloudflare Pages, but only once a Cloudflare Access login is protecting it.'],
    ['deploy/publish-copy.js', 'Publishes the read-only copy through a private GitHub repository that Cloudflare Pages deploys, but only once a login protects it.'],
    ['src/lib/access-check.js', 'Checks that a Cloudflare Pages address answers with an Access login before anything is published.'],
  ]],
  ['Settings', [
    ['config.json', 'Crawl speed and limits, the port, and (optionally) the workbook path.'],
    ['package.json', 'The libraries the program uses, and the shortcut commands.'],
  ]],
];
const CODE_FILES = CODE.flatMap(([, files]) => files.map(([f]) => f));

const cache = new Map();
const cmpCache = new Map();
function statMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
function cachedJson(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { cache.delete(file); return null; }
  const hit = cache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit.data;
  const data = readJson(file);
  cache.set(file, { mtime: stat.mtimeMs, data });
  return data;
}
const clearCache = () => { cache.clear(); cmpCache.clear(); };
const getTemplate = () => cachedJson(PATHS.template);
const getSchools = () => cachedJson(PATHS.schools);
const getSheet = (id, opts) => (opts && opts.noSheet ? null : cachedJson(path.join(PATHS.sheetDir, id + '.json')));
const getResult = (id) => cachedJson(path.join(PATHS.resultsDir, id + '.json'));

function normSiteUrl(u) {
  if (!u || typeof u !== 'string') return '';
  try {
    const x = new URL(u.trim());
    return (x.hostname.replace(/^www\./i, '').toLowerCase() + x.pathname.replace(/\/+$/, '').toLowerCase());
  } catch { return ''; }
}
function siteUrlChanged(schoolWebsite, resultStart) {
  const a = normSiteUrl(schoolWebsite), b = normSiteUrl(resultStart);
  return !!(a && b && a !== b);
}

// How accurate each field has proved to be in the person's own spot-checks: it replaces the starting number of the trust score.
let priorCache = { mtime: null, map: new Map() };
const verificationFile = () => path.join(PATHS.data, 'verification.json');
function trustPriors() {
  const m = statMtime(verificationFile());
  if (m !== priorCache.mtime) {
    const v = m ? readJson(verificationFile(), null) : null;
    priorCache = { mtime: m, map: trust.priorsFromChecks(v && v.checks) };
  }
  return priorCache.map;
}

/** opts.noSheet: leave out everything that came from the workbook's own school tabs. */
function compareSchool(id, tabIndex = 0, opts) {
  const noSheet = !!(opts && opts.noSheet);
  const key = `${id}:${tabIndex}:${noSheet ? 1 : 0}:${statMtime(PATHS.template)}:${noSheet ? 0 : statMtime(path.join(PATHS.sheetDir, id + '.json'))}:${statMtime(path.join(PATHS.resultsDir, id + '.json'))}:${statMtime(verificationFile())}`;
  const cached = cmpCache.get(key);
  if (cached) return cached;

  const template = getTemplate();
  const sheet = getSheet(id, opts);
  const result = getResult(id);
  const tab = sheet && sheet.tabs[Math.min(tabIndex, sheet.tabs.length - 1)];
  const rows = [];
  const counts = { fills: 0, match: 0, differs: 0, both: 0, 'sheet-only': 0, none: 0, manual: 0 };
  const trustCounts = { ready: 0, check: 0, doubtful: 0 };      // the key facts found, by how much looking each needs
  const identityBad = !!(result && result.identity && result.identity.ok === false);
  const priors = trustPriors();
  for (const row of template.rows) {
    if (row.kind !== 'field') { rows.push({ ...row }); continue; }
    const cells = sheetCells(tab && tab.values[row.key], row);
    const scraped = result && result.fields ? result.fields[row.key] || null : null;
    const verdict = result && result.status === 'ok' ? compareField(row.key, cells, scraped) : (cells.length ? 'sheet-only' : 'none');
    counts[verdict]++;
    const t = result && result.status === 'ok' ? trust.scoreValue({
      key: row.key, field: scraped, pages: result.pages, identityBad, prior: priors.get(row.key),   // the sheet is not an input: it can be old or wrong
    }) : null;
    if (t) trustCounts[t.triage]++;
    rows.push(t ? { ...row, sheet: cells, scraped, verdict, trust: t } : { ...row, sheet: cells, scraped, verdict });
  }
  const out = { rows, counts, trustCounts, tab };
  cmpCache.set(key, out);
  return out;
}

function overview(opts) {
  const list = getSchools();
  const template = getTemplate();
  if (!list || !template) return { ready: false };
  const fieldCount = template.rows.filter((r) => r.kind === 'field').length;
  const labels = new Map();
  for (const r of template.rows) if (r.kind === 'field' && r.key) labels.set(r.key, String(r.label || r.key).replace(/:$/, ''));
  const schools = list.schools.map((s) => {
    const r = getResult(s.id);
    const base = { id: s.id, name: s.name, tier: s.tier, region: s.region, website: s.website, division: s.division, tabs: opts && opts.noSheet ? 0 : s.tabs.length };
    if (!r) return { ...base, status: 'not-scraped' };
    const full = compareSchool(s.id, 0, opts);
    const cmp = full.counts, tc = full.trustCounts;
    const changes = Array.isArray(r.changes) ? r.changes : [];
    const changesCount = changes.length;
    const changesSummary = changesCount ? changes.slice(0, 4).map((c) => labels.get(c.key) || c.key) : undefined;
    return {
      ...base, status: r.status, detail: r.detail, scrapedAt: r.scrapedAt, pages: (r.pages || []).length,
      found: r.counts ? r.counts.found : 0, fills: cmp.fills, match: cmp.match, differs: cmp.differs,
      ready: tc.ready, check: tc.check, doubtful: tc.doubtful, look: tc.check + tc.doubtful,   // key facts: ready to use / need a quick check / doubtful
      changesCount, changedAt: r.changedAt || null, changesSummary,
      urlChanged: siteUrlChanged(s.website, r.start) || undefined,
      wrongSite: !!(r.identity && r.identity.ok === false),
    };
  });
  return { ready: true, importedAt: list.importedAt, workbook: list.workbook, fieldCount, schools };
}

/** Everything the school page needs; null when the id is unknown. */
function schoolPayload(id, tabIndex = 0, opts) {
  const list = getSchools();
  const school = list && list.schools.find((s) => s.id === id);
  if (!school) return null;
  const sheet = getSheet(school.id, opts);
  const result = getResult(school.id);
  const idx = Math.max(0, Math.min(Number(tabIndex) || 0, sheet ? sheet.tabs.length - 1 : 0));
  const cmp = compareSchool(school.id, idx, opts);
  const urlChanged = result ? siteUrlChanged(school.website, result.start) : false;
  return {
    school, tabIndex: idx, urlChanged,
    tabs: sheet ? sheet.tabs.map((t) => ({ tab: t.tab, matchedBy: t.matchedBy, nameInTab: t.nameInTab, guideCols: t.guideCols })) : [],
    result: result ? {
      status: result.status, detail: result.detail, scrapedAt: result.scrapedAt, start: result.start,
      pages: result.pages, skipped: result.skipped, portals: result.portals, ms: result.ms,
      identity: result.identity || null,
      changes: Array.isArray(result.changes) ? result.changes : [],
      changedAt: result.changedAt || null,
      // answers read from pages a person saved by hand (for a website that refuses automatic reading)
      source: result.source || null, savedPages: result.savedPages || null, lastAttempt: result.lastAttempt || null,
      // answers filled from pages saved by hand from Ravenna, Niche and the review sites (lib/sources.js)
      websiteStatus: result.websiteStatus || null, otherSources: result.otherSources || null,
    } : null,
    rows: cmp.rows, counts: cmp.counts, trustCounts: cmp.trustCounts,
  };
}

/** The list of code files, or one file's text. */
function codeList(cfg) {
  const files = [];
  for (const [group, list] of CODE) {
    for (const [file, note] of list) {
      let lines = 0;
      try { lines = fs.readFileSync(path.join(PATHS.root, file), 'utf8').split('\n').length; } catch { /* a listed file that is missing shows 0 lines */ }
      files.push({ file, group, lines, note });
    }
  }
  return { files, config: { workbookPath: cfg.workbookPath, crawl: cfg.crawl } };
}
function codeFile(file) {
  return CODE_FILES.includes(file) ? { file, content: fs.readFileSync(path.join(PATHS.root, file), 'utf8') } : null;
}

module.exports = { CODE_FILES, getTemplate, getSchools, getResult, compareSchool, overview, schoolPayload, codeList, codeFile, clearCache };
