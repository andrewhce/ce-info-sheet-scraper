'use strict';
// Two ways to get a school's findings into the Google Sheet copy (google-sheet/Code.gs, pasted into the sheet):
//  1. buildExportFile: a file the person loads from the sheet's own menu. Needs nothing from Google admins.
//  2. exportSchool: sends it straight to an Apps Script web app ("Who has access: Anyone"; some company
//     Google accounts do not allow that). The web app address and a shared secret are saved on this
//     computer only, in data/export-config.json.
const path = require('path');
const crypto = require('crypto');
const { PATHS, readJson, writeJson } = require('./util');
const data = require('./dashboard-data');

const CONFIG_FILE = path.join(PATHS.data, 'export-config.json');
const HISTORY_FILE = path.join(PATHS.data, 'exports.json');
// https://script.google.com/macros/s/<id>/exec   or   https://script.google.com/a/macros/<domain>/s/<id>/exec
const URL_RE = /^https:\/\/script\.google\.com\/(?:macros\/s\/[\w-]+|a\/macros\/[\w.-]+\/s\/[\w-]+)\/exec$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;

class ExportError extends Error {}

const readConfig = () => readJson(CONFIG_FILE, null);
function publicConfig() {
  const c = readConfig();
  return c && c.url && c.token ? { configured: true, url: c.url, savedAt: c.savedAt } : { configured: false };
}
function saveConfig({ url, token }) {
  url = String(url || '').trim();
  token = String(token || '').trim();
  if (!URL_RE.test(url)) throw new ExportError('That is not a Google Apps Script web app address. It should look like https://script.google.com/macros/s/.../exec');
  if (!TOKEN_RE.test(token)) throw new ExportError('The secret should be 24 to 128 letters, digits, dashes or underscores. Use "Make a secret" to create one.');
  writeJson(CONFIG_FILE, { url, token, savedAt: new Date().toISOString() });
}
const newToken = () => crypto.randomBytes(24).toString('base64url');

/** One call to the web app. Resolves to the script's own answer ({ok:true,...}); throws ExportError otherwise. */
async function callSheet(body, fetchImpl = fetch) {
  const c = readConfig();
  if (!c || !c.url || !c.token) throw new ExportError('The Google Sheet export is not set up yet. Set it up on the Run scraper page.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150000);
  let res, text;
  try {
    res = await fetchImpl(c.url, {
      method: 'POST', redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...body, token: c.token }),
    });
    text = await res.text();
  } catch (e) {
    throw new ExportError(e.name === 'AbortError' ? 'Google took too long to answer.' : 'Could not reach Google (' + ((e.cause && e.cause.code) || e.message) + ').');
  } finally { clearTimeout(timer); }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new ExportError('Google sent back a web page instead of an answer. This happens when the web app is only open to your organization: this program cannot sign in to Google. Either deploy it with "Who has access: Anyone" (if your company allows it), or use "Download file for Google Sheet" and load that file from the School Info menu in the sheet.');
  }
  if (!json.ok) throw new ExportError(json.error || 'The sheet reported an error.');
  return json;
}

const testConnection = (fetchImpl) => callSheet({ action: 'ping' }, fetchImpl);

/** The template's hint texts, by row key: a cell still holding one of them counts as blank. */
function templateHints() {
  const hints = {};
  for (const r of data.getTemplate().rows) if (r.kind === 'field' && (r.hintB || r.hintC)) hints[r.key] = { B: r.hintB || '', C: r.hintC || '' };
  return hints;
}

/** Everything the sheet needs for one school: the fields the website gave, plus the template hints. */
function buildExport(id, tabIndex = 0) {
  const p = data.schoolPayload(id, tabIndex);
  if (!p) throw new ExportError('No such school.');
  if (!p.result || p.result.status !== 'ok') throw new ExportError('This school has not been scraped successfully yet, so there is nothing to export.');
  const fields = [];
  for (const row of p.rows) {
    if (row.kind !== 'field' || !row.scraped || row.scraped.status !== 'found') continue;
    fields.push({
      key: row.key, label: row.label, value: String(row.scraped.value).slice(0, 8000), confidence: row.scraped.confidence,
      sources: (row.scraped.sources || []).filter((s) => /^https?:\/\//i.test(s.url)).map((s) => ({ url: s.url, title: s.title })),
      note: row.scraped.note || null,
    });
  }
  const tab = p.tabs[p.tabIndex];
  return {
    action: 'export',
    school: { id, name: p.school.name, tab: tab ? tab.tab.trim() : null, nameInTab: tab ? tab.nameInTab : null, website: p.school.website },
    fields, hints: templateHints(), scrapedAt: p.result.scrapedAt,
  };
}

const FILE_KIND = 'school-info-export';

/**
 * One file with the findings for one school, or for every school that was scraped, to be loaded from the
 * Google Sheet's own menu (School Info > Load export file). No web app, no secret, nothing sent from this PC.
 * ids: an array of school ids, or 'all'. Returns { file, skipped } where skipped counts schools left out.
 */
function buildExportFile(ids, { tabIndex = 0, by = null } = {}) {
  const list = data.getSchools();
  if (!list) throw new ExportError('Load your School Information Sheet first.');
  const all = ids === 'all';
  const wanted = all ? list.schools.map((s) => s.id) : ids;
  const schools = [];
  const skipped = { notScraped: 0, nothingFound: 0, wrongSite: 0 };
  for (const id of wanted) {
    let body;
    try { body = buildExport(id, all ? 0 : tabIndex); } catch (e) {
      if (!all) throw e;
      skipped.notScraped++; continue;
    }
    // the website in the list does not look like this school: its findings belong to someone else, so the bulk file leaves it out
    if (all && data.getResult(id) && data.getResult(id).identity && data.getResult(id).identity.ok === false) { skipped.wrongSite++; continue; }
    if (!body.fields.length) {
      if (!all) throw new ExportError('The scrape found nothing for this school, so there is nothing to export.');
      skipped.nothingFound++; continue;
    }
    delete body.action; delete body.hints;   // the hints are the same for every school: kept once at the top of the file
    schools.push(body);
  }
  if (!schools.length) throw new ExportError(all ? 'No school has been scraped successfully yet, so there is nothing to export.' : 'Nothing to export.');
  const file = { kind: FILE_KIND, format: 1, createdAt: new Date().toISOString(), createdBy: by || null, count: schools.length, hints: templateHints(), schools };
  return { file, skipped };
}

const history = () => readJson(HISTORY_FILE, {});

async function exportSchool(id, tabIndex = 0, fetchImpl, by) {
  const body = buildExport(id, tabIndex);
  if (!body.fields.length) throw new ExportError('The scrape found nothing for this school, so there is nothing to export.');
  const res = await callSheet(body, fetchImpl);
  const h = history();
  h[id] = { at: new Date().toISOString(), by: by || null, tab: res.tab, tabUrl: res.tabUrl, created: !!res.created, summary: res.summary };
  writeJson(HISTORY_FILE, h);
  return { ...res, at: h[id].at };
}

module.exports = { ExportError, publicConfig, saveConfig, newToken, testConnection, buildExport, buildExportFile, FILE_KIND, exportSchool, history, callSheet, URL_RE };
