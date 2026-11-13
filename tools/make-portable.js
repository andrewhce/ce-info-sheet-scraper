'use strict';
// Builds a folder (and a zip) that a teammate can unzip and double-click, with Node.js packed inside: nothing to install.
//
//   node tools/make-portable.js                        writes dist/School-Info-Sheet and dist/School-Info-Sheet.zip
//   node tools/make-portable.js --no-zip               the folder only
//   node tools/make-portable.js --with-google-export   also includes this computer's saved Google Sheet export settings
//                                                      (the web app address and its secret): send the zip privately
//
// Windows 64-bit only: it copies this computer's Node.js program into the folder.
// Nothing from the data folder is copied, so no workbook, results or page cache goes into the package.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { PATHS, readJson } = require('../src/lib/util');

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const DIST = path.join(PATHS.root, 'dist');
const OUT = path.join(DIST, 'School-Info-Sheet');
const ZIP = path.join(DIST, 'School-Info-Sheet.zip');
const MARKER = '.portable-build';
const fail = (msg) => { console.error(msg); process.exit(1); };

if (process.platform !== 'win32' || process.arch !== 'x64') fail('This builds a Windows 64-bit package, so it has to be run on a Windows 64-bit computer (it copies this computer\'s Node.js).');
for (const lib of ['cheerio', 'exceljs', 'pdf-parse', 'jszip', '@anthropic-ai/sdk']) {
  try { require.resolve(lib, { paths: [PATHS.root] }); } catch { fail(`The library "${lib}" is not installed here. Run:  npm install`); }
}
if (fs.existsSync(OUT)) {
  if (!fs.existsSync(path.join(OUT, MARKER))) fail(`${OUT} already exists and was not made by this script. Move it away first.`);
  fs.rmSync(OUT, { recursive: true, force: true });
}
fs.mkdirSync(path.join(OUT, 'runtime'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.writeFileSync(path.join(OUT, MARKER), 'Made by tools/make-portable.js. This folder is emptied and rebuilt each time.\n');
fs.writeFileSync(path.join(OUT, 'data', '.keep'), '');

const copy = (rel, filter) => { const from = path.join(PATHS.root, rel); if (fs.existsSync(from)) fs.cpSync(from, path.join(OUT, rel), { recursive: true, filter }); };
for (const f of ['Start Dashboard.cmd', 'Check Setup.cmd', 'package.json', 'package-lock.json', 'Dockerfile', 'docker-entrypoint.sh']) copy(f);
for (const d of ['src', 'google-sheet', 'docs']) copy(d);
copy('deploy', (from) => !from.includes(path.join('deploy', 'site')));
console.log('Copying the libraries ...');
copy('node_modules');

// the settings, without this computer's workbook path
const cfg = readJson(PATHS.config);
cfg.workbookPath = '';
fs.writeFileSync(path.join(OUT, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');

// Node.js itself
fs.copyFileSync(process.execPath, path.join(OUT, 'runtime', 'node.exe'));
fs.writeFileSync(path.join(OUT, 'runtime', 'README.txt'), `This folder holds Node.js ${process.version} (https://nodejs.org), the free program that runs the School Info Sheet. It is used only by this folder and does not change anything else on the computer.\r\n`);

let withExport = false;
if (has('--with-google-export')) {
  const f = path.join(PATHS.data, 'export-config.json');
  if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(OUT, 'data', 'export-config.json')); withExport = true; }
  else console.warn('No Google Sheet export settings are saved on this computer, so none were included.');
}

const readme = [
  'SCHOOL INFO SHEET: READ ME FIRST',
  '',
  '1. Unzip this folder anywhere, for example onto your Desktop. Do not run it from inside the zip file.',
  '2. Open the folder and double-click "Start Dashboard.cmd". A black window opens, then your web browser.',
  '   - If Windows shows a blue "Windows protected your PC" box, click "More info", then "Run anyway".',
  '   - Keep the black window open while you use the dashboard. Close it to stop.',
  '3. On the "Start here" page, choose your School Information Sheet as an Excel file.',
  '   In Google Sheets that is File, Download, Microsoft Excel (.xlsx).',
  '4. Use "Run scraper" to read the school websites (Tier 1 takes about an hour; keep the computer on),',
  '   and "Schools" to review what was found.',
  '',
  'Nothing needs installing. Everything the program saves goes in the "data" folder here.',
  '',
  'SHARING: on the Start here page, "Save my results to a file" makes one file you can send a teammate,',
  'and "Add a teammate\'s results file" adds theirs, so the same schools are not read twice.',
  '',
  withExport ? 'The Google Sheet export is already set up in this copy. Keep this folder private: it holds the export secret.' : 'The Google Sheet export is optional. Setup steps are in the docs folder (GOOGLE-SHEET-EXPORT.md).',
  '',
  'Trouble? Double-click "Check Setup.cmd" to see what is ready and what is not. More help is in the "docs" folder.',
  '',
].join('\r\n');
fs.writeFileSync(path.join(OUT, 'READ ME FIRST.txt'), readme);

const sizeMb = (dir) => { let n = 0; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else n += fs.statSync(p).size; } })(dir); return Math.round(n / 1048576); };
console.log(`Folder ready: ${OUT} (${sizeMb(OUT)} MB)`);

if (!has('--no-zip')) {
  fs.rmSync(ZIP, { force: true });
  console.log('Making the zip ...');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${ZIP}' -Force`], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(ZIP)) fail('The zip could not be made. The folder above is complete; zip it yourself (right-click, Send to, Compressed folder).');
  console.log(`Zip ready: ${ZIP} (${Math.round(fs.statSync(ZIP).size / 1048576)} MB)`);
}
if (withExport) console.log('\nThis package contains the Google Sheet export secret. Send it only to people you trust, and not by public links.');
console.log('\nSend the zip to a teammate. They unzip it and double-click "Start Dashboard.cmd".');
