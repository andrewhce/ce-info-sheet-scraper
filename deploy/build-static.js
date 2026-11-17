'use strict';
// Exports a read-only copy of the dashboard as plain files (no server, no scraping controls).
// The copy can be hosted anywhere that serves static files, ideally behind a login.
//
//   node deploy/build-static.js                   writes deploy/site
//   node deploy/build-static.js --out some/dir    writes somewhere else
//   node deploy/build-static.js --no-sheet        leaves out everything taken from the workbook's school tabs
//
// The copy is a snapshot: run this again after more schools are scraped, then upload the folder again.
const fs = require('fs');
const path = require('path');
const { PATHS, loadConfig, writeJson } = require('../src/lib/util');
const data = require('../src/lib/dashboard-data');

const args = process.argv.slice(2);
const opts = { noSheet: args.includes('--no-sheet') };
const outIdx = args.indexOf('--out');
const OUT = path.resolve(PATHS.root, outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : path.join('deploy', 'site'));
const MARKER = '.school-info-site';

// Only ever empty a folder that this script made earlier (it leaves a marker file), or an empty one.
if (fs.existsSync(OUT)) {
  const entries = fs.readdirSync(OUT);
  if (entries.length && !entries.includes(MARKER)) {
    console.error(`${OUT} already has files that this script did not make. Choose another folder with --out.`);
    process.exit(1);
  }
  if (entries.length) fs.rmSync(OUT, { recursive: true, force: true });
}
fs.mkdirSync(path.join(OUT, 'data', 'school'), { recursive: true });
fs.writeFileSync(path.join(OUT, MARKER), 'Made by build-static.js. This folder is emptied and rebuilt each time.\n');

const list = data.getSchools();
if (!list || !data.getTemplate()) { console.error('Nothing to export yet. Run:  node import-workbook.js'); process.exit(1); }

// ---- data ----
const ov = data.overview(opts);
delete ov.workbook;                                   // a path on this computer
ov.generatedAt = new Date().toISOString();
writeJson(path.join(OUT, 'data', 'overview.json'), ov);

// Many portal links in the school list are one family's own application page (a student and application
// number in the address). They are cut back to the portal's front page so they are never published.
function generalPortal(u, dropQuery) {
  if (!u) return u;
  try {
    const x = new URL(u);
    return /\/(students?|applications?|users?|accounts?|families|family|applicants?)\/[\w-]*\d/i.test(x.pathname) || (dropQuery && x.search) ? x.origin + '/' : u;
  } catch { return null; }
}

let scraped = 0;
for (const s of list.schools) {
  const payloads = [];
  for (let i = 0; i < Math.max(1, opts.noSheet ? 1 : s.tabs.length); i++) {
    const p = data.schoolPayload(s.id, i, opts);
    p.school = { ...p.school, portal: generalPortal(p.school.portal, true) };
    for (const row of p.rows) for (const c of row.sheet || []) if (c.link) c.link = generalPortal(c.link, false); // links typed into the school's tab
    if (opts.noSheet) { p.school.tabs = []; }
    payloads.push(p);
  }
  if (payloads[0].result && payloads[0].result.status === 'ok') scraped++;
  writeJson(path.join(OUT, 'data', 'school', s.id + '.json'), payloads);
}

// ---- the script, shown on the Script page ----
const cfg = loadConfig();
const listing = data.codeList(cfg);
const PLACEHOLDER = '(set on the computer that runs the script)';
listing.config.workbookPath = PLACEHOLDER;
const contents = {};
for (const f of listing.files) {
  let text = data.codeFile(f.file).content;
  if (f.file === 'config.json') { const c = JSON.parse(text); c.workbookPath = PLACEHOLDER; text = JSON.stringify(c, null, 2) + '\n'; }
  contents[f.file] = text;
}
writeJson(path.join(OUT, 'data', 'code.json'), { files: listing.files, config: listing.config, contents });

// ---- pages ----
const PUB = PATHS.public;
let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const swaps = [
  ['<body>', '<body data-mode="static">'],
  ['href="/styles.css"', 'href="styles.css"'],
  ['src="/app.js"', 'src="app.js"'],
  ['<title>School Info Sheet</title>', '<title>School Info Sheet (read-only)</title>\n<meta name="robots" content="noindex, nofollow">'],
  ['    <a href="#/run" data-view="run" title="Read the schools’ websites">Check websites</a>\n', ''],
  ['    <a href="#/start" data-view="start">Start here</a>\n', ''],
  ['    <a href="#/ask" data-view="ask" title="Ask the AI assistant a question about the schools">Ask</a>\n', ''],           // the read-only copy has no server, so no assistant
  ['    <a href="#/accuracy" data-view="accuracy" title="How often the answers are right">Accuracy</a>\n', ''],   // nor spot-checks
  ['    <a href="#/review" data-view="review" title="The answers the dashboard is least sure about">To check</a>\n', ''],         // nor the review queue (it needs the server)
];
for (const [from, to] of swaps) {
  if (!html.includes(from)) { console.error(`src/public/index.html no longer contains: ${from}\nUpdate deploy/build-static.js to match.`); process.exit(1); }
  html = html.replace(from, to);
}
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.copyFileSync(path.join(PUB, 'app.js'), path.join(OUT, 'app.js'));
fs.copyFileSync(path.join(PUB, 'styles.css'), path.join(OUT, 'styles.css'));

// Response headers for hosts that read a _headers file (Cloudflare Pages, Netlify)
fs.writeFileSync(path.join(OUT, '_headers'), [
  '/*',
  '  X-Robots-Tag: noindex, nofollow',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  "  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  '/data/*',
  '  Cache-Control: no-cache',
  '',
].join('\n'));
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

// ---- report ----
let files = 0, bytes = 0;
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; }
  }
})(OUT);
console.log(`Read-only copy written to ${OUT}`);
console.log(`  ${list.schools.length} schools (${scraped} scraped), ${files} files, ${(bytes / 1048576).toFixed(1)} MB${opts.noSheet ? ', workbook tab content left out' : ''}`);
console.log('  Open index.html through a web server (it loads data files), for example:  npx serve site');
