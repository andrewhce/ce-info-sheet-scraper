'use strict';
// Google Apps Script has no easy way to ship a separate .html file without adding it by hand, so the loader
// window's page (google-sheet/load-dialog.html) is copied INTO google-sheet/Code.gs as text. That keeps the
// script a single file to paste. Edit load-dialog.html, then run:  npm run build-sheet-script
//   node tools/embed-dialog.js          rewrite the block in Code.gs
//   node tools/embed-dialog.js --check  only report whether Code.gs is up to date (used by npm test)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'google-sheet', 'load-dialog.html');
const CODE = path.join(ROOT, 'google-sheet', 'Code.gs');
const START = '// >>> generated from google-sheet/load-dialog.html by tools/embed-dialog.js';
const END = '// <<< end of generated dialog';

const lit = (line) => "    '" + line.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

/** The block that belongs between the two marker lines. */
function block(html) {
  const lines = html.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return [
    START + ' (edit that file, then run: npm run build-sheet-script)',
    'function loadDialogHtml_() {',
    '  return [',
    lines.map(lit).join(',\n'),
    "  ].join('\\n');",
    '}',
    END,
  ].join('\n');
}

/** Code.gs text with the generated block replaced. */
function embed(code, html) {
  const a = code.indexOf(START);
  const b = code.indexOf(END);
  if (a < 0 || b < a) throw new Error('Code.gs has no generated-dialog markers.');
  return code.slice(0, a) + block(html) + code.slice(b + END.length);
}

function upToDate() {
  const code = fs.readFileSync(CODE, 'utf8').replace(/\r\n/g, '\n');
  return embed(code, fs.readFileSync(HTML, 'utf8')) === code;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    if (upToDate()) console.log('Code.gs already holds the current load-dialog.html.');
    else { console.error('Code.gs is out of date. Run: npm run build-sheet-script'); process.exit(1); }
  } else {
    const code = fs.readFileSync(CODE, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(CODE, embed(code, fs.readFileSync(HTML, 'utf8')));
    console.log('Code.gs now holds the current load-dialog.html.');
  }
}

module.exports = { embed, upToDate, HTML, CODE };
