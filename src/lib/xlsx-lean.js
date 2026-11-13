'use strict';
// Loads a big Excel workbook without holding every cell in memory.
//
// The School Information Sheet has about 300 tabs of 1,000 rows by 26 columns (164 MB once unpacked), but the program
// only reads the first ~80 rows and 5 columns of each school tab. Loading it whole takes about 3 GB of memory. This
// cuts every tab down to the part that is read (rewriting the file in memory, never on disk), then loads that small
// workbook with ExcelJS as usual, so cell values, links, merged cells and number formats come out exactly the same.
const fs = require('fs');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const DEFAULT_LIMIT = { rows: 80, cols: 5 };

const decodeXml = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function colNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** Keeps rows 1..rows and columns A..cols of one worksheet's XML; drops parts that only add weight. */
function trimSheetXml(xml, { rows, cols }) {
  const open = /<sheetData\b[^>]*>/.exec(xml);
  if (!open || open[0].endsWith('/>')) return xml;
  const start = open.index + open[0].length;
  const end = xml.indexOf('</sheetData>', start);
  if (end < 0) return xml;
  const body = xml.slice(start, end);

  let kept = '';
  const rowRe = /<row\b[^>]*\/>|<row\b[^>]*>[\s\S]*?<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(body))) {
    const rowXml = rm[0];
    const tagEnd = rowXml.indexOf('>') + 1;
    const head = rowXml.slice(0, tagEnd);
    const rn = Number((/\br="(\d+)"/.exec(head) || [])[1]);
    if (rn && rn > rows) continue;
    if (head.endsWith('/>')) { kept += rowXml; continue; }
    const inner = rowXml.slice(tagEnd, rowXml.length - '</row>'.length);
    let cells = '';
    const cellRe = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(inner))) {
      const ref = /\br="([A-Z]+)\d+"/.exec(cm[0].slice(0, 120));
      if (!ref || colNumber(ref[1]) <= cols) cells += cm[0];
    }
    kept += head + cells + '</row>';
  }

  let before = xml.slice(0, start);
  let after = xml.slice(end);
  // drop things the program never reads: they can be large and ExcelJS expands them cell by cell
  after = after.replace(/<dataValidations\b[\s\S]*?<\/dataValidations>/g, '')
    .replace(/<conditionalFormatting\b[\s\S]*?<\/conditionalFormatting>/g, '');
  // keep only merged ranges that lie inside the part that was kept
  after = after.replace(/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/, (_, inner) => {
    const keep = (inner.match(/<mergeCell\b[^>]*\/>/g) || []).filter((tag) => {
      const m = /ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/.exec(tag);
      return m && Number(m[4]) <= rows && colNumber(m[3]) <= cols;
    });
    return keep.length ? `<mergeCells count="${keep.length}">${keep.join('')}</mergeCells>` : '';
  });
  return before + kept + after;
}

/**
 * Reads a workbook and returns an ExcelJS Workbook that holds only the needed part of each tab.
 * limits: { "Tab name": { rows, cols } } overrides the default of 80 rows by 5 columns for that tab.
 */
async function loadWorkbookLean(file, limits = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const read = async (name) => { const f = zip.file(name); return f ? f.async('string') : null; };
  const wbXml = await read('xl/workbook.xml');
  const relsXml = await read('xl/_rels/workbook.xml.rels');
  if (!wbXml || !relsXml) throw new Error('This does not look like an Excel workbook.');

  const targets = {};
  for (const tag of relsXml.match(/<Relationship\b[^>]*\/>/g) || []) {
    const id = (/\bId="([^"]+)"/.exec(tag) || [])[1], target = (/\bTarget="([^"]+)"/.exec(tag) || [])[1];
    if (id && target) targets[id] = target;
  }
  for (const tag of wbXml.match(/<sheet\b[^>]*\/>/g) || []) {
    const name = decodeXml((/\bname="([^"]*)"/.exec(tag) || [])[1] || '');
    const rid = (/\br:id="([^"]+)"/.exec(tag) || [])[1];
    const target = targets[rid];
    if (!target) continue;
    const entry = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const xml = await read(entry);
    if (xml == null) continue;
    const limit = { ...DEFAULT_LIMIT, ...(limits[name] || {}) };
    zip.file(entry, trimSheetXml(xml, limit));
  }
  const small = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(small);
  return wb;
}

module.exports = { loadWorkbookLean, trimSheetXml, DEFAULT_LIMIT };
