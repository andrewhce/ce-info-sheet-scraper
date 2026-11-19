'use strict';
// Reads the School Information Sheet workbook (read-only, never written to) and saves:
//   data/template.json   the Master Template rows, in order, with field keys
//   data/schools.json    the PSTP Schools list (tier, name, region, website, portal ...)
//   data/sheet/<id>.json what each school's existing tab already says, per template field
//
// Usage:  node src/import-workbook.js ["path/to/workbook.xlsx"]
const fs = require('fs');
const path = require('path');
const { loadWorkbookLean } = require('./lib/xlsx-lean');
const { PATHS, loadConfig, resolveWorkbook, readJson, writeJson, slug, alnum, squash } = require('./lib/util');
const { keyRows } = require('./lib/template');
const { mergeAdded } = require('./lib/school-list');

function cellText(cell) {
  let v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object' && !(v instanceof Date)) {
    if (v.formula != null || v.sharedFormula != null) v = v.result;
    else if (v.richText) return v.richText.map((r) => r.text).join('');
    else if (v.text != null) v = v.text;
    else if (v.error) return '';
    if (v == null) return '';
    if (typeof v === 'object' && !(v instanceof Date)) {
      if (v.richText) return v.richText.map((r) => r.text).join('');
      if (v.error) return '';
      return String(v);
    }
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') {
    if ((cell.numFmt || '').includes('%')) return (Math.round(v * 10000) / 100) + '%';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }
  return String(v);
}

function cellLink(cell) {
  const v = cell.value;
  const link = (v && typeof v === 'object' && v.hyperlink) || cell.hyperlink || null;
  return link && /^https?:/i.test(link) ? link : null;
}

function isFormula(cell) {
  const v = cell.value;
  return !!(v && typeof v === 'object' && (v.formula != null || v.sharedFormula != null));
}

function divisionOf(name) {
  const n = name.toLowerCase();
  if (/\blower\b|elementary|preschool|junior school/.test(n)) return 'lower';
  if (/\bmiddle\b/.test(n)) return 'middle';
  if (/\bupper\b|\(high\)|high school/.test(n)) return 'upper';
  return null;
}

/** "6-8" -> middle, "9-12" -> upper, "K-5" -> lower; null when the range spans divisions. */
function divisionFromGrades(text) {
  if (!text) return null;
  const nums = (text.match(/\b(1[0-2]|[1-9])\b/g) || []).map(Number);
  if (/\b(pre-?k|pk|tk|jk|k|kindergarten)\b/i.test(text)) nums.push(0);
  if (!nums.length) return null;
  const min = Math.min(...nums), max = Math.max(...nums);
  if (max <= 5) return 'lower';
  if (min >= 5 && max <= 8) return 'middle';
  if (min >= 9) return 'upper';
  return null;
}

/** Everything a school tab already holds, keyed by template field. */
function readTab(ws) {
  const labels = [];
  for (let r = 1; r <= 80; r++) {
    const label = cellText(ws.getCell(r, 1));
    if (label.trim()) labels.push({ row: r, label });
  }
  const values = {};
  for (const f of keyRows(labels)) {
    if (f.kind !== 'field') continue;
    const cols = [];
    for (const [c, letter] of [[2, 'B'], [3, 'C'], [4, 'D'], [5, 'E']]) {
      const cell = ws.getCell(f.row, c);
      if (c >= 4 && isFormula(cell)) continue; // column D holds =PROPER() helper formulas
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) continue; // merged cell repeats column A
      const text = squash(cellText(cell));
      const link = cellLink(cell);
      if (text || link) cols.push({ col: letter, text, link: link || undefined });
    }
    if (cols.length && !values[f.key]) values[f.key] = { row: f.row, label: String(f.label).trim(), cols };
  }
  // the unlabeled header row that names the two columns of the Guide section, when present
  let guideCols = null;
  for (let r = 20; r <= 40; r++) {
    if (cellText(ws.getCell(r, 1)).trim()) continue;
    const b = squash(cellText(ws.getCell(r, 2))), c = squash(cellText(ws.getCell(r, 3)));
    if (b && c && b.length < 40 && c.length < 40) { guideCols = { B: b, C: c }; break; }
  }
  return { values, guideCols };
}

async function main() {
  const cfg = loadConfig();
  const file = process.argv[2] || resolveWorkbook(cfg);
  if (!file || !fs.existsSync(file)) {
    console.error('No workbook found' + (file ? ': ' + file : '') + '.\nOpen the dashboard, go to Start here and choose your School Information Sheet (.xlsx).');
    process.exit(1);
  }
  console.log('Reading ' + file + ' ...');
  // Only the first rows and columns of each tab are ever read, so the rest is cut away before loading
  // (the whole workbook would need about 3 GB of memory). The two tabs below are read differently.
  const wb = await loadWorkbookLean(file, {
    [cfg.listTab]: { rows: Infinity, cols: 8 },                 // the PSTP Schools list: every row, columns A to H
    'Priority List': { rows: 1, cols: 1 }, 'Copy of Master Template': { rows: 1, cols: 1 }, // never read
  });
  // check before anything is written, so a wrong file leaves the saved data untouched
  for (const tab of [cfg.templateTab, cfg.listTab]) {
    if (!wb.getWorksheet(tab)) { console.error(`This workbook has no tab called "${tab}".`); process.exit(1); }
  }

  // ---- template ----
  const tws = wb.getWorksheet(cfg.templateTab);
  if (!tws) throw new Error('Tab not found: ' + cfg.templateTab);
  const labels = [];
  for (let r = 1; r <= 80; r++) {
    const label = cellText(tws.getCell(r, 1));
    // a cell merged into column A repeats column A's text; that is not a hint
    const own = (c) => { const cell = tws.getCell(r, c); return cell.isMerged && cell.master && cell.master.address !== cell.address ? '' : cellText(cell).trim(); };
    if (label.trim()) labels.push({ row: r, label, hintB: own(2), hintC: own(3) });
  }
  const rows = keyRows(labels).map((f) => {
    const src = labels.find((l) => l.row === f.row);
    return { ...f, label: String(f.label).trim(), hintB: src.hintB || undefined, hintC: src.hintC || undefined };
  });
  writeJson(PATHS.template, { importedAt: new Date().toISOString(), workbook: file, tab: cfg.templateTab, rows });

  // ---- school list ----
  const lws = wb.getWorksheet(cfg.listTab);
  if (!lws) throw new Error('Tab not found: ' + cfg.listTab);
  const schools = [];
  const usedIds = new Set();
  for (let r = 2; r <= lws.rowCount; r++) {
    const name = squash(cellText(lws.getCell(r, 2))).replace(/\n/g, ' ');
    if (!name) continue;
    let id = slug(name);
    while (usedIds.has(id)) id += '-2';
    usedIds.add(id);
    const tierRaw = cellText(lws.getCell(r, 1)).trim();
    schools.push({
      id, row: r, name,
      tier: /^\d/.test(tierRaw) ? Number(tierRaw) : null,
      region: squash(cellText(lws.getCell(r, 3))).replace(/\n/g, ' ') || null,
      website: cellLink(lws.getCell(r, 4)),
      portal: cellLink(lws.getCell(r, 5)),
      portalLabel: squash(cellText(lws.getCell(r, 5))) || null,
      appOpen: squash(cellText(lws.getCell(r, 6))) || null,
      division: divisionOf(name),
      tabs: [],
    });
  }

  // ---- match each school to its existing tab(s) ----
  const skip = new Set([cfg.templateTab, cfg.listTab, 'Copy of Master Template', 'Priority List']);
  const strip = (s) => alnum(s).replace(/^the/, '');
  const tokens = (s) => new Set(String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ'’]/g, '')
    .split(/[^a-z0-9]+/).filter((t) => t && t !== 'the'));
  const sameTokens = (a, b) => a.size === b.size && [...a].every((t) => b.has(t));
  const tabs = wb.worksheets.filter((ws) => !skip.has(ws.name)).map((ws) => {
    const data = readTab(ws);
    const grades = data.values.grades ? data.values.grades.cols.map((c) => c.text).join(' ') : '';
    return {
      title: ws.name, isGeneric: /^sheet\d+$/i.test(ws.name), ...data,
      b1: squash(cellText(ws.getCell(1, 2))), c1: cellLink(ws.getCell(1, 3)),
      division: divisionOf(ws.name) || divisionFromGrades(grades), school: null, how: null,
    };
  });
  const free = () => schools.filter((s) => !s.tabs.length);
  const assign = (school, tab, how) => { school.tabs.push(tab.title); tab.school = school; tab.how = how; };
  const disambiguate = (tab, cands) => {
    if (tab.b1.includes('|')) {
      const suffix = strip(tab.b1.split('|').pop());
      const hit = cands.filter((s) => suffix && strip(s.name).endsWith(suffix));
      if (hit.length === 1) return [hit[0], 'name in the tab'];
    }
    if (tab.division) {
      const hit = cands.filter((s) => s.division === tab.division);
      if (hit.length === 1) return [hit[0], 'grade range in the tab'];
    }
    return [cands[0], 'tab order'];
  };

  // 1. tab title is exactly the school name
  for (const tab of tabs) {
    if (tab.isGeneric) continue;
    const hit = free().filter((s) => strip(s.name) === strip(tab.title));
    if (hit.length === 1) assign(hit[0], tab, 'exact');
  }
  // 2. tab title is the school name cut to Excel's 31 characters; "SheetNN" tabs are the
  //    duplicates Google Sheets could not name, and sit right after the tab they duplicate
  let lastPrefix = null;
  for (const tab of tabs) {
    if (tab.school) { lastPrefix = strip(tab.title); continue; }
    const prefix = tab.isGeneric ? lastPrefix : strip(tab.title);
    if (!tab.isGeneric) lastPrefix = prefix;
    if (!prefix) continue;
    const cands = free().filter((s) => strip(s.name).startsWith(prefix));
    if (cands.length === 1) assign(cands[0], tab, tab.isGeneric ? 'tab order' : 'exact');
    else if (cands.length > 1) { const [s, how] = disambiguate(tab, cands); assign(s, tab, how); }
  }
  // 3. same words in a different order ("Georgetown Day School (Middle)" / "Georgetown Day Middle School")
  for (const tab of tabs) {
    if (tab.school || tab.isGeneric) continue;
    const hit = free().filter((s) => sameTokens(tokens(s.name), tokens(tab.title)));
    if (hit.length === 1) assign(hit[0], tab, 'same words');
  }
  // 4. a list row without a division can own several division tabs ("Marlborough School")
  for (const tab of tabs) {
    if (tab.school || !tab.b1) continue;
    const hit = schools.filter((s) => strip(s.name) === strip(tab.b1) && !s.division);
    if (hit.length === 1) assign(hit[0], tab, 'name in the tab');
  }

  // ---- save existing tab values ----
  const prevData = readJson(PATHS.schools, null);
  const migrated = [];
  if (prevData && Array.isArray(prevData.schools) && fs.existsSync(PATHS.resultsDir)) {
    const prevById = new Map(prevData.schools.map((x) => [x.id, x]));
    const newIds = new Set(schools.map((x) => x.id));
    const normUrl = (u) => {
      if (!u) return '';
      try { const x = new URL(u); return x.hostname.replace(/^www\./i, '').toLowerCase() + x.pathname.replace(/\/+$/, '').toLowerCase(); } catch { return ''; }
    };
    const oldOrphans = prevData.schools.filter((oldS) => !newIds.has(oldS.id) && fs.existsSync(path.join(PATHS.resultsDir, oldS.id + '.json')));
    for (const s of schools) {
      const targetRes = path.join(PATHS.resultsDir, s.id + '.json');
      if (prevById.has(s.id) || fs.existsSync(targetRes)) continue;
      const sUrl = normUrl(s.website);
      const sTabs = new Set(s.tabs.map((t) => strip(t)));
      const match = oldOrphans.find((o) =>
        (sUrl && normUrl(o.website) === sUrl) ||
        (Array.isArray(o.tabs) && o.tabs.some((t) => sTabs.has(strip(t)))) ||
        sameTokens(tokens(o.name), tokens(s.name))
      );
      if (!match) continue;
      const oldFile = path.join(PATHS.resultsDir, match.id + '.json');
      const prevRes = readJson(oldFile, null);
      if (prevRes) {
        writeJson(targetRes, { ...prevRes, id: s.id, name: s.name });
        migrated.push(`${match.name} -> ${s.name}`);
      }
    }
  }

  fs.rmSync(PATHS.sheetDir, { recursive: true, force: true });
  for (const s of schools) {
    const mine = tabs.filter((t) => t.school === s);
    if (!mine.length) continue;
    // a list row with no website link can still take the link from its own tab
    if (!s.website && mine[0].c1) { s.website = mine[0].c1; s.websiteFromTab = true; }
    writeJson(`${PATHS.sheetDir}/${s.id}.json`, {
      id: s.id,
      tabs: mine.map((t) => ({
        tab: t.title, matchedBy: t.how, nameInTab: t.b1 || null, websiteInTab: t.c1 || null,
        guideCols: t.guideCols, values: t.values,
      })),
    });
  }
  // schools added by hand (Schools page, "Add a school") stay on the list unless the sheet now lists them itself
  const withAdded = mergeAdded(schools);
  writeJson(PATHS.schools, { importedAt: new Date().toISOString(), workbook: file, schools: withAdded.schools });
  if (withAdded.kept) console.log(`Schools added by hand and kept: ${withAdded.kept}`);

  const noTab = schools.filter((s) => !s.tabs.length);
  const orphan = tabs.filter((t) => !t.school);
  const soft = tabs.filter((t) => t.school && t.how !== 'exact');
  console.log(`Template rows: ${rows.length} (${rows.filter((r) => r.kind === 'field').length} fields)`);
  console.log(`Schools in "${cfg.listTab}": ${schools.length}  | with website: ${schools.filter((s) => s.website).length}`);
  console.log(`Existing tabs matched: ${tabs.length - orphan.length} of ${tabs.length}`);
  if (migrated.length) console.log('\nPreserved scrape results for renamed schools:\n' + migrated.map((m) => '  ' + m).join('\n'));
  if (soft.length) console.log('\nMatched by something other than the exact title:\n' + soft.map((t) => `  ${t.title} -> ${t.school.name}  (${t.how})`).join('\n'));
  if (noTab.length) console.log('\nSchools with no tab yet:\n' + noTab.map((s) => '  ' + s.name).join('\n'));
  if (orphan.length) console.log('\nTabs not in the list (ignored):\n' + orphan.map((t) => `  ${t.title}  [B1: ${t.b1}]`).join('\n'));
  const noRule = rows.filter((r) => r.kind === 'field' && !r.hasRule);
  if (noRule.length) console.log('\nTemplate rows with no scraping rule: ' + noRule.map((r) => r.label).join(' ; '));
}

main().catch((e) => { console.error(e); process.exit(1); });
