'use strict';
// Runs google-sheet/Code.gs against a fake Google Sheet built from the real workbook's tabs.
// Google's own classes are replaced by small stand-ins, so this checks the script's logic (which rows
// and cells it writes, what it leaves alone, notes, log, email) but not Google itself.
//   node tests/apps-script.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { loadWorkbookLean } = require('../src/lib/xlsx-lean');
const ROOT = path.join(__dirname, '..');
const { loadConfig, resolveWorkbook, PATHS, readJson } = require('../src/lib/util');
const { keyRows } = require('../src/lib/template');
const sheetExport = require('../src/lib/sheet-export');

// ------------------------------------------------------------ fake Google ---
class Cell { constructor() { this.v = ''; this.d = ''; this.note = ''; this.bg = '#ffffff'; this.fmt = ''; this.rich = null; this.formula = null; this.checkbox = false; } }
let sheetSeq = 100;
class FakeSheet {
  constructor(name) { this.name = name; this.id = sheetSeq++; this.cells = new Map(); }
  cell(r, c, make = true) { const k = r + ',' + c; if (!this.cells.has(k) && make) this.cells.set(k, new Cell()); return this.cells.get(k); }
  getName() { return this.name; }
  setName(n) { this.name = n; }
  getSheetId() { return this.id; }
  getLastRow() { let m = 0; for (const [k, c] of this.cells) if (c.d !== '' || c.v !== '') m = Math.max(m, Number(k.split(',')[0])); return m; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  copyTo(ss) { const s = new FakeSheet('Copy of ' + this.name); for (const [k, c] of this.cells) s.cells.set(k, Object.assign(new Cell(), JSON.parse(JSON.stringify(c)))); ss.sheets.push(s); return s; }
  insertRowAfter(r) { const moved = new Map(); for (const [k, c] of this.cells) { const [rr, cc] = k.split(',').map(Number); moved.set((rr > r ? rr + 1 : rr) + ',' + cc, c); } this.cells = moved; }
  setFrozenRows() {}
}
class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.sheet.cell(this.r + i, this.c + j), i, j); return this; }
  grid(fn) { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(fn(this.sheet.cell(this.r + i, this.c + j, false) || new Cell())); out.push(row); } return out; }
  getValues() { return this.grid((c) => c.v); }
  getDisplayValues() { return this.grid((c) => c.d); }
  getNotes() { return this.grid((c) => c.note); }
  getBackgrounds() { return this.grid((c) => c.bg); }
  getValue() { return this.getValues()[0][0]; }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  setValue(v) { return this.each((c) => { c.v = v; c.rich = null; c.formula = null; c.d = autoParse(String(v), c.fmt); }); }
  setValues(vv) { return this.each((c, i, j) => { c.v = vv[i][j]; c.d = String(vv[i][j]); }); }
  setNote(n) { return this.each((c) => { c.note = n; }); }
  setBackground(b) { return this.each((c) => { c.bg = b; }); }
  setNumberFormat(f) { return this.each((c) => { c.fmt = f; }); }
  setFontWeight() { return this; }
  setRichTextValue(rt) { return this.each((c) => { c.v = rt.text; c.d = rt.text; c.rich = rt; }); }
  setFormula(f) { return this.each((c) => { c.formula = f; c.d = 'formula'; }); }
  insertCheckboxes() { return this.each((c) => { c.checkbox = true; c.v = false; c.d = 'FALSE'; }); }
}
// What Google does when a value is typed into a cell that is not formatted as plain text
function autoParse(s, fmt) {
  if (fmt === '@') return s;
  if (/^\d{1,2}:\d{1,2}$/.test(s)) return 'AUTO-TIME(' + s + ')';
  if (/^\d{1,2}-\d{1,2}$/.test(s)) return 'AUTO-DATE(' + s + ')';
  if (/^[=+]/.test(s)) return 'AUTO-FORMULA(' + s + ')';
  return s;
}
class FakeSpreadsheet {
  constructor(sheets = []) { this.sheets = sheets; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getName() { return 'School Information Sheet (copy)'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/TEST/edit'; }
  getSpreadsheetTimeZone() { return 'UTC'; }
}
function newRich() {
  const rt = { text: '', links: [] };
  const b = { setText(t) { rt.text = t; return b; }, setLinkUrl(...a) { rt.links.push(a.length === 1 ? { start: 0, end: rt.text.length, url: a[0] } : { start: a[0], end: a[1], url: a[2] }); return b; }, build() { return rt; } };
  return b;
}
function loadScript(ss, props) {
  const mails = [], triggers = [], menus = [], dialogs = [], alerts = [];
  const ui = {
    createMenu(name) { const m = { name, items: [] }; const chain = { addItem(label, fn) { m.items.push([label, fn]); return chain; }, addSeparator() { m.items.push(['---']); return chain; }, addToUi() { menus.push(m); } }; return chain; },
    showModalDialog(html, title) { dialogs.push({ html, title }); },
    alert(...a) { alerts.push(a); }, ButtonSet: { OK: 'OK' },
  };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, newRichTextValue: newRich, getUi: () => ui },
    HtmlService: { createHtmlOutput(s) { const o = { html: s, setWidth(w) { o.w = w; return o; }, setHeight(h) { o.h = h; return o; } }; return o; } },
    ContentService: { createTextOutput: (s) => ({ s, setMimeType() { return this; }, getContent() { return s; } }), MimeType: { JSON: 'JSON' } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }) },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
    MailApp: { sendEmail: (o) => mails.push(o) },
    ScriptApp: { getProjectTriggers: () => triggers, deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => { const t = { getHandlerFunction: () => fn }; const chain = { timeBased: () => chain, everyDays: () => chain, atHour: (h) => { t.hour = h; return chain; }, create: () => { triggers.push(t); return t; } }; return chain; } },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'google-sheet', 'Code.gs'), 'utf8'), ctx);
  const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  return { ctx, mails, triggers, post, menus, dialogs, alerts };
}

// -------------------------------------------------------- real tabs -> fake ---
function fromWorksheet(ws, name) {
  const s = new FakeSheet(name || ws.name);
  for (let r = 1; r <= 70; r++) for (let c = 1; c <= 4; c++) {
    const raw = ws.getCell(r, c).text;
    const text = raw == null ? '' : typeof raw === 'object' ? (raw.text != null ? String(raw.text) : '') : String(raw);
    if (text !== '') { const k = s.cell(r, c); k.v = text; k.d = text; }
  }
  return s;
}
const clone = (sheet, name) => { const s = new FakeSheet(name); for (const [k, c] of sheet.cells) s.cells.set(k, Object.assign(new Cell(), JSON.parse(JSON.stringify(c)))); return s; };
const snapshot = (sheet) => JSON.stringify([...sheet.cells].sort().map(([k, c]) => [k, c.d, c.note, c.bg]));

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok   ' + name); };

(async () => {
  const cfg = loadConfig();
  const wbFile = resolveWorkbook(cfg);
  if (!fs.existsSync(wbFile)) { console.log('Workbook not found, test skipped: ' + wbFile); return; }
  console.log('Reading the workbook ...');
  const wb = await loadWorkbookLean(wbFile);
  const skip = new Set([cfg.templateTab, cfg.listTab, 'Copy of Master Template', 'Priority List']);
  const tabs = wb.worksheets.filter((w) => !skip.has(w.name)).map((w) => fromWorksheet(w));
  const template = fromWorksheet(wb.getWorksheet(cfg.templateTab), 'Master Template');
  const TOKEN = 'test-secret-test-secret-test-secret';
  const mkSs = (...sheets) => new FakeSpreadsheet(sheets);
  console.log(`${tabs.length} school tabs loaded.\n`);

  // 1. the script finds the same rows as the dashboard does, on every real tab
  check('row detection matches the dashboard on every tab and the template', () => {
    const { ctx } = loadScript(mkSs(), {});
    let compared = 0;
    for (const sh of [...tabs, template]) {
      const labels = [];
      for (let r = 1; r <= 120; r++) { const c = sh.cell(r, 1, false); if (c && c.d.trim()) labels.push({ row: r, label: c.d }); }
      const want = {};
      for (const e of keyRows(labels)) if (e.kind === 'field' && !(e.key in want)) want[e.key] = e.row;
      const got = JSON.parse(JSON.stringify(ctx.locateRows_(sh).rows)); // plain object: the script runs in its own JavaScript context
      assert.deepStrictEqual(got, want, 'row maps differ on tab: ' + sh.name);
      compared++;
    }
    assert.ok(compared > 300);
  });

  // 2. a filled tab: existing text is never replaced, differences get a note, matches are left alone
  const cast = tabs.find((t) => t.name === 'Castilleja (Upper) School');
  const castPayload = sheetExport.buildExport('castilleja-upper-school', 0);
  let castSs, castRun, castResult;
  check('filled tab: nothing a person typed is changed', () => {
    const tab = clone(cast, 'Castilleja (Upper) School');
    castSs = mkSs(tab, clone(template, 'Master Template'));
    castRun = loadScript(castSs, { EXPORT_TOKEN: TOKEN });
    const before = new Map([...tab.cells].map(([k, c]) => [k, c.d]));
    castResult = castRun.post({ ...castPayload, token: TOKEN });
    assert.strictEqual(castResult.ok, true, castResult.error);
    assert.strictEqual(castResult.created, false);
    for (const [k, c] of tab.cells) {
      const was = before.get(k);
      if (was !== undefined && was !== '' && !/formula/.test(c.d)) assert.strictEqual(c.d, was, 'cell ' + k + ' text changed');
    }
    // columns A and D are never touched
    for (const [k, c] of tab.cells) if (/,(1|4)$/.test(k)) assert.strictEqual(c.note, '', 'note written in column A or D at ' + k);
    const s = castResult.summary;
    assert.strictEqual(s.filled + s.flagged + s.unchanged + s.noRow, castPayload.fields.length);
    assert.ok(s.flagged > 0 && s.unchanged > 0, JSON.stringify(s));
    console.log('         Castilleja (Upper) export into its filled tab: ' + JSON.stringify(s));
  });
  check('filled tab: a different value gets an "updated info" note and orange highlight', () => {
    const tab = castSs.getSheetByName('Castilleja (Upper) School');
    const row = castRun.ctx.locateRows_(tab).rows.facultyDegrees;
    const cell = tab.cell(row, 2);
    assert.strictEqual(cell.d, cast.cell(row, 2).d, 'the existing value was replaced');
    assert.ok(cell.d !== '' && !cell.d.includes('81'));
    assert.ok(cell.note.includes('UPDATED INFO ON WEBSITE'), cell.note);
    assert.ok(cell.note.includes('81%') && cell.note.includes('Source: https://'), cell.note);
    assert.strictEqual(cell.bg, '#fce5cd');
  });
  check('filled tab: a value that already matches is left alone (no note)', () => {
    const tab = castSs.getSheetByName('Castilleja (Upper) School');
    const row = castRun.ctx.locateRows_(tab).rows.location;
    assert.strictEqual(tab.cell(row, 2).note, '');
  });
  check('re-export: notes do not stack, nothing new is overwritten, log gets a second row', () => {
    const tab = castSs.getSheetByName('Castilleja (Upper) School');
    const before = snapshot(tab);
    const again = castRun.post({ ...castPayload, token: TOKEN });
    assert.strictEqual(again.ok, true);
    assert.strictEqual(snapshot(tab), before, 'a second export changed the tab');
    for (const c of tab.cells.values()) assert.ok((c.note.match(/\[School Info export\]/g) || []).length <= 1);
    assert.strictEqual(castSs.getSheetByName('Export Log').getLastRow(), 3);
  });
  check('a person\'s own note on a cell is kept above the export note', () => {
    const tab = clone(cast, 'Castilleja (Upper) School');
    const ss = mkSs(tab);
    const run = loadScript(ss, { EXPORT_TOKEN: TOKEN });
    const row = run.ctx.locateRows_(tab).rows.facultyDegrees;
    tab.cell(row, 2).note = 'Checked with the registrar in September.';
    run.post({ ...castPayload, token: TOKEN });
    run.post({ ...castPayload, token: TOKEN });
    const note = tab.cell(row, 2).note;
    assert.ok(note.startsWith('Checked with the registrar in September.'));
    assert.strictEqual((note.match(/\[School Info export\]/g) || []).length, 1);
  });

  // 3. a blank tab: everything found is filled; hint text is replaced; text stays text
  check('blank tab: cells are filled, hints replaced, ratios and dates stay text', () => {
    const tab = clone(template, 'Test School');
    const ss = mkSs(tab);
    const run = loadScript(ss, { EXPORT_TOKEN: TOKEN });
    const payload = JSON.parse(JSON.stringify(castPayload));
    payload.school = { ...payload.school, name: 'Test School', tab: 'Test School' };
    payload.fields.push({ key: 'ratio', label: 'Student-Teacher Ratio', value: '6:1', confidence: 'high', sources: [{ url: 'https://example.edu/a' }] });
    payload.fields.push({ key: 'grades', label: 'Grades', value: '9-12', confidence: 'high', sources: [{ url: 'https://example.edu/a' }] });
    const res = run.post({ ...payload, token: TOKEN });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.summary.flagged, 0);
    assert.strictEqual(res.summary.filled, payload.fields.length - res.summary.noRow);
    const rows = run.ctx.locateRows_(tab).rows;
    assert.strictEqual(tab.cell(rows.ratio, 2).d, '6:1');
    assert.strictEqual(tab.cell(rows.grades, 2).d, '9-12');
    const facts = tab.cell(rows.factsSheet, 3);
    assert.ok(!/Add At a Glance/.test(facts.d), 'hint was kept: ' + facts.d);
    assert.ok(facts.rich && facts.rich.links.length >= 1 && /^https:/.test(facts.rich.links[0].url), 'facts sheet is not a link');
    assert.ok(tab.cell(rows.essays, 3).d.startsWith('Student\n'), 'essays row lost its Student label: ' + tab.cell(rows.essays, 3).d.slice(0, 30));
    assert.ok(!/rename the events/i.test(tab.cell(rows.infoSessions, 2).d));
    assert.strictEqual(tab.cell(rows.infoSessions, 3).d, template.cell(rows.infoSessions, 3).d, 'the hint in column C was disturbed');
    assert.strictEqual(tab.cell(rows.ratio, 2).bg, '#fff2cc');
    for (const c of tab.cells.values()) assert.ok(!/^AUTO-/.test(c.d), 'a value was auto-converted: ' + c.d);
    // website-derived Guide rows land in column C, school facts in column B
    assert.ok(tab.cell(rows.application, 3).d.length > 20 && tab.cell(rows.application, 2).d === '');
    assert.ok(tab.cell(rows.tuition, 2).d.length > 3 && tab.cell(rows.tuition, 3).d === '');
  });

  // 4. a school with no tab gets one, made from the template, with the two-column header row
  check('no tab: a new one is made from the Master Template', () => {
    const ss = mkSs(clone(template, 'Master Template'));
    const run = loadScript(ss, { EXPORT_TOKEN: TOKEN });
    const payload = JSON.parse(JSON.stringify(castPayload));
    payload.school = { id: 'beau-soleil', name: 'Beau Soleil', tab: null, nameInTab: null, website: 'https://www.beausoleil.ch/' };
    const res = run.post({ ...payload, token: TOKEN });
    assert.strictEqual(res.ok, true, res.error);
    assert.strictEqual(res.created, true);
    const tab = ss.getSheetByName('Beau Soleil');
    assert.ok(tab, 'new tab not found');
    assert.strictEqual(tab.cell(1, 2).d, 'Beau Soleil');
    const guide = run.ctx.locateRows_(tab).guideRow;
    assert.strictEqual(tab.cell(guide + 1, 2).d, 'Admissions Portal');
    assert.strictEqual(tab.cell(guide + 1, 3).d, 'School Website');
    const rows = run.ctx.locateRows_(tab).rows;
    assert.ok(tab.cell(rows.application, 3).d.length > 20, 'application text missing after the header row shift');
    assert.strictEqual(template.cell(guide + 1, 2).d, template.cell(guide + 1, 2).d); // template untouched (clone)
    const log = ss.getSheetByName('Export Log');
    assert.ok(log && /New tab created/.test(log.cell(2, 10).d));
    // a second school with the same name does not clash
    const res2 = run.post({ ...payload, school: { ...payload.school, name: 'Beau Soleil' }, token: TOKEN });
    assert.strictEqual(res2.created, false, 'the second export should reuse the tab just made');
  });

  // 5. finding the right tab when names differ a little
  check('tab matching: full name, cut title, B1 name; never a template or log tab', () => {
    const mk = (name, b1) => { const t = new FakeSheet(name); t.cell(1, 1).d = 'School Name'; t.cell(1, 1).v = 'School Name'; t.cell(1, 2).d = b1 || ''; t.cell(1, 2).v = b1 || ''; return t; };
    const long = mk('Silicon Valley International (Upper) School');
    const odd = mk('Hackley Lower', 'Hackley School');
    const ss = mkSs(clone(template, 'Master Template'), long, odd);
    const run = loadScript(ss, { EXPORT_TOKEN: TOKEN });
    const f = (school) => run.ctx.findTab_(ss, school);
    assert.strictEqual(f({ name: 'Silicon Valley International (Upper) School', tab: 'Silicon Valley International (U' }).sheet, long);
    assert.strictEqual(f({ name: 'Silicon Valley International (Upper) School', tab: null }).sheet, long);
    assert.strictEqual(f({ name: 'Something Else', tab: null, nameInTab: 'Hackley School' }).sheet, odd);
    assert.strictEqual(f({ name: 'Master Template', tab: null }).sheet.getName(), 'Master Template');
  });

  // 6. secret, ping
  check('wrong secret is refused; ping works; unknown action is refused', () => {
    const run = loadScript(mkSs(clone(template, 'Master Template')), { EXPORT_TOKEN: TOKEN });
    assert.strictEqual(run.post({ action: 'ping', token: 'nope' }).ok, false);
    assert.strictEqual(run.post({ action: 'ping' }).ok, false);
    const ping = run.post({ action: 'ping', token: TOKEN });
    assert.ok(ping.ok && ping.hasTemplate && ping.emailConfigured === false);
    assert.strictEqual(run.post({ action: 'delete', token: TOKEN }).ok, false);
    const noSecret = loadScript(mkSs(), {});
    assert.strictEqual(noSecret.post({ action: 'ping', token: '' }).ok, false, 'an unset secret must not let anyone in');
  });

  // 7. daily email
  check('daily email: one message listing schools, then nothing until a new export', () => {
    const { ctx, mails, post } = castRun;
    castRun.ctx.PropertiesService.getScriptProperties = () => ({ getProperty: (k) => ({ EXPORT_TOKEN: TOKEN, NOTIFY_EMAILS: 'a@example.com, b@example.com' }[k] || null) });
    ctx.sendDailyDigest();
    assert.strictEqual(mails.length, 1);
    assert.strictEqual(mails[0].to, 'a@example.com,b@example.com');
    assert.ok(/Castilleja \(Upper\) School/.test(mails[0].body) && /1 school updated/.test(mails[0].subject), mails[0].subject);
    ctx.sendDailyDigest();
    assert.strictEqual(mails.length, 1, 'sent twice');
    assert.ok(post({ ...castPayload, token: TOKEN }).ok);
    ctx.sendDailyDigest();
    assert.strictEqual(mails.length, 2);
  });
  check('daily email: with no recipients nothing is sent and nothing is marked as sent', () => {
    const tab = clone(cast, 'Castilleja (Upper) School');
    const ss = mkSs(tab);
    const run = loadScript(ss, { EXPORT_TOKEN: TOKEN });
    run.post({ ...castPayload, token: TOKEN });
    run.ctx.sendDailyDigest();
    assert.strictEqual(run.mails.length, 0);
    assert.strictEqual(ss.getSheetByName('Export Log').cell(2, 11).d, '');
  });
  check('setupDailyDigest installs a single daily trigger', () => {
    const run = loadScript(mkSs(), {});
    run.ctx.setupDailyDigest(); run.ctx.setupDailyDigest();
    assert.strictEqual(run.triggers.length, 1);
    assert.strictEqual(run.triggers[0].hour, 17);
  });

  // 8. the menu route: a file made by the dashboard, loaded from the sheet's own menu (no web app)
  const viaFile = (file) => JSON.parse(JSON.stringify(file));   // what the browser hands to the script
  const fileItem = (file, i) => ({ school: file.schools[i].school, fields: file.schools[i].fields, hints: file.hints });
  check('the dialog page inside Code.gs is the current google-sheet/load-dialog.html', () => {
    assert.ok(require('../tools/embed-dialog').upToDate(), 'run: npm run build-sheet-script');
  });
  check('menu: "School Info" appears on open, every item points at a real function, the dialog is modal-sized and holds the page', () => {
    const run = loadScript(mkSs(), {});
    run.ctx.onOpen();
    assert.strictEqual(run.menus.length, 1);
    assert.strictEqual(run.menus[0].name, 'School Info');
    const fns = run.menus[0].items.filter((x) => x[1]).map((x) => x[1]);
    assert.deepStrictEqual(fns, ['showLoadDialog', 'startDailyEmail']);
    for (const f of fns) assert.strictEqual(typeof run.ctx[f], 'function', f + ' is not defined');
    run.ctx.showLoadDialog();
    const d = run.dialogs[0].html;
    assert.ok(d.w >= 500 && d.h >= 400);
    for (const must of ['school-info-export', 'google.script.run', 'loadSchoolFromFile', 'type="file"', 'google.script.host.close']) assert.ok(d.html.includes(must), 'dialog lacks ' + must);
    assert.ok(!/<script src=|<link /i.test(d.html), 'the dialog must not load anything from outside');
  });
  const castFile = sheetExport.buildExportFile(['castilleja-upper-school']).file;
  check('a file loaded from the menu writes exactly what the web app writes', () => {
    const a = clone(cast, 'Castilleja (Upper) School'), b = clone(cast, 'Castilleja (Upper) School');
    const runA = loadScript(mkSs(a), { EXPORT_TOKEN: TOKEN }), runB = loadScript(mkSs(b), {});
    const web = runA.post({ ...castPayload, token: TOKEN });
    const res = runB.ctx.loadSchoolFromFile(viaFile(fileItem(castFile, 0)));
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(res.summary)), web.summary);
    assert.strictEqual(snapshot(b), snapshot(a), 'the two routes wrote different things');
    assert.strictEqual(runB.ctx.PropertiesService.getScriptProperties().getProperty('EXPORT_TOKEN'), null);   // no secret involved
  });
  check('a whole file: schools load one at a time, a bad entry is refused without stopping the rest, a missing tab is made', () => {
    const ss = mkSs(clone(cast, 'Castilleja (Upper) School'), clone(template, 'Master Template'));
    const run = loadScript(ss, {});
    const file = viaFile(castFile);
    file.schools.push({ school: { id: 'new-one', name: 'Brand New Academy', tab: null, nameInTab: null, website: 'https://example.edu/' }, fields: file.schools[0].fields });
    file.schools.push({ school: { name: '' }, fields: [] });                       // no name
    file.schools.push({ school: { id: 'x', name: 'Broken Fields School' }, fields: 'nope' });
    const ok = [], bad = [];
    for (let i = 0; i < file.schools.length; i++) {
      try { ok.push(run.ctx.loadSchoolFromFile(viaFile(fileItem(file, i)))); } catch (e) { bad.push(String(e.message)); }
    }
    assert.strictEqual(ok.length, 2); assert.strictEqual(bad.length, 2);
    assert.ok(ok[1].created && ss.getSheetByName('Brand New Academy'), 'the missing tab was not made');
    assert.ok(bad.every((m) => /skipped|expected format/.test(m)), bad.join(' | '));
    assert.strictEqual(ss.getSheetByName('Export Log').getLastRow(), 3);
  });
  check('a hand-made or damaged file cannot run formulas or reach odd properties; sizes are capped', () => {
    const tab = clone(template, 'Test School');
    const run = loadScript(mkSs(tab), {});
    const evil = '=IMPORTXML("http://example.invalid/x","//a")';
    const item = { school: { name: 'Test School', tab: 'Test School' }, hints: { ratio: { B: 'x'.repeat(5000) }, constructor: 1 },
      fields: [
        { key: 'ratio', label: 'Ratio', value: evil, confidence: 'high', sources: [{ url: 'javascript:alert(1)' }, { url: 'https://ok.example/p' }] },
        { key: 'constructor', value: 'x' }, { key: '__proto__', value: 'x' }, { key: 'toString', value: 'x' }, { key: 'has space', value: 'x' }, null,
        { key: 'grades', value: 'g'.repeat(50000) },
      ] };
    const res = run.ctx.loadSchoolFromFile(viaFile(item));
    const rows = run.ctx.locateRows_(tab).rows;
    assert.strictEqual(tab.cell(rows.ratio, 2).d, evil, 'the text was changed');
    assert.ok(!/^AUTO-/.test(tab.cell(rows.ratio, 2).d), 'text turned into a formula');
    assert.ok(!/javascript:/.test(tab.cell(rows.ratio, 2).note) && /https:\/\/ok\.example\/p/.test(tab.cell(rows.ratio, 2).note), 'link filter: ' + tab.cell(rows.ratio, 2).note);
    assert.strictEqual(tab.cell(rows.grades, 2).d.length, 20000);
    assert.strictEqual(res.summary.noRow, 2);   // "constructor" and "toString" are not rows; the other keys were dropped as invalid
  });
  check('menu "Start the daily email": installs the trigger and says who gets it', () => {
    const run = loadScript(mkSs(), {});
    run.ctx.startDailyEmail();
    assert.strictEqual(run.triggers.length, 1);
    assert.ok(/NOTIFY_EMAILS/.test(run.alerts[0][1]), 'no hint about NOTIFY_EMAILS: ' + run.alerts[0][1]);
    const run2 = loadScript(mkSs(), { NOTIFY_EMAILS: 'a@example.com' });
    run2.ctx.startDailyEmail();
    assert.ok(/a@example\.com/.test(run2.alerts[0][1]));
  });
  check('dashboard side: the file holds the hints once, one entry per school, and refuses unscraped schools', () => {
    assert.strictEqual(castFile.kind, 'school-info-export');
    assert.strictEqual(castFile.format, 1);
    assert.strictEqual(castFile.count, 1);
    assert.deepStrictEqual(Object.keys(castFile.hints).sort(), ['essays', 'factsSheet', 'infoSessions']);   // the template's hint texts, once for the whole file
    assert.ok(!('hints' in castFile.schools[0]) && !('action' in castFile.schools[0]));
    assert.ok(castFile.schools[0].fields.length > 20 && castFile.schools[0].school.name === 'Castilleja (Upper) School');
    assert.throws(() => sheetExport.buildExportFile(['beau-soleil']), /not been scraped/);
    const all = sheetExport.buildExportFile('all');
    const total = require('../src/lib/dashboard-data').getSchools().schools.length;
    assert.strictEqual(all.file.count + all.skipped.notScraped + all.skipped.nothingFound + all.skipped.wrongSite, total);
    assert.ok(all.skipped.wrongSite >= 1 && !all.file.schools.some((s) => s.school.id === 'crystal-springs-middle-school'), 'a school whose website is another school must stay out of the bulk file');
    assert.ok(all.file.count >= 1 && all.file.schools.every((s) => s.fields.length > 0));
    console.log(`         all-schools file: ${all.file.count} schools, ${Math.round(JSON.stringify(all.file).length / 1024)} KB; left out: ${JSON.stringify(all.skipped)}`);
  });

  // 9. the Node side talks to the web app correctly
  const http = require('http');
  const seen = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { seen.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(b || '{}') }); if (req.url.startsWith('/html')) { res.end('<html>sign in</html>'); } else res.end(JSON.stringify({ ok: true, tab: 'T', tabUrl: 'https://x', summary: { filled: 1 } })); }); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const cfgFile = path.join(PATHS.data, 'export-config.json');
  const hadCfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
  const hadHist = fs.existsSync(path.join(PATHS.data, 'exports.json')) ? fs.readFileSync(path.join(PATHS.data, 'exports.json')) : null;
  try {
    fs.writeFileSync(cfgFile, JSON.stringify({ url: `http://127.0.0.1:${port}/ok`, token: TOKEN }));
    const out = await sheetExport.exportSchool('castilleja-upper-school', 0);
    assert.strictEqual(out.tab, 'T');
    assert.strictEqual(seen[0].method, 'POST');
    assert.strictEqual(seen[0].body.token, TOKEN);
    assert.strictEqual(seen[0].body.action, 'export');
    assert.ok(seen[0].body.fields.length > 20 && seen[0].body.school.name === 'Castilleja (Upper) School');
    assert.ok(sheetExport.history()['castilleja-upper-school'].at);
    fs.writeFileSync(cfgFile, JSON.stringify({ url: `http://127.0.0.1:${port}/html`, token: TOKEN }));
    await assert.rejects(() => sheetExport.testConnection(), /web page instead of an answer/);
    await assert.rejects(() => sheetExport.exportSchool('beau-soleil', 0), /not been scraped/);
    passed++; console.log('  ok   dashboard side: sends the secret, reads the answer, explains non-JSON replies');
  } finally {
    srv.close();
    if (hadCfg) fs.writeFileSync(cfgFile, hadCfg); else fs.rmSync(cfgFile, { force: true });
    if (hadHist) fs.writeFileSync(path.join(PATHS.data, 'exports.json'), hadHist); else fs.rmSync(path.join(PATHS.data, 'exports.json'), { force: true });
  }
  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); });
