'use strict';
// Pages a person saved by hand from a school's website (Ctrl+S in their own browser).
//
// Some websites refuse automatic reading, for example with a "Just a moment..." security check. The dashboard never
// works around that. Instead a person opens the pages in their own browser, saves them, and adds the files here. The
// dashboard then reads the saved files with the same rules it uses for a normal check. It never contacts the website.
//
// Saved files live in data/manual-pages/<website>/ (one folder per website, shared by the school's divisions).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PATHS, readJson, writeJson, baseDomain, slug, clip } = require('./util');
const { parseHtml, parsePdfText, PARSER_VERSION } = require('./html');
const { cleanStart, crawlFromPages } = require('./crawl');
const { BLOCK_MARKERS } = require('./fetcher');
const { extractSchool } = require('./rules');
const { siteIdentity } = require('./identity');
const { diffFields } = require('./changes');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 60;
const MIN_TEXT = 150;     // fewer characters than this means the page had not finished loading when it was saved

class ManualPagesError extends Error {}

// ------------------------------------------------------------------------------------------- where things live ---
function groupKey(school) {
  let host;
  try { host = new URL(cleanStart(school.website)).hostname.toLowerCase(); } catch { throw new ManualPagesError('This school has no website link in your sheet.'); }
  return host.replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '-');
}
const dirFor = (key) => path.join(PATHS.data, 'manual-pages', key);
const indexFile = (key) => path.join(dirFor(key), 'index.json');
const loadIndex = (key) => { const x = readJson(indexFile(key), []); return Array.isArray(x) ? x : []; };
const saveIndex = (key, list) => { fs.mkdirSync(dirFor(key), { recursive: true }); writeJson(indexFile(key), list); };
const publicEntry = (e) => ({ id: e.id, name: e.name, url: e.url, urlFrom: e.urlFrom, title: e.title, kind: e.kind, bytes: e.bytes, chars: e.chars, addedAt: e.addedAt });

// ----------------------------------------------------------------------------------------------- reading a file ---
function decode(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder('utf-16be').decode(buf);
  const m = /<meta[^>]+charset=["']?\s*([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'));
  try { return new TextDecoder(m ? m[1].toLowerCase() : 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

/** The page's own address, if the saved file says it (a canonical link, og:url, or the "saved from url" note some browsers add). */
function addressInHtml(html) {
  const head = html.slice(0, 200000);
  const patterns = [
    /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i,
    /<meta[^>]+property=["']og:url["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:url["']/i,
    /saved from url=\(\d+\)\s*(https?:\/\/[^\s>]+)/i,
  ];
  for (const re of patterns) { const m = re.exec(head); if (m) return m[1].replace(/&amp;/g, '&'); }
  return null;
}

function sameSiteAddress(raw, school) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let site;
  try { site = new URL(cleanStart(school.website)); } catch { return null; }
  if (baseDomain(u.hostname) !== baseDomain(site.hostname)) return null;
  return cleanStart(u.href);
}

async function recordFromBytes(buf, kind, url, name, savedAt) {
  const base = { url, finalUrl: url, fetchedAt: savedAt, parser: PARSER_VERSION, ok: false, saved: true };
  if (kind === 'pdf') {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    let timer;
    try {
      const data = await Promise.race([
        pdfParse(buf, { max: 12 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the PDF took too long to read')), 45000); }),
      ]);
      return { ...base, status: 200, kind: 'pdf', ok: true, ...parsePdfText(data.text), title: (data.info && data.info.Title) || '', linkText: name };
    } finally { clearTimeout(timer); }
  }
  const html = decode(buf);
  return { ...base, status: 200, kind: 'html', ok: true, ...parseHtml(html, url), _html: html };
}

// ------------------------------------------------------------------------------------------------- the store ---
/**
 * Checks one saved file and keeps it. `url` is optional: the page's web address, if the person knows it.
 * Rejects things that cannot be real pages (a security-check page, a nearly empty page, the wrong kind of file).
 */
async function addFile({ school, name, bytes, url }) {
  const key = groupKey(school);
  const cleanName = clip(String(name || 'page').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_'), 120) || 'page';
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ManualPagesError('That file is empty.');
  if (bytes.length > MAX_FILE_BYTES) throw new ManualPagesError('That file is bigger than 15 MB.');
  const list = loadIndex(key);
  if (list.length >= MAX_FILES) throw new ManualPagesError(`This website already has ${MAX_FILES} saved pages. Remove some first.`);

  const head = bytes.subarray(0, 2048).toString('latin1');
  const ext = (/\.([a-z0-9]+)$/i.exec(cleanName) || [])[1] || '';
  if (/^\s*MIME-Version:|^From: <Saved by|\.mht(ml)?$/i.test(head + '.' + ext) || /^(mhtml?|mht)$/i.test(ext)) {
    throw new ManualPagesError('That is a “single file” web archive (.mhtml). Save the page again as “Webpage, HTML only”, or print it to a PDF.');
  }
  const isPdf = head.startsWith('%PDF');
  const looksHtml = /<\s*(!doctype html|html|head|body)\b/i.test(head) || /^(html?|xhtml)$/i.test(ext);
  if (!isPdf && !looksHtml) throw new ManualPagesError('Please add pages saved as .html or .htm, or PDF files.');
  const kind = isPdf ? 'pdf' : 'html';

  let typed = null;
  if (url && String(url).trim()) {
    typed = sameSiteAddress(url, school);
    if (!typed) throw new ManualPagesError('That web address is not on this school’s website, so it cannot be used for this school.');
  }
  const savedAt = new Date().toISOString();
  let rec;
  try { rec = await recordFromBytes(bytes, kind, typed || new URL(cleanStart(school.website)).origin + '/', cleanName, savedAt); } catch (e) {
    throw new ManualPagesError(`That file could not be read: ${e.message}`);
  }
  if (kind === 'html') {
    if (BLOCK_MARKERS.test(rec._html.slice(0, 20000)) && (rec.mainChars || 0) < 1500) {
      throw new ManualPagesError('This file is the website’s security check page (“Just a moment…”), not the real page. Open the page in your browser, wait until the real page shows, then save it again.');
    }
  }
  if ((rec.mainChars || (rec.blocks || []).reduce((n, b) => n + (b.text || '').length, 0)) < MIN_TEXT) {
    throw new ManualPagesError('This page holds almost no text. The browser may not have finished loading it when you saved it. Wait until the page has fully loaded, then save it again.');
  }

  // the page's own web address: what the person typed, else what the file says, else a made-up one from the file name
  let urlFrom = 'typed', finalUrl = typed;
  if (!finalUrl && kind === 'html') {
    const inFile = addressInHtml(rec._html);
    finalUrl = inFile ? sameSiteAddress(inFile, school) : null;
    urlFrom = 'page';
  }
  if (!finalUrl) {
    const origin = new URL(cleanStart(school.website)).origin;
    const stem = slug(cleanName.replace(/\.[a-z0-9]+$/i, '')) || 'page';
    finalUrl = `${origin}/${stem}`;
    urlFrom = 'name';
  }
  if (list.some((e) => e.url === finalUrl)) {
    throw new ManualPagesError('A page with that web address is already saved. Remove it first if you want to replace it.');
  }

  const id = crypto.randomBytes(5).toString('hex');
  const file = `${id}.${kind === 'pdf' ? 'pdf' : 'html'}`;
  fs.mkdirSync(dirFor(key), { recursive: true });
  fs.writeFileSync(path.join(dirFor(key), file), bytes);
  const entry = { id, file, name: cleanName, url: finalUrl, urlFrom, title: clip(String(rec.title || ''), 160), kind, bytes: bytes.length, chars: rec.mainChars || 0, addedAt: savedAt };
  list.push(entry);
  saveIndex(key, list);
  return publicEntry(entry);
}

function list(school) {
  const key = groupKey(school);
  return { site: key, pages: loadIndex(key).map(publicEntry), max: MAX_FILES };
}

function remove(school, id) {
  const key = groupKey(school);
  const all = loadIndex(key);
  const hit = all.find((e) => e.id === String(id));
  if (!hit) throw new ManualPagesError('That saved page was not found.');
  try { fs.rmSync(path.join(dirFor(key), hit.file), { force: true }); } catch { /* the entry is removed either way */ }
  saveIndex(key, all.filter((e) => e !== hit));
}

const summarize = (fields) => {
  const n = { found: 0, none: 0, manual: 0 };
  for (const f of Object.values(fields)) n[f.status === 'found' ? 'found' : f.status === 'manual' ? 'manual' : 'none']++;
  return n;
};

/**
 * Reads every saved page of this school's website and writes the result for each school that shares that website
 * (the lower, middle and upper divisions), exactly as a normal check would. Nothing is downloaded.
 */
async function build({ school, schools, now = new Date() }) {
  const key = groupKey(school);
  const entries = loadIndex(key);
  if (!entries.length) throw new ManualPagesError('Add at least one saved page first.');
  const records = [];
  for (const e of entries) {
    try { records.push(await recordFromBytes(fs.readFileSync(path.join(dirFor(key), e.file)), e.kind, e.url, e.name, e.addedAt)); } catch { /* a damaged file is left out */ }
  }
  records.forEach((r) => { delete r._html; });
  const crawl = crawlFromPages(school.website, records);
  if (crawl.status !== 'ok') throw new ManualPagesError(crawl.detail || 'The saved pages could not be read.');

  const group = schools.filter((s) => { try { return s.website && groupKey(s) === key; } catch { return false; } });
  const out = [];
  const stamp = now.toISOString();
  for (const s of group) {
    const outFile = path.join(PATHS.resultsDir, s.id + '.json');
    let fields;
    try { fields = extractSchool(s, crawl, now); } catch (e) { out.push({ id: s.id, name: s.name, error: e.message }); continue; }
    let identity = null;
    try { identity = siteIdentity(s, crawl.pages.filter((p) => p.ok)); } catch { /* the check is only a warning */ }
    const prev = readJson(outFile, null);
    const changes = diffFields(prev, fields);
    const counts = summarize(fields);
    writeJson(outFile, {
      id: s.id, name: s.name, scrapedAt: stamp, scraperVersion: 'saved-pages',
      source: 'saved-pages', savedPages: { count: crawl.pages.length, at: stamp },
      start: crawl.start, status: 'ok', detail: null, ms: 0, counts, identity,
      changes, changedAt: changes.length ? stamp : (prev && prev.changedAt) || null,
      pages: crawl.pages.map((p) => ({ url: p.finalUrl, title: p.title || p.linkText || '', topics: p.topics || [], kind: p.kind, chars: p.mainChars || 0, fetchedAt: p.fetchedAt })),
      portals: crawl.portals, skipped: [], fields,
    });
    out.push({ id: s.id, name: s.name, found: counts.found, total: counts.found + counts.none });
  }
  return { pages: crawl.pages.length, schools: out };
}

/** A normal check that fails (the site still blocks us) must not wipe out answers read from pages saved by hand. */
const keepSavedPages = (prev, crawl) => !!(prev && prev.source === 'saved-pages' && prev.status === 'ok' && crawl && crawl.status !== 'ok');

module.exports = { addFile, list, remove, build, keepSavedPages, groupKey, ManualPagesError, MAX_FILE_BYTES, MAX_FILES };
