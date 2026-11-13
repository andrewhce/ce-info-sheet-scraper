'use strict';
// Sharing scrape results without a server: pack every school's result into one zip file, and add a teammate's zip to
// this computer's results. A result holds only what was found on public school websites (nothing from anyone's workbook),
// so the file is safe to pass around. Everyone compares results with their own copy of the sheet.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { PATHS, readJson, writeJson } = require('./util');

const FORMAT = 1;
const KIND = 'school-info-results';
const STATUSES = new Set(['ok', 'blocked', 'error', 'thin', 'robots', 'no-website']);
const MAX_FILE = 4 * 1024 * 1024;          // one school's result, unpacked
const MAX_FILES = 1500;
const MAX_TOTAL = 200 * 1024 * 1024;       // everything unpacked

class ShareError extends Error {}

/** Every result on this computer as one zip. */
async function buildPackage({ resultsDir = PATHS.resultsDir, by = null } = {}) {
  const zip = new JSZip();
  let count = 0, newest = null;
  let files = [];
  try { files = fs.readdirSync(resultsDir); } catch { /* no results folder yet */ }
  for (const f of files) {
    if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(f)) continue;
    const r = readJson(path.join(resultsDir, f));
    if (!r || r.id !== f.slice(0, -5) || !r.scrapedAt) continue;
    zip.file('results/' + f, JSON.stringify(r));
    count++;
    if (!newest || r.scrapedAt > newest) newest = r.scrapedAt;
  }
  zip.file('manifest.json', JSON.stringify({ kind: KIND, format: FORMAT, createdAt: new Date().toISOString(), by, schools: count, newestResult: newest }, null, 1));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { buffer, count };
}

function validResult(r, id) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.id !== id) return false;
  if (!STATUSES.has(r.status) || typeof r.scrapedAt !== 'string' || Number.isNaN(Date.parse(r.scrapedAt))) return false;
  if (typeof r.name !== 'string' || r.name.length > 300) return false;
  if (r.status === 'ok') {
    if (!r.fields || typeof r.fields !== 'object' || Array.isArray(r.fields) || !Array.isArray(r.pages)) return false;
    for (const f of Object.values(r.fields)) if (!f || typeof f !== 'object' || typeof f.status !== 'string') return false;
  }
  return true;
}

/**
 * Adds a teammate's results. Nothing is ever deleted: a school's result is only replaced by a newer one.
 * knownIds: the schools in this computer's list; results for other schools are skipped.
 */
async function importPackage(buffer, { resultsDir = PATHS.resultsDir, knownIds = null } = {}) {
  let zip;
  try { zip = await JSZip.loadAsync(buffer); } catch { throw new ShareError('That is not a results file from this program. Choose a file made by "Save my results to a file".'); }
  const mf = zip.file('manifest.json');
  let manifest = null;
  if (mf) { try { manifest = JSON.parse(await mf.async('string')); } catch { /* checked below */ } }
  if (!manifest || manifest.kind !== KIND) throw new ShareError('That zip is not a results file from this program.');
  if (!(manifest.format <= FORMAT)) throw new ShareError('That file was made by a newer version of the program. Ask for the newest copy of the program first.');

  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  if (names.length > MAX_FILES) throw new ShareError('That file holds far more results than expected, so it was not used.');
  const summary = { added: 0, updated: 0, keptNewer: 0, same: 0, unknown: 0, invalid: 0, unknownNames: [] };
  let total = 0;
  fs.mkdirSync(resultsDir, { recursive: true });
  for (const name of names) {
    const m = /^results\/([a-z0-9][a-z0-9-]*)\.json$/.exec(name);
    if (!m) continue;                                      // anything else in the zip is ignored
    const id = m[1];
    const entry = zip.file(name);
    const size = entry && entry._data && Number(entry._data.uncompressedSize);
    if (!size || size > MAX_FILE) { summary.invalid++; continue; }
    total += size;
    if (total > MAX_TOTAL) throw new ShareError('That file unpacks to far more than expected, so it was not used.');
    let r;
    try { r = JSON.parse(await entry.async('string')); } catch { summary.invalid++; continue; }
    if (!validResult(r, id)) { summary.invalid++; continue; }
    if (knownIds && !knownIds.has(id)) { summary.unknown++; if (summary.unknownNames.length < 8) summary.unknownNames.push(r.name); continue; }
    const target = path.join(resultsDir, id + '.json');
    const local = readJson(target);
    if (!local) { writeJson(target, r); summary.added++; }
    else if (r.scrapedAt === local.scrapedAt) summary.same++;
    else if (r.scrapedAt > local.scrapedAt) { writeJson(target, r); summary.updated++; }
    else summary.keptNewer++;
  }
  return { ...summary, from: { by: manifest.by || null, createdAt: manifest.createdAt || null, schools: manifest.schools || null } };
}

module.exports = { buildPackage, importPackage, ShareError, FORMAT };
