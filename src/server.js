'use strict';
// Local dashboard for the School Information Sheet scraper.
// Serves on this computer only (127.0.0.1). Start it with:  node src/server.js
// then open http://localhost:4477
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { PATHS, loadConfig, readJson } = require('./lib/util');
const data = require('./lib/dashboard-data');
const sheetExport = require('./lib/sheet-export');
const spreadsheetExport = require('./lib/spreadsheet-export');
const resultsPackage = require('./lib/results-package');
const scheduler = require('./lib/scheduler');
const { createSlack, SlackError } = require('./lib/slack');
const winTask = require('./lib/windows-task');
const { checkSetup } = require('./setup-check');
const auth = require('./auth');
const { createAssistant, AskError } = require('./agent');
const { createVerification, VerificationError } = require('./lib/verification');
const reviewQueue = require('./lib/review-queue');

const cfg = loadConfig();
const verification = createVerification({ data });   // spot-checks and the accuracy figures built from them
const assistant = createAssistant();       // the Ask page's AI helper: only reads saved data, see src/agent/
const slack = createSlack({ publicUrl: auth.settings.publicUrl });
const audit = (user, text) => console.log(`${new Date().toISOString()} [${(user && user.email) || 'local'}] ${text}`);
const PORT = Number(process.env.PORT) || cfg.port || 4477;
const PUBLIC = PATHS.public;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
const overview = () => {
  const o = data.overview();
  if (!o.ready) return o;
  const exported = sheetExport.history();
  for (const s of o.schools) if (exported[s.id]) s.exportedAt = exported[s.id].at;
  return { ...o, job: jobState(0) };
};

// -------------------------------------------------------------------- job ---

let job = null;
let logSeq = 0;
function log(text, kind) {
  if (!job) return;
  job.log.push({ n: ++logSeq, t: Date.now(), text, kind: kind || 'info' });
  if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
}
/** A scrape started from a terminal (not by this dashboard) leaves data/run.lock while it runs. */
function externalRun() {
  const l = readJson(path.join(PATHS.data, 'run.lock'));
  if (!l || (job && job.running && job.child.pid === l.pid)) return null;
  try { process.kill(l.pid, 0); } catch { return null; }
  return Date.now() - l.startedAt < 36 * 3600e3 ? l : null;
}

function jobState(since) {
  if (!job || !job.running) {
    const x = externalRun();
    if (x) {
      return { running: true, external: true, label: x.label + ' (started outside the dashboard)', startedAt: x.startedAt,
        schools: x.schools, sites: x.sites, done: x.done || 0, sitesDone: x.sitesDone || 0, active: [], log: [] };
    }
  }
  if (!job) return { running: false };
  return {
    running: job.running, label: job.label, startedAt: job.startedAt, endedAt: job.endedAt || null,
    schools: job.schools, sites: job.sites, done: job.done, sitesDone: job.sitesDone,
    active: [...job.active.values()], stopped: !!job.stopped, exitCode: job.exitCode,
    log: job.log.filter((l) => l.n > since), stats: job.stats || null,
  };
}

function fieldLabelsMap() {
  const map = new Map();
  const tpl = data.getTemplate();
  for (const r of (tpl && tpl.rows) || []) {
    if (r.kind === 'field' && r.key) map.set(r.key, String(r.label || r.key).replace(/:$/, ''));
  }
  return map;
}

function startJob(args, label, by, opts = {}) {
  if ((job && job.running) || externalRun()) return { error: 'A scrape is already running.' };
  const child = spawn(process.execPath, [path.join(PATHS.src, 'scrape.js'), ...args, '--progress-json'], { cwd: PATHS.root, windowsHide: true });
  const labels = fieldLabelsMap();
  job = { running: true, scheduled: !!opts.scheduled, label, startedAt: Date.now(), schools: 0, sites: 0, done: 0, sitesDone: 0, active: new Map(), changes: [], log: [], child };
  log(`Started: ${label}${by ? ' (by ' + by + ')' : ''}`);
  let buf = '';
  const onEvent = (ev) => {
    if (ev.type === 'start') { job.schools = ev.schools; job.sites = ev.sites; log(`${ev.schools} schools on ${ev.sites} websites.`); }
    else if (ev.type === 'site-start') job.active.set(ev.start, { start: ev.start, schools: ev.schools, pages: 0 });
    else if (ev.type === 'page') { const a = job.active.get(ev.start); if (a) a.pages = ev.count; }
    else if (ev.type === 'school-done') {
      if (ev.done) job.done = ev.done; else job.done++;
      const ok = ev.status === 'ok';
      if (ev.changesCount > 0 && Array.isArray(ev.changes)) {
        job.changes.push({
          id: ev.id,
          name: ev.name,
          wrongSite: !!ev.wrongSite,
          fields: ev.changes.map((c) => ({ ...c, label: labels.get(c.key) || c.key })),
        });
      }
      const chNote = ev.changesCount > 0 ? ` — ${ev.changesCount} website update${ev.changesCount === 1 ? '' : 's'} detected` : '';
      log(ok ? `${ev.name}: ${ev.found} of ${ev.total} fields found${chNote}` : `${ev.name}: ${ev.status}${ev.detail ? ' — ' + ev.detail : ''}`, ev.changesCount > 0 ? 'info' : ok ? 'ok' : 'warn');
    } else if (ev.type === 'site-done') { job.active.delete(ev.start); job.sitesDone++; }
    else if (ev.type === 'done') { job.stats = ev; log(`Finished: ${ev.schools} schools, ${ev.requests} pages downloaded, ${ev.cacheHits} from cache, ${Math.round(ev.ms / 1000)}s.`, 'ok'); }
  };
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { log(line); }
    }
  });
  child.stderr.on('data', (d) => {
    const t = d.toString('utf8').trim();
    if (t && !/^Warning: TT:|^Warning: .*font/i.test(t)) log(t.slice(0, 400), 'warn'); // pdf font warnings are noise
  });
  child.on('close', (code) => {
    job.running = false; job.endedAt = Date.now(); job.exitCode = code; job.active.clear();
    data.clearCache();
    if (job.stopped) log('Stopped. Schools already finished are saved.', 'warn');
    else if (code !== 0) log(`The script ended with an error (code ${code}).`, 'warn');
    if (job.scheduled) {
      scheduler.markFinished({
        status: job.stopped ? 'stopped' : code === 0 ? 'ok' : 'error',
        summary: { label: job.label, schools: job.done, updatedSchools: job.changes.length },
      });
    }
    slack.notifyRun({
      label: job.label,
      scheduled: job.scheduled,
      stopped: !!job.stopped,
      exitCode: code,
      schoolsDone: job.done,
      schoolsTotal: job.schools,
      durationMs: job.endedAt - job.startedAt,
      changes: job.changes,
    }).then((res) => {
      if (res.sent) log(`Posted summary to Slack (${res.changedSchools} updated school${res.changedSchools === 1 ? '' : 's'}).`, 'ok');
      else if (res.error) log('Slack alert failed: ' + res.error, 'warn');
    }).catch(() => {});
  });
  return { ok: true };
}

// ------------------------------------------------------------------- http ---

const secureHeaders = (type, extra) => ({
  'Content-Type': type || MIME['.json'], 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ...(auth.settings.publicUrl.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
  ...(extra || {}),
});
function send(res, status, body, type, extra) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, secureHeaders(type, extra));
  res.end(data);
}

/** The Ask page: a question goes in, progress and the answer stream back one JSON object per line. */
async function streamAnswer(req, res, user, body) {
  let turn;
  try { turn = assistant.begin({ user, conversationId: body.conversationId, message: body.message, effort: body.effort }); } catch (e) {
    if (e instanceof AskError) return send(res, e.status, { error: e.message });
    throw e;
  }
  audit(user, `asked the assistant a question (${String(body.message).length} characters)`);
  res.writeHead(200, secureHeaders('application/x-ndjson; charset=utf-8', { 'X-Accel-Buffering': 'no' }));
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableEnded) stop.abort(); });   // the page was closed or Stop was pressed
  const emit = (ev) => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };
  emit({ type: 'conversation', id: turn.conversationId, fresh: turn.fresh });
  await turn.run(emit, stop.signal);
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/**
 * The dashboard sends the chosen .xlsx as the raw request body. It is checked, saved as data/workbook.xlsx
 * and imported. If the import fails, the previous file (if any) is put back.
 */
async function receiveWorkbook(req, res) {
  if ((job && job.running) || externalRun()) { req.resume(); return send(res, 409, { error: 'Wait for the running scrape to finish first.' }); }
  fs.mkdirSync(PATHS.data, { recursive: true });
  const part = PATHS.workbook + '.part';
  const MAX = 150 * 1024 * 1024;
  let size = 0;
  const limit = new Transform({ transform(chunk, enc, cb) { size += chunk.length; cb(size > MAX ? new Error('too large') : null, chunk); } });
  try { await pipeline(req, limit, fs.createWriteStream(part)); } catch (e) {
    fs.rmSync(part, { force: true });
    return send(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'That file is bigger than 150 MB.' : 'The upload was interrupted. Please try again.' });
  }
  const head = Buffer.alloc(4);
  const fd = fs.openSync(part, 'r');
  const n = fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (n < 4 || head.toString('hex') !== '504b0304') { // every .xlsx is a zip file
    fs.rmSync(part, { force: true });
    return send(res, 400, { error: 'That does not look like an Excel (.xlsx) file. In Google Sheets use File, Download, Microsoft Excel (.xlsx).' });
  }
  const previous = PATHS.workbook + '.previous';
  const hadOld = fs.existsSync(PATHS.workbook);
  if (hadOld) fs.copyFileSync(PATHS.workbook, previous);
  fs.renameSync(part, PATHS.workbook);
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(PATHS.src, 'import-workbook.js'), PATHS.workbook], { cwd: PATHS.root, maxBuffer: 4e6, windowsHide: true, timeout: 300000 });
    data.clearCache();
    fs.rmSync(previous, { force: true });
    return send(res, 200, { ok: true, output: stdout.split('\n').slice(0, 14).join('\n') });
  } catch (e) {
    if (hadOld) fs.copyFileSync(previous, PATHS.workbook); else fs.rmSync(PATHS.workbook, { force: true });
    fs.rmSync(previous, { force: true });
    data.clearCache();
    const why = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 3).join(' ');
    return send(res, 422, { error: 'That file could not be used as the School Information Sheet. ' + why });
  }
}

/** A teammate's results file: checked and added. A school's result is only ever replaced by a newer one. */
async function receiveResults(req, res, user) {
  const MAX = 100 * 1024 * 1024;
  const chunks = [];
  let size = 0, tooBig = false;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => { size += c.length; if (size > MAX) tooBig = true; else chunks.push(c); });
    req.on('end', resolve); req.on('error', reject);
  }).catch(() => { tooBig = null; });
  if (tooBig === null) return send(res, 400, { error: 'The upload was interrupted. Please try again.' });
  if (tooBig) return send(res, 413, { error: 'That file is bigger than 100 MB.' });
  if ((job && job.running) || externalRun()) return send(res, 409, { error: 'Wait for the running scrape to finish first.' });
  const list = data.getSchools();
  if (!list) return send(res, 400, { error: 'Load your School Information Sheet first, so the results can be matched to your schools.' });
  try {
    const summary = await resultsPackage.importPackage(Buffer.concat(chunks), { knownIds: new Set(list.schools.map((s) => s.id)) });
    data.clearCache();
    audit(user, `added a teammate's results: ${summary.added} new, ${summary.updated} newer`);
    return send(res, 200, { ok: true, ...summary });
  } catch (e) {
    if (e instanceof resultsPackage.ShareError) return send(res, 422, { error: e.message });
    throw e;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');   // for the hosting service's health check
    // only answer requests addressed to this computer (or the public address), and only accept changes from this page
    if (!auth.hostAllowed(req.headers.host)) return send(res, 403, { error: 'forbidden' });
    if (await auth.handle(req, res, url, send)) return;          // /auth/login, /auth/callback, /auth/logout
    if ((p.startsWith('/api/') || req.method === 'POST') && !auth.originAllowed(req)) return send(res, 403, { error: 'forbidden' });
    const user = auth.sessionUser(req);
    if (!user) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Please sign in again.', signIn: '/auth/login' });
      return send(res, 302, '', 'text/plain; charset=utf-8', { Location: '/auth/login' });
    }

    if (req.method === 'POST') {
      if (req.headers['x-dashboard'] !== '1') return send(res, 403, { error: 'forbidden' });
      if (p === '/api/workbook') { audit(user, 'is loading a new School Information Sheet'); return await receiveWorkbook(req, res); }
      if (p === '/api/results-package') return await receiveResults(req, res, user);
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 403, { error: 'forbidden' });
      const body = await readBody(req);
      // ---- spot-checks and accuracy ----
      if (p === '/api/verify' || p === '/api/accuracy/sample' || p === '/api/accuracy/sample-clear') {
        try {
          if (p === '/api/accuracy/sample-clear') { verification.clearSample(); audit(user, 'cleared the accuracy sample'); return send(res, 200, { ok: true }); }
          if (p === '/api/accuracy/sample') { const out = verification.drawSample({ schools: body.schools }); audit(user, `drew an accuracy sample of ${out.schools.length} schools`); return send(res, 200, out); }
          if (body.clear === true) { verification.remove(String(body.school_id || ''), String(body.field || '')); return send(res, 200, { ok: true }); }
          // what the trust score said about this value, saved with the check so the Accuracy tab can test whether the score's levels hold up
          let trustAtTheTime = null;
          try {
            const row = data.compareSchool(String(body.school_id || ''), 0).rows.find((r) => r.key === String(body.field || ''));
            if (row && row.trust) trustAtTheTime = { score: row.trust.score, level: row.trust.level };
          } catch { /* a check can still be saved without it */ }
          const entry = verification.record({ schoolId: String(body.school_id || ''), field: String(body.field || ''), verdict: String(body.verdict || ''), truth: body.truth, truthUrl: body.truthUrl, note: body.note, by: user.email || null, trust: trustAtTheTime });
          audit(user, `spot-checked ${entry.field} for ${entry.schoolId}: ${entry.verdict}`);
          return send(res, 200, entry);
        } catch (e) {
          if (e instanceof VerificationError) return send(res, 400, { error: e.message });
          throw e;
        }
      }
      // ---- Ask page ----
      if (p === '/api/ask') return await streamAnswer(req, res, user, body);
      if (p === '/api/ask/reset') { assistant.reset(user, body.conversationId); return send(res, 200, { ok: true }); }
      if (p === '/api/ask/session-rename') {
        try {
          return send(res, 200, assistant.renameSession(user, body.id, body.title));
        } catch (e) {
          if (e instanceof AskError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (p === '/api/ask/memory') {
        try {
          const out = await assistant.mutateMemory(user, body);
          audit(user, `updated Ask memory (${body.action || 'add'})`);
          return send(res, 200, out);
        } catch (e) {
          if (e instanceof AskError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (p === '/api/ask/kb') {
        if (body.action === 'clear') {
          audit(user, 'cleared learned Ask knowledge base');
          return send(res, 200, assistant.clearKb(user));
        }
        return send(res, 400, { error: 'Unknown KB action.' });
      }
      if (p === '/api/ask/settings' || p === '/api/ask/test') {
        try {
          const out = p === '/api/ask/test' ? await assistant.testConnection(user) : assistant.saveSettings(user, body);
          if (p === '/api/ask/settings') audit(user, 'changed the AI settings');
          return send(res, 200, out);
        } catch (e) {
          if (e instanceof AskError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (p === '/api/run') {
        const list = data.getSchools();
        if (!list) return send(res, 400, { error: 'Import the workbook first.' });
        const args = [];
        let label;
        if (body.scope === 'tier' && [1, 2, 3].includes(Number(body.tier))) { args.push('--tier', String(Number(body.tier))); label = `Tier ${Number(body.tier)} schools`; }
        else if (body.scope === 'all') { args.push('--all'); label = 'All schools'; }
        else if (body.scope === 'pending') { args.push('--pending'); label = 'Schools not scraped yet'; }
        else if (body.scope === 'schools' && Array.isArray(body.ids) && body.ids.length && body.ids.length <= 400) {
          const known = new Set(list.schools.map((s) => s.id));
          const ids = body.ids.filter((id) => typeof id === 'string' && known.has(id));
          if (!ids.length) return send(res, 400, { error: 'Unknown school.' });
          for (const id of ids) args.push('--school', id);
          label = ids.length === 1 ? list.schools.find((s) => s.id === ids[0]).name : `${ids.length} selected schools`;
        } else return send(res, 400, { error: 'Unknown scope.' });
        if (body.refresh) { args.push('--refresh'); label += ' (pages downloaded again)'; }
        const r = startJob(args, label, user.email);
        if (!r.error) audit(user, 'started a scrape: ' + label);
        return send(res, r.error ? 409 : 200, r);
      }
      if (p === '/api/stop') {
        audit(user, 'stopped the running scrape');
        if (job && job.running) { job.stopped = true; job.child.kill(); }
        else { const x = externalRun(); if (x) { try { process.kill(x.pid); } catch { /* already gone */ } } }
        return send(res, 200, { ok: true });
      }
      if (p === '/api/shutdown') {
        if (!auth.loopbackOnly || !user.local) return send(res, 403, { error: 'Shutdown is only available on a personal computer.' });
        audit(user, 'turned off the dashboard');
        if (job && job.running) { job.stopped = true; try { job.child.kill(); } catch { /* ignore */ } }
        send(res, 200, { ok: true });
        setTimeout(() => {
          try { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } catch { /* ignore */ }
          process.exit(0);
        }, 120);
        return;
      }
      if (p === '/api/import') {
        if ((job && job.running) || externalRun()) return send(res, 409, { error: 'Wait for the running scrape to finish first.' });
        return execFile(process.execPath, [path.join(PATHS.src, 'import-workbook.js')], { cwd: PATHS.root, maxBuffer: 4e6, windowsHide: true }, (err, stdout, stderr) => {
          data.clearCache();
          send(res, err ? 500 : 200, { ok: !err, output: (stdout || '') + (stderr || '') });
        });
      }
      // ---- Google Sheet export ----
      if (p === '/api/export-config') {
        if (body && body.clear === true) { sheetExport.clearConfig(); audit(user, 'removed the saved one-click Google Sheet address'); return send(res, 200, sheetExport.publicConfig()); }
        try { sheetExport.saveConfig(body); return send(res, 200, sheetExport.publicConfig()); } catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/export-secret') return send(res, 200, { token: sheetExport.newToken() });
      if (p === '/api/export-test') {
        try { return send(res, 200, await sheetExport.testConnection()); } catch (e) { return send(res, 502, { error: e.message }); }
      }
      if (p === '/api/export') {
        const list = data.getSchools();
        if (!list || !list.schools.some((s) => s.id === body.id)) return send(res, 404, { error: 'No such school.' });
        audit(user, 'exports ' + body.id + ' to the Google Sheet');
        try { return send(res, 200, await sheetExport.exportSchool(body.id, Number(body.tab) || 0, undefined, user.email)); } catch (e) { return send(res, e instanceof sheetExport.ExportError ? 502 : 500, { error: e.message }); }
      }
      // ---- Built-in scheduler & Slack notifications ----
      if (p === '/api/schedule') {
        try {
          const st = scheduler.save(body);
          audit(user, st.enabled ? `set auto-check schedule (${st.frequency}, ${st.scope})` : 'turned off auto-check schedule');
          return send(res, 200, { ...st, overdue: scheduler.isOverdue(st), windowsTask: await winTask.getStatus() });
        } catch (e) {
          return send(res, e instanceof scheduler.ScheduleError ? 400 : 500, { error: e.message });
        }
      }
      if (p === '/api/schedule/missed') {
        try {
          const st = scheduler.load();
          if (body.action === 'skip') {
            const next = scheduler.skipMissedRun();
            audit(user, 'skipped overdue scheduled website check');
            return send(res, 200, { ...next, overdue: false, windowsTask: await winTask.getStatus() });
          }
          if (body.action === 'run') {
            if (!data.getSchools()) return send(res, 400, { error: 'Import the workbook first.' });
            const cmd = scheduler.scopeCommand(st.scope, st.refresh);
            const r = startJob(cmd.args, cmd.label, user.email || 'Auto-scheduler', { scheduled: true });
            if (r.error) return send(res, 409, r);
            const next = scheduler.markStarted();
            audit(user, 'started overdue scheduled website check: ' + cmd.label);
            return send(res, 200, { ...next, overdue: false, started: true, windowsTask: await winTask.getStatus() });
          }
          return send(res, 400, { error: 'Action must be run or skip.' });
        } catch (e) { return send(res, 500, { error: e.message }); }
      }
      if (p === '/api/schedule/windows-task') {
        if (!auth.loopbackOnly || !user.local) return send(res, 403, { error: 'Windows Task Scheduler setup is only available on a personal PC.' });
        try {
          const wt = body.action === 'remove' ? await winTask.remove() : await winTask.install();
          audit(user, body.action === 'remove' ? 'removed Windows auto-check background task' : 'enabled Windows auto-check background task');
          return send(res, 200, wt);
        } catch (e) { return send(res, 500, { error: e.message }); }
      }
      if (p === '/api/slack-config') {
        try {
          const st = slack.save(body);
          audit(user, 'updated Slack notification settings');
          return send(res, 200, st);
        } catch (e) {
          return send(res, e instanceof SlackError ? 400 : 500, { error: e.message });
        }
      }
      if (p === '/api/slack-test') {
        try {
          const st = await slack.sendTest();
          audit(user, 'sent a Slack test notification');
          return send(res, 200, st);
        } catch (e) {
          return send(res, e instanceof SlackError ? 502 : 500, { error: e.message });
        }
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    if (p === '/api/schedule') {
      const st = scheduler.load();
      return send(res, 200, { ...st, overdue: scheduler.isOverdue(st), windowsTask: await winTask.getStatus() });
    }
    if (p === '/api/slack-config') return send(res, 200, slack.publicView());
    if (p === '/api/export-config') return send(res, 200, sheetExport.publicConfig());
    if (p === '/api/export-file') {
      // a file for the Google Sheet's own menu (School Info > Load export file): one school, or every scraped school
      const all = url.searchParams.get('all') === '1';
      const id = url.searchParams.get('id');
      const several = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);   // from the Ask page's button
      const wanted = several.length ? several : [id];
      const list = data.getSchools();
      if (!all && (!list || !wanted.every((w) => list.schools.some((s) => s.id === w)))) return send(res, 404, { error: 'No such school.' });
      try {
        const { file, skipped } = sheetExport.buildExportFile(all ? 'all' : wanted, { tabIndex: Number(url.searchParams.get('tab')) || 0, by: user.email });
        const day = new Date().toISOString().slice(0, 10);
        const slug = all || wanted.length > 1 ? `${file.count}-schools-${day}` : String(id).replace(/[^a-z0-9-]+/gi, '-').slice(0, 60);
        audit(user, all || wanted.length > 1 ? `made a Google Sheet file for ${file.count} schools` : `made a Google Sheet file for ${id}`);
        return send(res, 200, JSON.stringify(file), 'application/json; charset=utf-8', {
          'Content-Disposition': `attachment; filename="school-info-export-${slug}.json"`,
          'X-Export-Count': String(file.count), 'X-Export-Skipped': String(skipped.notScraped + skipped.nothingFound + skipped.wrongSite), 'X-Export-Wrong-Site': String(skipped.wrongSite),
        });
      } catch (e) { return send(res, e instanceof sheetExport.ExportError ? 409 : 500, { error: e.message }); }
    }

    if (p === '/api/export-spreadsheet') {
      const format = url.searchParams.get('format') || 'xlsx';
      const all = url.searchParams.get('all') === '1';
      const status = url.searchParams.get('status') || '';
      const id = url.searchParams.get('id');
      const many = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 1000);
      const ids = many.length ? many : (id ? [id] : []);
      if (!all && !ids.length && !status) return send(res, 400, { error: 'Choose at least one school to export.' });
      try {
        const out = await spreadsheetExport.buildSpreadsheet({ format, all: all || (!!status && !ids.length), ids, status, tabIndex: Number(url.searchParams.get('tab')) || 0 });
        audit(user, `downloaded ${format.toUpperCase()} spreadsheet (${out.count} school${out.count === 1 ? '' : 's'})`);
        return send(res, 200, out.buffer, out.contentType, {
          'Content-Disposition': `attachment; filename="${out.filename}"`,
          'X-Export-Count': String(out.count),
        });
      } catch (e) {
        return send(res, e instanceof spreadsheetExport.SpreadsheetExportError ? 409 : 500, { error: e.message });
      }
    }

    if (p === '/api/me') return send(res, 200, { email: user.email, name: user.name, local: !!user.local });
    if (p === '/api/ask/status') return send(res, 200, assistant.status(user));
    if (p === '/api/verify') return send(res, 200, verification.forSchool(String(url.searchParams.get('school') || '')));
    if (p === '/api/accuracy') return send(res, 200, { report: verification.report(), sample: verification.sampleProgress() });
    if (p === '/api/review-queue') {
      const q = url.searchParams;
      return send(res, 200, reviewQueue.buildQueue(data, verification.resolved(), { tier: q.get('tier'), field: q.get('field') || null, level: ['check', 'doubtful'].includes(q.get('level')) ? q.get('level') : null }));
    }
    if (p === '/api/accuracy/export') {
      audit(user, 'downloaded the accuracy answer key');
      return send(res, 200, JSON.stringify(verification.exportKey(), null, 1), 'application/json; charset=utf-8', { 'Content-Disposition': `attachment; filename="answer-key-${new Date().toISOString().slice(0, 10)}.json"` });
    }
    if (p === '/api/ask/memory') return send(res, 200, assistant.listMemories(user));
    if (p === '/api/ask/kb') return send(res, 200, { ...assistant.kbStats(user), ...assistant.listKb(user) });
    if (p === '/api/ask/dataset') {
      const jsonl = assistant.exportDatasetJsonl(user);
      const day = new Date().toISOString().slice(0, 10);
      return send(res, 200, jsonl, 'application/x-ndjson; charset=utf-8', {
        'Content-Disposition': `attachment; filename="school-ask-dataset-${day}.jsonl"`,
      });
    }
    if (p === '/api/ask/sessions') return send(res, 200, assistant.listSessions(user));
    if (p === '/api/ask/session') {
      const s = assistant.getSession(user, url.searchParams.get('id'));
      return s ? send(res, 200, s) : send(res, 404, { error: 'Conversation not found.' });
    }
    if (p === '/api/results-package') {
      const { buffer, count } = await resultsPackage.buildPackage({ by: user.email });
      if (!count) return send(res, 404, { error: 'There are no results to share yet. Scrape some schools first.' });
      return send(res, 200, buffer, 'application/zip', { 'Content-Disposition': `attachment; filename="school-results-${new Date().toISOString().slice(0, 10)}.zip"` });
    }
    if (p === '/api/setup') return send(res, 200, { items: checkSetup(), dataDir: PATHS.data, isPortable: !!PATHS.isPortable });
    if (p === '/api/overview') return send(res, 200, overview());
    if (p === '/api/job') return send(res, 200, jobState(Number(url.searchParams.get('since')) || 0));
    if (p === '/api/school') {
      const payload = data.schoolPayload(url.searchParams.get('id'), Number(url.searchParams.get('tab')) || 0);
      if (payload) {
        const ec = sheetExport.publicConfig();
        payload.exported = sheetExport.history()[payload.school.id] || null;
        payload.exportConfigured = !!ec.configured && ec.health !== 'failing';   // a saved address whose last call failed is not offered as a button
        payload.exportFailing = ec.health === 'failing';
      }
      return payload ? send(res, 200, payload) : send(res, 404, { error: 'No such school.' });
    }
    if (p === '/api/code') {
      const file = url.searchParams.get('file');
      if (!file) return send(res, 200, data.codeList(cfg));
      const doc = data.codeFile(file);
      return doc ? send(res, 200, doc) : send(res, 404, { error: 'not found' });
    }

    // static files
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

if (PATHS.isPortable) {
  const bundledExport = path.join(PATHS.root, 'data', 'export-config.json');
  const activeExport = path.join(PATHS.data, 'export-config.json');
  if (bundledExport !== activeExport && fs.existsSync(bundledExport) && !fs.existsSync(activeExport)) {
    try { fs.mkdirSync(PATHS.data, { recursive: true }); fs.copyFileSync(bundledExport, activeExport); } catch { /* ignore */ }
  }
}

function openLocalBrowser(addr) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', addr], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (auth.loopbackOnly && !process.argv.includes('--no-browser')) {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 800 }, (res) => {
        if (res.statusCode === 200) { openLocalBrowser(`http://localhost:${PORT}`); process.exit(0); }
        console.error(`Port ${PORT} is already in use.`);
        process.exit(1);
      });
      req.on('error', () => { console.error(`Port ${PORT} is already in use.`); process.exit(1); });
      return;
    }
    console.error(`Port ${PORT} is already in use. The dashboard may already be open at http://localhost:${PORT}`);
  } else console.error(e);
  process.exit(1);
});
const startupProblems = auth.problems();
if (startupProblems.length) {
  console.error('The program cannot start:\n - ' + startupProblems.join('\n - ') + '\nSee docs/ONLINE-SETUP.md.');
  process.exit(1);
}
if (!auth.loopbackOnly) fs.rmSync(path.join(PATHS.data, 'run.lock'), { force: true });   // a freshly started server has no scrape running
function tickSchedule() {
  try {
    const st = scheduler.load();
    if (!scheduler.isDue(st)) return;
    if (scheduler.isOverdue(st)) {
      if (st.missedPolicy === 'skip') { scheduler.skipMissedRun(); return; }
      if (st.missedPolicy !== 'run') return; // Wait for manual run/skip on dashboard
    }
    if (!data.getSchools()) return;
    if ((job && job.running) || externalRun()) return;
    const cmd = scheduler.scopeCommand(st.scope, st.refresh);
    const r = startJob(cmd.args, cmd.label, 'Auto-scheduler', { scheduled: true });
    if (!r.error) {
      scheduler.markStarted();
      audit({ email: 'scheduler' }, 'started scheduled website check: ' + cmd.label);
    }
  } catch { /* retry next tick */ }
}

server.listen(PORT, auth.settings.host, () => {
  const addr = auth.settings.publicUrl || `http://localhost:${PORT}`;
  console.log(`School Information Sheet dashboard: ${addr}${auth.enabled ? ' (team sign-in on)' : ''}`);
  if (auth.loopbackOnly && !process.argv.includes('--no-browser')) openLocalBrowser(addr);
  setTimeout(tickSchedule, 5000).unref();
  setInterval(tickSchedule, 30000).unref();
});
process.on('exit', () => { if (job && job.running) job.child.kill(); });
process.on('SIGINT', () => process.exit(0));
