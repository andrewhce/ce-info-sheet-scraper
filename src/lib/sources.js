'use strict';
// Where an answer comes from:
//   1. the school's own website (read automatically, or from pages a person saved: lib/manual-pages.js)
//   2. Niche: only for a question the website left empty
//   3. Private School Review and Boarding School Review: only for a question both of those left empty
//   Ravenna (the school's own application platform) is not a fallback. Its steps, forms and dates are the "Admissions Portal" answers,
//   which the sheet keeps in their own column (B) of the Guide to Applying rows, next to the website's column (C): they are kept
//   separately in the result (`portalFields`), never in place of the website's answer.
// Every answer says which site it came from.
//
// Ravenna, Niche and the two review sites are never read automatically: Niche blocks automatic readers, Private School
// Review's terms forbid automated access, and Ravenna needs a login. A person opens the school's page in their own browser,
// saves it (Ctrl + S), and adds the file here. The dashboard then reads the saved file and never contacts those sites.
// A saved Ravenna page is a family's application, so it is cleaned before it is kept: see source-readers.js (sanitizeRavenna).
//
// Saved files live in data/source-pages/<school id>/<source>/ (one folder per school and source).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PATHS, readJson, writeJson, slug, clip } = require('./util');
const { parseHtml, parsePdfText, PARSER_VERSION } = require('./html');
const { decode, addressInHtml } = require('./manual-pages');
const { BLOCK_MARKERS } = require('./fetcher');
const { readSavedPage, sanitizeRavenna, ravennaMeta, GRADE_BAND } = require('./source-readers');
const { siteIdentity, nameWords } = require('./identity');

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 10;          // per school and source
const MIN_TEXT = 150;

class SourcePagesError extends Error { constructor(m, status) { super(m); this.status = status || 422; } }

const SOURCES = {
  ravenna: { key: 'ravenna', label: 'Ravenna', rank: null, column: 'B', host: /(^|\.)ravenna-hub\.com$/i, mention: /ravenna/i,
    blurb: 'The school’s own application platform (Ravenna Hub). Its steps, forms and due dates fill the “Admissions Portal” column of the Guide to Applying rows, next to the website’s answers.' },
  niche: { key: 'niche', label: 'Niche', rank: 2, host: /(^|\.)niche\.com$/i, mention: /niche\.com/i,
    blurb: 'Second choice for facts the school’s website does not give, such as the student-teacher ratio or class size.' },
  psr: { key: 'psr', label: 'Private School Review', rank: 3, host: /(^|\.)privateschoolreview\.com$/i, mention: /privateschoolreview\.com/i,
    blurb: 'Third choice, after Niche. Day schools.' },
  bsr: { key: 'bsr', label: 'Boarding School Review', rank: 3, host: /(^|\.)boardingschoolreview\.com$/i, mention: /boardingschoolreview\.com/i,
    blurb: 'Third choice, after Niche. Boarding schools.' },
};
const ORDER = ['ravenna', 'niche', 'psr', 'bsr'];     // the order the sources are shown in
const FILL_ORDER = ['niche', 'psr', 'bsr'];          // the order they fill what the website left empty (Ravenna keeps its own column)
const isSource = (k) => Object.prototype.hasOwnProperty.call(SOURCES, k);

// ------------------------------------------------------------------------------------------- where things live ---
const safeId = (school) => { if (!school || !/^[a-z0-9][a-z0-9-]*$/.test(String(school.id))) throw new SourcePagesError('That school was not found.', 404); return school.id; };
const rootDir = () => path.join(PATHS.data, 'source-pages');
const dirFor = (school, source) => path.join(rootDir(), safeId(school), source);
const indexFile = (school, source) => path.join(dirFor(school, source), 'index.json');
const loadIndex = (school, source) => { const x = readJson(indexFile(school, source), []); return Array.isArray(x) ? x : []; };
const saveIndex = (school, source, list) => { fs.mkdirSync(dirFor(school, source), { recursive: true }); writeJson(indexFile(school, source), list); };
const publicEntry = (e) => ({ id: e.id, name: e.name, url: e.url, title: e.title, kind: e.kind, bytes: e.bytes, chars: e.chars, addedAt: e.addedAt, warning: e.warning || undefined });
const withSource = (source) => { if (!isSource(source)) throw new SourcePagesError('Unknown source.', 400); return SOURCES[source]; };

// ---------------------------------------------------------------------------------------------- reading a file ---
// the page a website shows to something it has decided is not a person ("Access to this page has been denied", "Just a moment...")
const DENIED_TITLE = /access (to this page )?(has been )?denied|just a moment|attention required|are you a (robot|human)|verify you are (a )?human|pardon our interruption|request blocked/i;

function recordFromBytes(buf, kind, url, name, savedAt) {
  const base = { url, finalUrl: url, fetchedAt: savedAt, parser: PARSER_VERSION, ok: false, saved: true };
  if (kind === 'pdf') {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    return Promise.race([
      pdfParse(buf, { max: 12 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the PDF took too long to read')), 45000).unref()),
    ]).then((data) => ({ ...base, status: 200, kind: 'pdf', ok: true, ...parsePdfText(data.text), title: (data.info && data.info.Title) || '', linkText: name, _html: '' }));
  }
  const html = decode(buf);
  return Promise.resolve({ ...base, status: 200, kind: 'html', ok: true, ...parseHtml(html, url), _html: html });
}

const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };

/**
 * Checks one saved file and keeps it. `url` is optional: the page's web address, if the person knows it.
 * Refuses a security-check page, an empty page, another site's page, and a page about a different school.
 */
async function addFile({ school, source, name, bytes, url }) {
  const src = withSource(source);
  safeId(school);
  const cleanName = clip(String(name || 'page').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_'), 120) || 'page';
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new SourcePagesError('That file is empty.');
  if (bytes.length > MAX_FILE_BYTES) throw new SourcePagesError('That file is bigger than 15 MB.');
  const list = loadIndex(school, source);
  if (list.length >= MAX_FILES) throw new SourcePagesError(`${school.name} already has ${MAX_FILES} saved ${src.label} pages. Remove some first.`);

  const head = bytes.subarray(0, 2048).toString('latin1');
  const ext = (/\.([a-z0-9]+)$/i.exec(cleanName) || [])[1] || '';
  if (/^\s*MIME-Version:|^From: <Saved by|\.mht(ml)?$/i.test(head + '.' + ext) || /^(mhtml?|mht)$/i.test(ext)) {
    throw new SourcePagesError('That is a “single file” web archive (.mhtml). Save the page again as “Webpage, HTML only”, or print it to a PDF.');
  }
  const isPdf = head.startsWith('%PDF');
  const looksHtml = /<\s*(!doctype html|html|head|body)\b/i.test(head) || /^(html?|xhtml)$/i.test(ext);
  if (!isPdf && !looksHtml) throw new SourcePagesError('Please add pages saved as .html or .htm, or PDF files.');
  const kind = isPdf ? 'pdf' : 'html';
  const hash = crypto.createHash('sha1').update(bytes).digest('hex');
  if (list.some((e) => e.hash === hash)) throw new SourcePagesError('That exact page is already saved for this school.');

  let typed = null;
  if (url && String(url).trim()) {
    let u;
    try { u = new URL(String(url).trim()); } catch { throw new SourcePagesError('That web address does not look right.'); }
    if (!/^https?:$/.test(u.protocol)) throw new SourcePagesError('That web address does not look right.');
    if (!src.host.test(u.hostname)) throw new SourcePagesError(`That web address is not on ${src.label}.`);
    typed = u.origin + u.pathname.replace(/\/+$/, '');
  }
  const savedAt = new Date().toISOString();
  let rec;
  try { rec = await recordFromBytes(bytes, kind, typed || 'https://saved.invalid/' + slug(cleanName), cleanName, savedAt); } catch (e) {
    throw new SourcePagesError(`That file could not be read: ${e.message}`);
  }
  if (kind === 'html') {
    if (DENIED_TITLE.test(rec.title || '') || (BLOCK_MARKERS.test(rec._html.slice(0, 20000)) && (rec.mainChars || 0) < 1500)) {
      throw new SourcePagesError('This file is the website’s security check or “access denied” page, not the real page. Open the page in your browser, wait until the real page shows, then save it again.');
    }
  }
  const chars = rec.mainChars || (rec.blocks || []).reduce((n, b) => n + (b.text || '').length, 0);
  if (chars < MIN_TEXT) throw new SourcePagesError('This page holds almost no text. The browser may not have finished loading it when you saved it. Wait until the page has fully loaded, then save it again.');

  // the page's own address: what the person typed, else what the file says
  let finalUrl = typed, warning = '';
  if (!finalUrl && kind === 'html') {
    const inFile = addressInHtml(rec._html);
    if (inFile) {
      let u = null;
      try { u = new URL(inFile); } catch { /* not an address */ }
      if (u && /^https?:$/.test(u.protocol)) {
        if (!src.host.test(u.hostname)) throw new SourcePagesError(`This page is from ${u.hostname.replace(/^www\./, '')}, not ${src.label}. Open the school’s ${src.label} page and save that one.`);
        finalUrl = u.origin + u.pathname.replace(/\/+$/, '');
      }
    }
  }
  if (kind === 'html' && !finalUrl && !src.mention.test(rec._html.slice(0, 400000))) {
    if (source === 'ravenna') warning = 'Nothing on this page says it comes from Ravenna. Check that you saved the right page.';
    else throw new SourcePagesError(`This does not look like a ${src.label} page. Open the school’s page on ${src.label}, wait until it has loaded, and save that.`);
  }
  // is it about this school? Review pages always name the school in the title, so a different school is refused. A Ravenna page is titled
  // just "Ravenna": the school's name is on the page itself, so that is what is checked (and a page without it only gets a warning).
  let stored = bytes, title = rec.title || '';
  if (source === 'ravenna' && kind === 'html') {
    const rv = ravennaMeta(rec._html);
    if (rv) {
      title = `${rv.school} application`;
      if (!siteIdentity({ name: school.name }, [{ title: rv.school, blocks: [], jsonld: [] }]).ok) {
        throw new SourcePagesError(`This Ravenna page is the application to “${rv.school}”, which does not look like ${school.name}. Add it under the right school.`);
      }
      // the application is for one grade: a Grade 6 page belongs to the middle school, not the upper school
      const band = GRADE_BAND(rv.grade);
      if (school.division && band && band !== school.division) warning = warning || `This is the application for Grade ${rv.grade} (the ${band} school), but ${school.name} is the ${school.division} school. Check that it is the right page.`;
    } else if (!siteIdentity({ name: school.name }, [rec]).ok) {
      warning = warning || `This page does not show the name of the school it is the application to. Check that it is ${school.name}’s page.`;
    }
    stored = Buffer.from(sanitizeRavenna(rec._html), 'utf8');       // the family's details are never kept
  } else {
    const id = siteIdentity({ name: school.name }, [rec]);
    if (!id.ok) {
      const what = clip(rec.title || cleanName, 90);
      throw new SourcePagesError(`This page is “${what}”, which does not look like ${school.name}. Open the right school’s page, or add the file under the right school.`);
    }
  }
  if (finalUrl && list.some((e) => e.url === finalUrl)) throw new SourcePagesError('A page with that web address is already saved. Remove it first if you want to replace it.');

  const entryId = crypto.randomBytes(5).toString('hex');
  const file = `${entryId}.${kind}`;
  fs.mkdirSync(dirFor(school, source), { recursive: true });
  fs.writeFileSync(path.join(dirFor(school, source), file), stored);
  const entry = { id: entryId, file, name: cleanName, url: finalUrl || null, title: clip(String(title), 160), kind, bytes: stored.length, chars, hash, addedAt: savedAt, warning: warning || undefined };
  list.push(entry);
  saveIndex(school, source, list);
  return publicEntry(entry);
}

function list(school, source) {
  withSource(source);
  return { source, pages: loadIndex(school, source).map(publicEntry), max: MAX_FILES };
}

function remove(school, source, id) {
  withSource(source);
  const all = loadIndex(school, source);
  const hit = all.find((e) => e.id === String(id));
  if (!hit) throw new SourcePagesError('That saved page was not found.', 404);
  try { fs.rmSync(path.join(dirFor(school, source), hit.file), { force: true }); } catch { /* the entry is removed either way */ }
  saveIndex(school, source, all.filter((e) => e !== hit));
}

/** Deletes everything saved for a school (used when a school added by hand is removed). */
function removeAll(school) { fs.rmSync(path.join(rootDir(), safeId(school)), { recursive: true, force: true }); }

// ------------------------------------------------------------------------------------ which school is this page for ---
/**
 * Works out which school a saved page is about, from the page's title and web address and the file's name.
 * Returns { school } when exactly one school fits best, else { candidates } (several fit, or none).
 */
function matchSchool({ name, bytes }, schools) {
  const head = bytes.subarray(0, 2048).toString('latin1');
  if (head.startsWith('%PDF')) return { candidates: [] };
  const html = decode(bytes);
  const rec = parseHtml(html, 'https://saved.invalid/');
  // only the part of the title, heading and file name that names the school: "Name (Top Ranked ...) - City, ST" and "Name Reviews | Niche"
  // would otherwise match every school whose name shares a place word with the city (San Francisco Day School for a page about another San Francisco school)
  const lead = (t) => String(t || '').split(/\s+[-–—|]\s+|\s*\(|,|\s+reviews?\b|\s+rankings?\b|\s+profile\b|\s+niche\b/i)[0];
  const fileStem = lead(String(name || '').replace(/\.[a-z0-9]+$/i, '').replace(/\b(niche|ravenna|psr|bsr|private school review|boarding school review|saved|page|copy)\b/gi, ' '));
  const jsonName = (rec.jsonld || []).filter((n) => n && /School|Organization/i.test([].concat(n['@type'] || []).join(' '))).map((n) => n.name);
  const rv = ravennaMeta(html);          // a Ravenna application names its school, and the grade applied for, on the page
  const hay = [lead(rec.title), lead((rec.blocks.find((b) => b.k === 'h' && b.level === 1) || {}).text), ...jsonName.map(lead), fileStem, rv && rv.school]
    .filter(Boolean).join(' \n ').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const squashed = hay.replace(/[^a-z0-9]/g, '');
  const scored = [];
  for (const s of schools) {
    const w = nameWords(s.name).main;
    if (!w.length) continue;
    // a word counts when it starts a word in the page's name; only long words may also match with the spaces taken out ("HarvardWestlake"),
    // so that "king" is not found inside "Rankings"
    const got = w.filter((t) => new RegExp(`\\b${t}`).test(hay) || (t.length >= 6 && squashed.includes(t)));
    if (got.length !== w.length) continue;               // every distinctive word of the name must appear
    // a division named in the page ("Upper School") makes that division a better fit
    const div = s.division && new RegExp(`\\b${s.division}\\b`).test(hay) ? 1 : 0;
    scored.push({ s, score: w.length * 2 + div });
  }
  if (!scored.length) return { candidates: [] };
  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter((x) => x.score === scored[0].score);
  if (top.length === 1) return { school: top[0].s };
  // two divisions of one school fit: the grade a Ravenna application is for says which ("Grade 6" is the middle school)
  const band = rv && GRADE_BAND(rv.grade);
  const byBand = band ? top.filter((x) => x.s.division === band) : [];
  if (byBand.length === 1) return { school: byBand[0].s };
  return { candidates: top.slice(0, 6).map((x) => x.s) };
}

// ------------------------------------------------------------------------------------------------- the answers ---
const summarize = (fields) => {
  const n = { found: 0, none: 0, manual: 0 };
  for (const f of Object.values(fields)) n[f && f.status === 'found' ? 'found' : f && f.status === 'manual' ? 'manual' : 'none']++;
  return n;
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const templateKeys = () => { const t = readJson(PATHS.template, null); return ((t && t.rows) || []).filter((r) => r.kind === 'field' && r.key).map((r) => r.key); };
const MANUAL_KEYS = { notes: 'A free-form notes row. Nothing to look up.', peerSchools: 'Schools do not publish their peer schools, so there is nothing on the website to read.' };

function blankFields() {
  const f = {};
  for (const k of templateKeys()) f[k] = MANUAL_KEYS[k] ? { status: 'manual', note: MANUAL_KEYS[k] } : { status: 'none' };
  return f;
}

function decorate(field, src) {
  const note = `From ${src.label}, a page saved by hand. The school’s website did not give this answer.`;
  return {
    ...field,
    confidence: field.confidence === 'high' && src.key !== 'ravenna' ? 'medium' : field.confidence,
    note: [field.note, note].filter(Boolean).join(' '),
    source: { key: src.key, label: src.label, rank: src.rank },
  };
}

/** Reads every saved page of this school, one source at a time. */
async function readAll(school, now) {
  const per = {};
  for (const key of ORDER) {
    const entries = loadIndex(school, key);
    if (!entries.length) continue;
    const fields = {}; let pairs = 0, read = 0;
    for (const e of entries) {
      let rec;
      try { rec = await recordFromBytes(fs.readFileSync(path.join(dirFor(school, key), e.file)), e.kind, e.url || 'https://saved.invalid/' + e.id, e.name, e.addedAt); } catch { continue; }
      read++;
      const r = readSavedPage(rec, key, school, now);
      pairs += r.pairs;
      for (const [k, v] of Object.entries(r.fields)) {
        if (!fields[k]) fields[k] = { ...v, sources: [{ url: e.url || null, title: e.title || e.name }] };
      }
    }
    per[key] = { entries, fields, pairs, read };
  }
  return per;
}

/**
 * Puts the saved pages' answers into the school's result, filling only what the website left empty. Safe to run any number of
 * times: the website-only answers are kept in `websiteFields`, so a page that is removed takes its answers with it. Call it after
 * every scrape and every upload or removal. Returns null when the school has nothing saved and nothing to undo.
 */
async function reapply(school, now = new Date()) {
  const file = path.join(PATHS.resultsDir, safeId(school) + '.json');
  const prev = readJson(file, null);
  const per = await readAll(school, now);
  const keys = Object.keys(per);

  if (!keys.length) {                         // nothing saved (any more): give back the website-only result
    if (!prev || !prev.websiteFields) return null;
    const restored = { ...prev, fields: prev.websiteFields };
    if (prev.websiteStatus) { restored.status = prev.websiteStatus.status; restored.detail = prev.websiteStatus.detail || null; }
    if (restored.source === 'other-sources') delete restored.source;
    restored.pages = (prev.pages || []).filter((p) => !p.fromSource);
    restored.counts = summarize(restored.fields);
    for (const k of ['websiteFields', 'websiteStatus', 'otherSources', 'portalFields']) delete restored[k];
    if (restored.status === 'not-scraped') { fs.rmSync(file, { force: true }); return null; }
    writeJson(file, restored);
    return null;
  }

  const stamp = now.toISOString();
  let result = prev;
  const hadMerge = !!(prev && prev.websiteFields);
  if (!result) result = { id: school.id, name: school.name, scrapedAt: stamp, scraperVersion: 'other-sources', start: school.website || null, status: 'not-scraped', detail: null, ms: 0, counts: { found: 0, none: 0, manual: 0 }, identity: null, changes: [], changedAt: null, pages: [], portals: [], skipped: [], fields: {} };
  const websiteOk = hadMerge ? !(result.websiteStatus && result.websiteStatus.status !== 'ok') : result.status === 'ok';
  const websiteFields = hadMerge ? result.websiteFields : clone(result.fields || {});      // kept exactly as they were, to give back
  const websiteStatus = hadMerge ? result.websiteStatus : { status: result.status, detail: result.detail || null };

  const merged = websiteOk ? clone(websiteFields) : blankFields();     // a website that could not be read has no answers of its own
  const filled = {};
  // Niche, then the review sites, fill only what is still empty
  const allKeys = new Set([...Object.keys(merged), ...FILL_ORDER.flatMap((k) => (per[k] ? Object.keys(per[k].fields) : []))]);
  for (const key of allKeys) {
    const have = merged[key];
    if (have && (have.status === 'found' || have.status === 'manual')) continue;
    for (const sk of FILL_ORDER) {
      const f = per[sk] && per[sk].fields[key];
      if (!f) continue;
      merged[key] = decorate(f, SOURCES[sk]);
      (filled[sk] = filled[sk] || []).push(key);
      break;
    }
  }
  // Ravenna's steps are the "Admissions Portal" answers: always kept, in their own column, whatever the website said
  const portalFields = {};
  if (per.ravenna) {
    for (const [key, f] of Object.entries(per.ravenna.fields)) portalFields[key] = { ...f, source: { key: 'ravenna', label: 'Ravenna', column: 'B' } };
    filled.ravenna = Object.keys(portalFields);
  }
  const pages = (result.pages || []).filter((p) => !p.fromSource);
  for (const sk of keys) {
    for (const e of per[sk].entries) {
      pages.push({ url: e.url || null, title: e.title || e.name, topics: [], kind: e.kind, chars: e.chars || 0, fetchedAt: e.addedAt, fromSource: sk });
    }
  }
  const otherSources = {};
  for (const sk of keys) {
    otherSources[sk] = {
      label: SOURCES[sk].label, pages: per[sk].entries.length, at: per[sk].entries.reduce((m, e) => (e.addedAt > m ? e.addedAt : m), ''),
      facts: Object.keys(per[sk].fields).length, filled: filled[sk] || [],
    };
  }
  // a question counts as answered when the website, Niche, a review site or the admissions portal answered it
  const counts = summarize(Object.fromEntries([...new Set([...Object.keys(merged), ...Object.keys(portalFields)])].map((k) => [k, merged[k] && merged[k].status === 'found' ? merged[k] : portalFields[k] || merged[k]])));
  const out = {
    ...result, fields: merged, counts, pages, websiteFields, websiteStatus, otherSources,
    status: 'ok', detail: null,
    ...(websiteStatus.status === 'ok' ? {} : { source: 'other-sources', scrapedAt: stamp }),
  };
  if (Object.keys(portalFields).length) out.portalFields = portalFields; else delete out.portalFields;
  if (websiteStatus.status === 'ok' && out.source === 'other-sources') delete out.source;
  writeJson(file, out);
  return { filled, counts: out.counts, otherSources };
}

/** For the pages that list every school: how many pages are saved for each school and source, and what they filled. */
function overview() {
  const out = {};
  let dirs = [];
  try { dirs = fs.readdirSync(rootDir()); } catch { return out; }
  for (const id of dirs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
    const mine = {};
    for (const key of ORDER) {
      const idx = readJson(path.join(rootDir(), id, key, 'index.json'), []);
      if (Array.isArray(idx) && idx.length) mine[key] = { pages: idx.length, at: idx.reduce((m, e) => (e.addedAt > m ? e.addedAt : m), ''), warning: idx.some((e) => e.warning) || undefined };
    }
    if (Object.keys(mine).length) {
      const r = readJson(path.join(PATHS.resultsDir, id + '.json'), null);
      for (const key of Object.keys(mine)) {
        const o = r && r.otherSources && r.otherSources[key];
        if (o) { mine[key].facts = o.facts; mine[key].filled = (o.filled || []).length; }
      }
      out[id] = mine;
    }
  }
  return out;
}

/** The result keeps no memory of an upload that has not been applied yet, so a scrape that just finished calls this for each school it wrote. */
function hasPages(school) {
  try { return fs.readdirSync(path.join(rootDir(), safeId(school))).length > 0; } catch { return false; }
}

module.exports = { SOURCES, ORDER, addFile, list, remove, removeAll, matchSchool, reapply, overview, hasPages, SourcePagesError, MAX_FILE_BYTES, MAX_FILES };
