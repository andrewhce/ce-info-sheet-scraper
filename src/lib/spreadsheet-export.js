'use strict';
// Builds plain Excel (.xlsx) and CSV downloads of the scraper comparison data
// so non-technical reviewers can inspect and share findings without setting up Apps Script.
const ExcelJS = require('exceljs');
const data = require('./dashboard-data');
const { topReasons, LABEL: TRUST_LABEL } = require('./trust');

const VERDICT_TEXT = {
  fills: 'Website can fill your blank',
  differs: 'Different from your sheet',
  match: 'Same as your sheet',
  both: 'Both have an answer',
  'sheet-only': 'Only your sheet has it',
  none: 'Not found on the website',
  manual: 'Fill in by hand',
};

const CONF_TEXT = {
  high: 'Exact match',
  medium: 'Probable match',
  low: 'Please double-check',
};

const STATUS_GUIDANCE = {
  ok: ['Checked', 'Look at the answers'],
  'not-scraped': ['Not checked yet', 'Check this school’s website in the dashboard'],
  blocked: ['Website blocked us', 'Open the website yourself: it stops automatic readers'],
  thin: ['Nothing readable', 'Open the website yourself: the dashboard cannot read how it shows its text'],
  robots: ['Website asks not to be read', 'Open the website yourself: it asks automatic programs to stay away'],
  error: ['Website would not open', 'Check that the website link in your sheet still works'],
  'no-website': ['No website link', 'Add the school’s website link to your sheet'],
};

class SpreadsheetExportError extends Error {}

/** Neutralize spreadsheet formula triggers in CSV text cells (CWE-1236). */
function csvSafe(val) {
  let s = String(val == null ? '' : val);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function sheetJoin(row) {
  return (row.sheet || [])
    .map((c) => (c.text || c.link || '').trim())
    .filter(Boolean)
    .join(' | ');
}

function firstSource(sc) {
  const src = (sc && sc.sources || []).find((s) => /^https?:\/\//i.test(s.url));
  return src ? src.url : '';
}

function safeTabName(name, fallback = 'Sheet') {
  const cleaned = String(name || fallback).replace(/[\\/*?:[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  return cleaned || fallback;
}

function statusAction(s) {
  const base = STATUS_GUIDANCE[s.status] || [s.status || 'Unknown', ''];
  if (s.wrongSite) return ['Check website link', 'The website may belong to a different school: check the link in your sheet first'];
  if (s.status === 'ok') {
    const notes = [];
    if (s.changesCount > 0) notes.push(`${s.changesCount} website update${s.changesCount === 1 ? '' : 's'} detected`);
    if (s.fills > 0) notes.push(`${s.fills} blanks to fill`);
    if (s.differs > 0) notes.push(`${s.differs} differs`);
    return [s.changesCount > 0 ? 'Website updated' : base[0], notes.length ? notes.join(', ') : 'Up to date'];
  }
  return base;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: 'FF1D1B18' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECE8DF' } };
  row.alignment = { vertical: 'middle', wrapText: true };
}

const VERDICT_FILL = {
  fills: 'FFE2EEFB',
  differs: 'FFFCE5CD',
  match: 'FFE3F3EA',
};

function resolveSchools(ov, { all = false, ids = [], status = '' } = {}) {
  let schools = ov.schools;
  if (!all && ids.length) {
    const wanted = new Set(ids);
    schools = schools.filter((s) => wanted.has(s.id));
    if (schools.length !== wanted.size) throw new SpreadsheetExportError('One or more selected schools were not found.');
  }
  if (status === 'problem') schools = schools.filter((s) => !['ok', 'not-scraped'].includes(s.status) || s.wrongSite);
  else if (status === 'updated') schools = schools.filter((s) => s.changesCount > 0);
  else if (status === 'fills') schools = schools.filter((s) => s.fills > 0);
  else if (status === 'differs') schools = schools.filter((s) => s.differs > 0);
  else if (status) schools = schools.filter((s) => s.status === status);
  if (!schools.length) throw new SpreadsheetExportError('No schools match what you selected to export.');
  return schools;
}

function collectFindingRows(schools, { single = false, tabIndex = 0 } = {}) {
  const rows = [];
  for (const s of schools) {
    const p = data.schoolPayload(s.id, single ? tabIndex : 0);
    if (!p) continue;
    const scrapedOk = p.result && p.result.status === 'ok';
    if (!single && !scrapedOk) {
      const [statusText, nextStep] = statusAction(s);
      rows.push({
        school: p.school.name,
        tier: p.school.tier == null ? '' : p.school.tier,
        section: 'Status',
        label: 'Website Check',
        sheetVal: '',
        webVal: p.result && p.result.detail ? p.result.detail : nextStep,
        verdict: 'manual',
        verdictText: statusText,
        confidence: '',
        sourceUrl: p.school.website || '',
        quote: '',
        note: nextStep,
      });
      continue;
    }
    for (const r of p.rows) {
      if (r.kind !== 'field') continue;
      const sc = r.scraped;
      const hasFound = sc && sc.status === 'found';
      if (!single && !hasFound && r.verdict !== 'differs' && r.verdict !== 'fills') continue;
      const src = firstSource(sc);
      rows.push({
        school: p.school.name,
        tier: p.school.tier == null ? '' : p.school.tier,
        section: r.section || '',
        label: r.label.replace(/:$/, ''),
        sheetVal: sheetJoin(r),
        webVal: hasFound ? sc.value : (sc && sc.note ? sc.note : ''),
        verdict: r.verdict,
        verdictText: VERDICT_TEXT[r.verdict] || r.verdict,
        // key facts carry the trust score ("Ready to use (99)"); copied text sections keep the scraper's own mark
        confidence: hasFound ? (r.trust ? `${TRUST_LABEL[r.trust.level]} (${r.trust.score}/100)` : (CONF_TEXT[sc.confidence] || sc.confidence || '')) : '',
        sourceUrl: src,
        quote: hasFound && sc.snippet ? sc.snippet : '',
        note: hasFound ? [sc.note, r.trust && r.trust.triage !== 'ready' ? 'Why it needs a look: ' + topReasons(r.trust, 2).join('; ') + '.' : ''].filter(Boolean).join(' ') : '',
      });
    }
  }
  return rows;
}

/**
 * Generates an Excel (.xlsx) or CSV buffer for either a single school or multiple schools.
 * Returns { buffer, filename, contentType, count }.
 */
async function buildSpreadsheet({ format = 'xlsx', all = false, ids = [], status = '', tabIndex = 0 } = {}) {
  const fmt = String(format || 'xlsx').toLowerCase();
  if (fmt !== 'xlsx' && fmt !== 'csv') throw new SpreadsheetExportError('Format must be xlsx or csv.');
  const ov = data.overview();
  if (!ov || !ov.ready) throw new SpreadsheetExportError('Load your School Information Sheet first.');

  const schools = resolveSchools(ov, { all, ids, status });
  const single = !all && schools.length === 1;
  const findings = collectFindingRows(schools, { single, tabIndex });
  const day = new Date().toISOString().slice(0, 10);
  const baseName = single
    ? `school-info-${String(schools[0].id).replace(/[^a-z0-9-]+/gi, '-').slice(0, 60)}`
    : `school-info-${schools.length}-schools-${day}`;

  if (fmt === 'csv') {
    const header = single
      ? ['Section', 'Question', 'What Your Sheet Says', 'What the Website Says', 'How They Compare', 'Rating (out of 100)', 'Page It Came From', 'Words From the Page', 'Notes']
      : ['School', 'Tier', 'Section', 'Question', 'What Your Sheet Says', 'What the Website Says', 'How They Compare', 'Rating (out of 100)', 'Page It Came From', 'Words From the Page'];
    const lines = [header.map(csvSafe).join(',')];
    for (const f of findings) {
      const cols = single
        ? [f.section, f.label, f.sheetVal, f.webVal, f.verdictText, f.confidence, f.sourceUrl, f.quote, f.note]
        : [f.school, f.tier, f.section, f.label, f.sheetVal, f.webVal, f.verdictText, f.confidence, f.sourceUrl, f.quote];
      lines.push(cols.map(csvSafe).join(','));
    }
    return {
      buffer: Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8'),
      filename: `${baseName}.csv`,
      contentType: 'text/csv; charset=utf-8',
      count: schools.length,
    };
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'School Info Sheet';
  wb.created = new Date();

  if (!single) {
    const ovSheet = wb.addWorksheet('Schools Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
    ovSheet.columns = [
      { header: 'School', key: 'name', width: 32 },
      { header: 'Tier', key: 'tier', width: 8 },
      { header: 'Region', key: 'region', width: 20 },
      { header: 'Status', key: 'statusText', width: 20 },
      { header: 'What To Do Next', key: 'nextStep', width: 42 },
      { header: 'Answers Found', key: 'found', width: 14 },
      { header: 'Blanks It Can Fill', key: 'fills', width: 18 },
      { header: 'Different From Your Sheet', key: 'differs', width: 18 },
      { header: 'Last Checked', key: 'scraped', width: 14 },
      { header: 'Website', key: 'website', width: 34 },
    ];
    styleHeader(ovSheet.getRow(1));
    ovSheet.autoFilter = { from: 'A1', to: 'J1' };
    for (const s of schools) {
      const [statusText, nextStep] = statusAction(s);
      const row = ovSheet.addRow({
        name: s.name,
        tier: s.tier == null ? '' : s.tier,
        region: s.region || '',
        statusText,
        nextStep,
        found: s.status === 'ok' ? (s.found || 0) : '',
        fills: s.status === 'ok' ? (s.fills || 0) : '',
        differs: s.status === 'ok' ? (s.differs || 0) : '',
        scraped: s.scrapedAt ? s.scrapedAt.slice(0, 10) : '',
        website: s.website || '',
      });
      row.alignment = { vertical: 'top', wrapText: true };
      if (/^https?:\/\//i.test(s.website || '')) {
        row.getCell('website').value = { text: s.website, hyperlink: s.website };
        row.getCell('website').font = { color: { argb: 'FF1D5FA8' }, underline: true };
      }
    }
  }

  const wsName = single ? safeTabName(schools[0].name, 'School') : 'Website Answers';
  const ws = wb.addWorksheet(wsName, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = single ? [
    { header: 'Section', key: 'section', width: 22 },
    { header: 'Question', key: 'label', width: 28 },
    { header: 'What Your Sheet Says', key: 'sheetVal', width: 34 },
    { header: 'What the Website Says', key: 'webVal', width: 38 },
    { header: 'How They Compare', key: 'verdictText', width: 20 },
    { header: 'Rating (out of 100)', key: 'Trust', width: 22 },
    { header: 'Page It Came From', key: 'sourceUrl', width: 34 },
    { header: 'Words From the Page', key: 'quote', width: 42 },
    { header: 'Notes', key: 'note', width: 28 },
  ] : [
    { header: 'School', key: 'school', width: 30 },
    { header: 'Tier', key: 'tier', width: 8 },
    { header: 'Section', key: 'section', width: 20 },
    { header: 'Question', key: 'label', width: 26 },
    { header: 'What Your Sheet Says', key: 'sheetVal', width: 32 },
    { header: 'What the Website Says', key: 'webVal', width: 36 },
    { header: 'How They Compare', key: 'verdictText', width: 20 },
    { header: 'Rating (out of 100)', key: 'Trust', width: 22 },
    { header: 'Page It Came From', key: 'sourceUrl', width: 34 },
    { header: 'Words From the Page', key: 'quote', width: 40 },
  ];
  styleHeader(ws.getRow(1));
  ws.autoFilter = { from: 'A1', to: single ? 'I1' : 'J1' };

  for (const f of findings) {
    const row = ws.addRow(f);
    row.alignment = { vertical: 'top', wrapText: true };
    const color = VERDICT_FILL[f.verdict];
    if (color) row.getCell('verdictText').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    if (/^https?:\/\//i.test(f.sourceUrl)) {
      row.getCell('sourceUrl').value = { text: f.sourceUrl, hyperlink: f.sourceUrl };
      row.getCell('sourceUrl').font = { color: { argb: 'FF1D5FA8' }, underline: true };
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(out),
    filename: `${baseName}.xlsx`,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    count: schools.length,
  };
}

module.exports = { buildSpreadsheet, SpreadsheetExportError, csvSafe, VERDICT_TEXT, CONF_TEXT, STATUS_GUIDANCE };
