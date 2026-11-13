'use strict';
// Checks that the lean workbook loader gives the same cell values, links, merged cells and number formats as a full load
// for the part of each tab that is kept, and that it really drops what is outside it.
//   node tests/xlsx-lean.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const { loadWorkbookLean } = require('../src/lib/xlsx-lean');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-test-'));
  const file = path.join(tmp, 'sample.xlsx');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('School & "Co" (Upper)');
  for (let r = 1; r <= 300; r++) for (let c = 1; c <= 12; c++) ws.getCell(r, c).value = r * 100 + c;
  ws.getCell('A1').value = 'School Name';
  ws.getCell('B1').value = 'Café – Façade <b>&</b>';
  ws.getCell('C1').value = { text: 'Website Link', hyperlink: 'https://example.edu/a?x=1&y=2' };
  ws.getCell('B2').value = new Date(Date.UTC(2026, 8, 1)); ws.getCell('B2').numFmt = 'yyyy-mm-dd';
  ws.getCell('B3').value = 0.9; ws.getCell('B3').numFmt = '0%';
  ws.getCell('B4').value = { richText: [{ text: 'Bold ' , font: { bold: true } }, { text: 'and plain' }] };
  ws.getCell('B5').value = { formula: 'B3*2', result: 1.8 };
  ws.getCell('D5').value = { formula: 'PROPER(B6)', result: 'Proper Text' };
  ws.getCell('B6').value = 'line one\nline two';
  ws.getCell('F7').value = 'outside the kept columns';
  ws.getCell('A90').value = 'outside the kept rows';
  ws.mergeCells('A8:B8'); ws.getCell('A8').value = 'merged label';
  ws.mergeCells('A100:K150');                       // a big merge outside the kept part
  ws.getCell('E10').dataValidation = { type: 'list', allowBlank: true, formulae: ['"a,b,c"'] };
  ws.addConditionalFormatting({ ref: 'B1:B200', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: [5] }] });
  const other = wb.addWorksheet('Ignored list');
  for (let r = 1; r <= 400; r++) other.getCell(r, 1).value = 'row ' + r;
  await wb.xlsx.writeFile(file);

  const full = new ExcelJS.Workbook();
  await full.xlsx.readFile(file);
  const lean = await loadWorkbookLean(file, { 'Ignored list': { rows: 1, cols: 1 } });
  const a = full.getWorksheet('School & "Co" (Upper)'), b = lean.getWorksheet('School & "Co" (Upper)');
  assert.ok(b, 'the tab name with & and quotes was not found');
  assert.strictEqual(lean.worksheets.length, 2);

  // everything inside rows 1-80 and columns A-E is identical
  let compared = 0;
  for (let r = 1; r <= 80; r++) for (let c = 1; c <= 5; c++) {
    const x = a.getCell(r, c), y = b.getCell(r, c);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(y.value)), JSON.parse(JSON.stringify(x.value)), `value at ${x.address}`);
    assert.strictEqual(y.numFmt, x.numFmt, `format at ${x.address}`);
    assert.strictEqual(y.isMerged, x.isMerged, `merged at ${x.address}`);
    assert.strictEqual(y.text, x.text, `text at ${x.address}`);
    compared++;
  }
  assert.strictEqual(b.getCell('C1').value.hyperlink, 'https://example.edu/a?x=1&y=2');
  assert.strictEqual(b.getCell('B3').numFmt, '0%');
  assert.strictEqual(b.getCell('B6').value, 'line one\nline two');
  assert.strictEqual(b.getCell('B8').isMerged, true);
  console.log(`  ok   ${compared} cells identical, including text, dates, percent, rich text, formulas, a link and a merged cell`);

  // what is outside is gone
  assert.strictEqual(b.getCell('F7').value, null);
  assert.strictEqual(b.getCell('A90').value, null);
  assert.strictEqual(b.getCell('A120').isMerged, false);
  assert.ok(!b.getCell('E10').dataValidation || !b.getCell('E10').dataValidation.type, 'a data validation was kept');
  assert.strictEqual(lean.getWorksheet('Ignored list').getCell('A2').value, null);
  assert.strictEqual(lean.getWorksheet('Ignored list').getCell('A1').value, 'row 1');
  console.log('  ok   rows, columns, big merged ranges and dropdowns outside the kept part are gone');

  // a file that is not a workbook is refused clearly
  fs.writeFileSync(path.join(tmp, 'bad.xlsx'), 'not a zip');
  await assert.rejects(() => loadWorkbookLean(path.join(tmp, 'bad.xlsx')));
  console.log('  ok   a file that is not an Excel workbook is refused');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n3 checks passed.');
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
