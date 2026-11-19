'use strict';
// School Information Sheet scraper.
// Reads each school's own public website and fills the Master Template fields by rule.
//
//   node src/scrape.js --tier 1            every Tier 1 school
//   node src/scrape.js --school "Castilleja (Upper) School"     one school (name or id)
//   node src/scrape.js --pending           schools not scraped yet
//   node src/scrape.js --all               the whole PSTP list
// Options:
//   --refresh        ignore the page cache and download everything again
//   --limit 10       stop after 10 schools
//   --progress-json  machine-readable progress (used by the dashboard)
const fs = require('fs');
const path = require('path');
const { PATHS, loadConfig, readJson, writeJson, alnum } = require('./lib/util');
const { Fetcher } = require('./lib/fetcher');
const { crawlSite, cleanStart } = require('./lib/crawl');
const { extractSchool } = require('./lib/rules');
const { siteIdentity } = require('./lib/identity');
const { diffFields } = require('./lib/changes');
const { keepSavedPages } = require('./lib/manual-pages');
const sources = require('./lib/sources');   // answers from pages saved by hand from Ravenna, Niche and the review sites fill what the website left empty
const scheduler = require('./lib/scheduler');
const { createSlack } = require('./lib/slack');

const SCRAPER_VERSION = '1.1.0';

// Only one scrape may run at a time (two would double the load on the school websites).
// The running scrape leaves a small note here that the dashboard also reads.
const LOCK = path.join(PATHS.data, 'run.lock');
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function otherRun() {
  const l = readJson(LOCK);
  return l && l.pid !== process.pid && pidAlive(l.pid) && Date.now() - l.startedAt < 36 * 3600e3 ? l : null;
}
function writeLock(info) { try { writeJson(LOCK, { pid: process.pid, ...info }); } catch { /* not fatal */ } }
function clearLock() { try { const l = readJson(LOCK); if (l && l.pid === process.pid) fs.unlinkSync(LOCK); } catch { /* not fatal */ } }

function parseArgs(argv) {
  const a = { tier: null, school: [], all: false, pending: false, refresh: false, headless: true, runDue: false, limit: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tier') a.tier = Number(argv[++i]);
    else if (k === '--school') a.school.push(argv[++i]);   // may be given more than once
    else if (k === '--all') a.all = true;
    else if (k === '--pending') a.pending = true;
    else if (k === '--refresh') a.refresh = true;
    else if (k === '--no-headless') a.headless = false;
    else if (k === '--run-due') a.runDue = true;
    else if (k === '--limit') a.limit = Number(argv[++i]);
    else if (k === '--progress-json') a.json = true;
  }
  return a;
}

function pickSchools(all, a) {
  let list;
  if (a.school.length) {
    list = [];
    for (const q of a.school) {
      const want = alnum(q);
      let hit = all.filter((s) => s.id === q || alnum(s.name) === want);
      if (!hit.length) hit = all.filter((s) => alnum(s.name).includes(want));
      for (const s of hit) if (!list.includes(s)) list.push(s);
    }
  } else if (a.tier != null) list = all.filter((s) => s.tier === a.tier);
  else if (a.pending) list = all.filter((s) => !fs.existsSync(path.join(PATHS.resultsDir, s.id + '.json')));
  else if (a.all) list = all;
  else return null;
  // long runs start with Tier 1, then Tier 2, then Tier 3
  if (a.pending || a.all) list = list.slice().sort((x, y) => (x.tier || 9) - (y.tier || 9));
  return a.limit ? list.slice(0, a.limit) : list;
}

function summarize(fields) {
  const n = { found: 0, none: 0, manual: 0 };
  for (const f of Object.values(fields)) n[f.status === 'found' ? 'found' : f.status === 'manual' ? 'manual' : 'none']++;
  return n;
}

async function main() {
  let args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  const data = readJson(PATHS.schools);
  if (!data) { console.error('No school list yet. Run:  node src/import-workbook.js'); process.exit(args.runDue ? 0 : 1); }

  let dueSchedule = null;
  let scheduledLabel = null;
  if (args.runDue) {
    const st = scheduler.load();
    if (!scheduler.isDue(st)) { console.log('No scheduled check due yet.'); process.exit(0); }
    const cmd = scheduler.scopeCommand(st.scope, st.refresh);
    const parsedCmd = parseArgs(cmd.args);
    args = { ...args, ...parsedCmd, runDue: true, headless: args.headless, json: args.json };
    dueSchedule = st;
    scheduledLabel = cmd.label;
  }

  const targets = pickSchools(data.schools, args);
  if (!targets) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  if (!targets.length) { console.error('No schools matched.'); process.exit(args.runDue ? 0 : 1); }
  const busy = otherRun();
  if (busy) {
    if (args.runDue) { console.log('Skipped scheduled run because another scrape is already running.'); process.exit(0); }
    console.error(`Another scrape is already running (${busy.label}, ${busy.done || 0} of ${busy.schools} schools done). Wait for it to finish or stop it first.`);
    process.exit(2);
  }
  if (dueSchedule) scheduler.markStarted();
  const label = scheduledLabel || (args.school.length ? (targets.length === 1 ? targets[0].name : `${targets.length} selected schools`)
    : args.tier != null ? `Tier ${args.tier} schools` : args.pending ? 'Schools not scraped yet' : 'All schools');
  const lock = { label, startedAt: Date.now(), schools: targets.length, sites: 0, done: 0, sitesDone: 0 };
  writeLock(lock);
  process.on('exit', clearLock);
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  const emit = (ev) => {
    if (args.json) process.stdout.write(JSON.stringify(ev) + '\n');
    else if (ev.type === 'site-start') console.log(`\n> ${ev.start}  (${ev.schools.join(', ')})`);
    else if (ev.type === 'school-done') console.log(`  ${ev.status === 'ok' ? 'done ' : ev.status.toUpperCase() + ' '} ${ev.name}: ${ev.found} of ${ev.total} fields found${ev.detail ? ' - ' + ev.detail : ''}`);
    else if (ev.type === 'done') console.log(`\nFinished: ${ev.schools} schools, ${ev.sites} websites, ${ev.requests} pages downloaded, ${ev.cacheHits} from cache, ${Math.round(ev.ms / 1000)}s.`);
  };

  // schools that share a website (lower / middle / upper divisions) share one crawl
  const groups = new Map();
  const now = new Date();
  for (const s of targets) {
    if (!s.website) {
      writeJson(path.join(PATHS.resultsDir, s.id + '.json'), { id: s.id, name: s.name, scrapedAt: now.toISOString(), scraperVersion: SCRAPER_VERSION, status: 'no-website', detail: 'The list has no website link for this school.', pages: [], fields: {} });
      let other = null;
      try { other = await sources.reapply(s, now); } catch { /* nothing saved from other sources */ }
      emit({ type: 'school-done', id: s.id, name: s.name, status: other ? 'ok' : 'no-website', found: other ? other.counts.found : 0, total: other ? other.counts.found + other.counts.none : 0 });
      continue;
    }
    let start;
    try { start = cleanStart(s.website); } catch { start = s.website; }
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(s);
  }

  const fetcher = new Fetcher(cfg, { refresh: args.refresh, headlessFallback: args.headless });
  const queue = [...groups.entries()];
  const t0 = Date.now();
  let doneSchools = 0;
  const tpl = readJson(PATHS.template);
  const labelsMap = new Map(((tpl && tpl.rows) || []).filter((r) => r.kind === 'field' && r.key).map((r) => [r.key, String(r.label || r.key).replace(/:$/, '')]));
  const scheduledChanges = [];
  lock.sites = queue.length;
  writeLock(lock);
  emit({ type: 'start', sites: queue.length, schools: targets.length });

  const worker = async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const [start, schools] = next;
      const t1 = Date.now();
      emit({ type: 'site-start', start, schools: schools.map((s) => s.name) });
      let crawl;
      try {
        crawl = await crawlSite(start, fetcher, cfg, (ev) => emit({ ...ev, start }));
      } catch (e) {
        crawl = { status: 'error', detail: e.message, start, pages: [], portals: [], skipped: [] };
      }
      for (const s of schools) {
        // a website that still refuses automatic reading must not wipe out answers read from pages a person saved by hand
        const savedFile = path.join(PATHS.resultsDir, s.id + '.json');
        const saved = readJson(savedFile, null);
        if (keepSavedPages(saved, crawl)) {
          writeJson(savedFile, { ...saved, lastAttempt: { at: new Date().toISOString(), status: crawl.status, detail: crawl.detail } });
          doneSchools++;
          const n = saved.counts || { found: 0, none: 0 };
          emit({ type: 'school-done', id: s.id, name: s.name, status: 'ok', detail: 'the website still refuses automatic reading, so the answers read from pages saved by hand were kept',
            found: n.found, total: n.found + n.none, changesCount: 0, changes: [], wrongSite: false, done: doneSchools, of: targets.length });
          continue;
        }
        let fields = {};
        if (crawl.status === 'ok') {
          try { fields = extractSchool(s, crawl, now); } catch (e) { crawl = { ...crawl, status: 'error', detail: 'rules failed: ' + e.message }; }
        }
        const counts = summarize(fields);
        let identity = null;
        if (crawl.status === 'ok') { try { identity = siteIdentity(s, crawl.pages.filter((p) => p.ok)); } catch { /* the check is only a warning */ } }
        const outFile = path.join(PATHS.resultsDir, s.id + '.json');
        const prev0 = readJson(outFile, null);
        const prev = prev0 && prev0.websiteFields ? { ...prev0, fields: prev0.websiteFields } : prev0;   // answers from other sources are not website updates
        const changes = crawl.status === 'ok' ? diffFields(prev, fields) : [];
        const stamp = new Date().toISOString();
        const changedAt = changes.length ? stamp : (prev && prev.changedAt || null);
        writeJson(outFile, {
          id: s.id, name: s.name, scrapedAt: stamp, scraperVersion: SCRAPER_VERSION,
          start, status: crawl.status, detail: crawl.detail, ms: Date.now() - t1, counts, identity,
          changes, changedAt,
          pages: crawl.pages.map((p) => ({ url: p.finalUrl, title: p.title || p.linkText || '', topics: p.topics || [], kind: p.kind, chars: p.mainChars || 0, fetchedAt: p.fetchedAt })),
          portals: crawl.portals, skipped: crawl.skipped, fields,
        });
        // pages saved by hand from Ravenna, Niche ... fill what the website left empty (and keep an unreadable website from hiding them)
        let status = crawl.status, detail = crawl.detail, found = counts.found, total = counts.found + counts.none;
        try {
          const other = await sources.reapply(s, now);
          if (other) { status = 'ok'; detail = null; found = other.counts.found; total = other.counts.found + other.counts.none; }
        } catch { /* the website answers are saved either way */ }
        doneSchools++;
        if (dueSchedule && changes.length) {
          scheduledChanges.push({
            id: s.id,
            name: s.name,
            wrongSite: !!(identity && identity.ok === false),   // the listed website does not look like this school
            fields: changes.map((c) => ({ ...c, label: labelsMap.get(c.key) || c.key })),   // every changed field, in full
          });
        }
        emit({
          type: 'school-done', id: s.id, name: s.name, status, detail,
          found, total,
          changesCount: changes.length, changes, wrongSite: !!(identity && identity.ok === false),
          done: doneSchools, of: targets.length,
        });
      }
      lock.done = doneSchools; lock.sitesDone++;
      writeLock(lock);
      emit({ type: 'site-done', start, status: crawl.status, pages: crawl.pages.length });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, cfg.crawl.parallelSites) }, worker));
  const durationMs = Date.now() - t0;
  if (dueSchedule) {
    scheduler.markFinished({ status: 'ok', summary: { label, schools: doneSchools, updatedSchools: scheduledChanges.length } });
    await createSlack().notifyRun({
      label, scheduled: true, stopped: false, exitCode: 0,
      schoolsDone: doneSchools, schoolsTotal: targets.length, durationMs, changes: scheduledChanges,
    }).catch(() => {});
  }
  emit({ type: 'done', schools: targets.length, sites: groups.size, requests: fetcher.requests, cacheHits: fetcher.cacheHits, ms: durationMs });
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
