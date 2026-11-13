'use strict';
// Side-by-side comparison: what the existing school tab says vs. what the scrape found.
// The verdict is deliberately cautious. "differs" is only claimed for values that can be
// compared exactly (numbers, dates, an address). Free text is just shown side by side.
const { oneLine } = require('./util');

const NUMERIC = new Set(['enrollment', 'classSize', 'facultyDegrees', 'collegeEnrollment', 'tuition', 'counselors']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function numbersIn(text) {
  // "$33, 750" (a stray space after the comma in a typed cell) is still 33,750
  const tidy = String(text).replace(/(\$\s?\d{1,3}),\s+(\d{3})(?!\d)/g, '$1,$2');
  return (tidy.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, ''))).filter((n) => !isNaN(n));
}

/** { m, d, y } for "2026-09-01", "September 1, 2026", "Sept. 1" ... */
function datesIn(text) {
  const out = [];
  let m;
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) out.push({ y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) });
  const long = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/gi;
  while ((m = long.exec(text))) out.push({ y: m[3] ? Number(m[3]) : null, m: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), d: Number(m[2]) });
  // month only: "September 2026", "in October"
  const monthOnly = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:\s+(20\d{2}))?(?!\s*\d)/gi;
  if (!out.length) while ((m = monthOnly.exec(text))) out.push({ y: m[2] ? Number(m[2]) : null, m: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()), d: null });
  return out;
}

/** Text of the existing tab for one field, ignoring cells that still hold the template's placeholder words. */
function sheetCells(entry, templateRow) {
  if (!entry) return [];
  const hints = [templateRow && templateRow.hintB, templateRow && templateRow.hintC].filter(Boolean).map((h) => oneLine(h).toLowerCase());
  return entry.cols.filter((c) => {
    const t = oneLine(c.text).toLowerCase();
    if (!t && !c.link) return false;
    if (hints.includes(t) && !c.link) return false;
    if (/^(unknown|n\/a|na|tbd|-|none)$/i.test(t)) return false;
    return true;
  });
}

/**
 * "More than 1,800", "Nearly 6,000", "Approximately 365": the school's own hedge word turns one number into a range,
 * and a sheet value inside that range agrees with it ("1,823" agrees with "more than 1,800"). null when there is no hedge word.
 */
function qualifiedRange(value, num) {
  const m = /^(?:(more than|over|at least|just over|nearly|almost|just under|under|fewer than|up to|approximately|about|around|roughly)\b|~)/i.exec(String(value).trim());
  if (!m || num == null) return null;
  const q = (m[1] || '~').toLowerCase();
  if (/more than|over|at least|just over/.test(q)) return [num, num * 1.25];
  if (/nearly|almost|under|fewer than|up to/.test(q)) return [num * 0.8, num];
  return [num * 0.95, num * 1.05];
}

function compareField(key, cells, scraped) {
  const hasSheet = cells.length > 0;
  const found = !!scraped && scraped.status === 'found';
  if (scraped && scraped.status === 'manual') return hasSheet ? 'sheet-only' : 'manual';
  if (!hasSheet && !found) return 'none';
  if (!hasSheet) return 'fills';
  if (!found) return 'sheet-only';
  const sheet = cells.map((c) => c.text).join('\n');
  const value = String(scraped.value || '');

  if (NUMERIC.has(key) && scraped.num != null) {
    const nums = numbersIn(sheet);
    if (!nums.length) return 'both';
    const range = qualifiedRange(value, scraped.num);
    if (range) return nums.some((n) => n >= range[0] - 0.001 && n <= range[1] + 0.001) ? 'match' : 'differs';
    return nums.some((n) => Math.abs(n - scraped.num) < 0.001) ? 'match' : 'differs';
  }
  if (key === 'ratio') {
    const norm = (t) => (t.match(/(\d{1,2})\s*(?::|to|-to-)\s*(\d{1,2})/i) || []).slice(1).map(Number).sort((a, b) => b - a).join(':');
    const a = norm(sheet), b = norm(value);
    return a && b ? (a === b ? 'match' : 'differs') : 'both';
  }
  if (key === 'applicationOpenDate' || key === 'decisionDate') {
    const a = datesIn(sheet), b = datesIn(value);
    if (!a.length || !b.length) return 'both';
    const same = a.some((x) => b.some((y) => x.m === y.m && (x.d == null || y.d == null || x.d === y.d) && (x.y == null || y.y == null || x.y === y.y)));
    // a month with no day can agree with the sheet but is too vague to say it differs
    if (!same && (a.every((x) => x.d == null) || b.every((y) => y.d == null))) return 'both';
    return same ? 'match' : 'differs';
  }
  if (key === 'location') {
    // the sheet may list several campuses: it matches when the scraped street number and zip both appear in it
    const street = (value.match(/^\s*(\d{1,5})\b/) || [])[1];
    const zip = (value.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1];
    if (!street || !zip) return 'both';
    const has = (n) => new RegExp('(^|[^\\d])' + n + '([^\\d]|$)').test(sheet);
    if (has(street) && has(zip)) return 'match';
    return /\b\d{5}\b/.test(sheet) ? 'differs' : 'both';
  }
  if (key === 'grades') {
    const norm = (t) => t.toLowerCase().replace(/[–—]|\bto\b|\bthrough\b/g, '-').replace(/\s+/g, '');
    return norm(sheet).includes(norm(value)) ? 'match' : 'both';
  }
  const squeeze = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = squeeze(sheet), b = squeeze(value);
  if (a && b && (a.includes(b) || b.includes(a))) return 'match';
  return 'both';
}

module.exports = { compareField, sheetCells, qualifiedRange };
