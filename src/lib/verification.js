'use strict';
// Spot-checks: a person marks what the scraper found as right or wrong (or marks what it missed) and the dashboard turns those
// checks into accuracy figures. Saved in data/verification.json (the data folder is never published).
//
// Four verdicts, depending on what the scraper had for that field:
//   it found a value  -> "correct" or "wrong"
//   it found nothing  -> "missed" (the school's site does have the answer) or "absent" (it is not on the site, so blank is right)
// A check remembers what the scraper had when it was made. If a later scrape changes that value the check is "stale": it is shown
// as needing another look and is left out of the figures, so the figures never mix an old verdict with a new answer.
const crypto = require('crypto');
const path = require('path');
const { PATHS, readJson, writeJson, clip, oneLine } = require('./util');

// The fields that matter most when numbers go into a family's decision, and so the ones a sample asks about.
const KEY_FIELDS = ['tuition', 'enrollment', 'ratio', 'classSize', 'facultyDegrees', 'location', 'grades', 'applicationOpenDate', 'decisionDate', 'collegeEnrollment', 'counselors', 'testScores'];
const VERDICTS = ['correct', 'wrong', 'missed', 'absent'];
const MIN_CHECKS = 10;                       // with fewer checks than this a rate is only a hint
const BARS = { trust: 0.95, review: 0.85 };  // rules of thumb for "right when it answers"
const SAMPLE_DEFAULT = 30;

class VerificationError extends Error {}     // the message is safe to show

/** 95% Wilson score interval for k right out of n: an honest range for a small sample. */
function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function metrics(c) {
  const answered = c.correct + c.wrong;
  const recallDen = c.correct + c.missed + c.wrongWithTruth;   // facts that really are on the site and were checked
  const precision = answered ? c.correct / answered : null;
  return {
    checks: c.correct + c.wrong + c.missed + c.absent,
    correct: c.correct, wrong: c.wrong, missed: c.missed, absent: c.absent,
    rightWhenItAnswers: precision, range: wilson(c.correct, answered),
    findsWhatIsThere: recallDen ? c.correct / recallDen : null,
    status: answered < MIN_CHECKS ? 'few' : precision >= BARS.trust ? 'trust' : precision >= BARS.review ? 'review' : 'always-review',
  };
}
const blank = () => ({ correct: 0, wrong: 0, wrongWithTruth: 0, missed: 0, absent: 0 });
const bump = (c, check) => {
  c[check.verdict]++;
  if (check.verdict === 'wrong' && check.truth) c.wrongWithTruth++;
};

/** data: the dashboard-data module (or anything with getSchools, getTemplate, getResult and overview). */
function createVerification({ file = path.join(PATHS.data, 'verification.json'), data } = {}) {
  const read = () => {
    const s = readJson(file, null);
    return { version: 1, checks: s && typeof s.checks === 'object' && s.checks ? s.checks : {}, sample: s && s.sample ? s.sample : null };
  };
  const save = (s) => writeJson(file, s, { mode: 0o600 });
  const keyOf = (schoolId, field) => `${schoolId}|${field}`;

  const schoolById = (id) => {
    const l = data.getSchools();
    const s = l && l.schools.find((x) => x.id === id);
    if (!s) throw new VerificationError('No such school.');
    return s;
  };
  const fieldRow = (field) => {
    const t = data.getTemplate();
    const row = t && t.rows.find((r) => r.kind === 'field' && r.key === field);
    if (!row || !row.hasRule) throw new VerificationError('That is not a field the scraper looks up.');
    return row;
  };
  /** What the scraper has for this field right now. */
  function current(schoolId, field) {
    const r = data.getResult(schoolId);
    if (!r || r.status !== 'ok') throw new VerificationError('This school has not been scraped successfully, so there is nothing to check yet.');
    const sc = r.fields && r.fields[field];
    const found = !!(sc && sc.status === 'found');
    return { found, value: found ? clip(String(sc.value), 300) : '', confidence: found ? sc.confidence || null : null, scrapedAt: r.scrapedAt || null, scraperVersion: r.scraperVersion || null };
  }
  const isStale = (c) => {
    try {
      const cur = current(c.schoolId, c.field);
      return !!c.snapshot && (c.snapshot.found !== cur.found || c.snapshot.value !== cur.value);
    } catch { return true; }
  };

  /** Records (or replaces) one check. */
  function record({ schoolId, field, verdict, truth, truthUrl, note, by, trust }) {
    if (!VERDICTS.includes(verdict)) throw new VerificationError('Choose right, wrong, missed or not on the site.');
    schoolById(schoolId);
    fieldRow(field);
    const cur = current(schoolId, field);
    if (cur.found && (verdict === 'missed' || verdict === 'absent')) throw new VerificationError('The scraper did find a value here: mark it right or wrong.');
    if (!cur.found && (verdict === 'correct' || verdict === 'wrong')) throw new VerificationError('The scraper found nothing here: mark it as missed (the site has the answer) or not on the site.');
    const url = String(truthUrl || '').trim();
    if (url && !/^https?:\/\/\S{3,480}$/i.test(url)) throw new VerificationError('The page link should start with http:// or https://');
    const entry = {
      schoolId, field, verdict,
      ...(truth && ['wrong', 'missed'].includes(verdict) ? { truth: clip(oneLine(truth), 500) } : {}),
      ...(url && ['wrong', 'missed', 'correct'].includes(verdict) ? { truthUrl: url } : {}),
      ...(note ? { note: clip(oneLine(note), 300) } : {}),
      by: by || null, at: new Date().toISOString(),
      // what the trust score said at the time, so the Accuracy tab can show whether the score's levels hold up
      snapshot: trust && Number.isFinite(trust.score) && ['high', 'medium', 'low'].includes(trust.level) ? { ...cur, trust: { score: trust.score, level: trust.level } } : cur,
    };
    const s = read();
    s.checks[keyOf(schoolId, field)] = entry;
    save(s);
    return { ...entry, stale: false };
  }

  /** "schoolId|field" for every check that still applies (not stale): the person has decided those, so they leave the review queue. */
  function resolved() {
    const out = new Set();
    for (const c of Object.values(read().checks)) if (!isStale(c)) out.add(keyOf(c.schoolId, c.field));
    return out;
  }

  function remove(schoolId, field) {
    const s = read();
    delete s.checks[keyOf(schoolId, field)];
    save(s);
  }

  /** The checks made for one school, by field. */
  function forSchool(schoolId) {
    const out = {};
    for (const c of Object.values(read().checks)) if (c.schoolId === schoolId) out[c.field] = { ...c, stale: isStale(c) };
    return out;
  }

  // ----------------------------------------------------------------- sample ---
  /** Picks schools (spread across tiers in proportion) that the scraper read successfully, to be checked on the key fields. */
  function drawSample({ schools = SAMPLE_DEFAULT, seed } = {}) {
    const ov = data.overview();
    const pool = ov && ov.ready ? ov.schools.filter((s) => s.status === 'ok' && !s.wrongSite) : [];
    if (!pool.length) throw new VerificationError('No school has been scraped successfully yet, so there is nothing to check.');
    const want = Math.max(1, Math.min(100, Math.floor(Number(schools)) || SAMPLE_DEFAULT));
    const total = Math.min(want, pool.length);
    const rnd = mulberry32(seed != null ? Number(seed) : crypto.randomBytes(4).readUInt32LE());
    const tiers = new Map();
    for (const s of pool) { const t = s.tier == null ? 0 : s.tier; if (!tiers.has(t)) tiers.set(t, []); tiers.get(t).push(s); }
    // proportional quota per tier, rounded, then corrected so the quotas add up to the total
    const quota = new Map([...tiers].map(([t, list]) => [t, Math.min(list.length, Math.round((total * list.length) / pool.length))]));
    const sum = () => [...quota.values()].reduce((a, b) => a + b, 0);
    const order = [...tiers].sort((a, b) => b[1].length - a[1].length).map(([t]) => t);
    while (sum() < total) { const t = order.find((x) => quota.get(x) < tiers.get(x).length); if (t == null) break; quota.set(t, quota.get(t) + 1); }
    while (sum() > total) { const t = order.find((x) => quota.get(x) > 0); quota.set(t, quota.get(t) - 1); }
    const picked = [];
    for (const [t, list] of tiers) {
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      picked.push(...a.slice(0, quota.get(t)));
    }
    picked.sort((a, b) => a.name.localeCompare(b.name));
    const sample = { id: crypto.randomBytes(5).toString('hex'), drawnAt: new Date().toISOString(), fields: KEY_FIELDS.slice(), schools: picked.map((s) => ({ id: s.id, name: s.name, tier: s.tier == null ? null : s.tier })) };
    const s = read();
    s.sample = sample;
    save(s);
    return sampleProgress();
  }
  function clearSample() { const s = read(); s.sample = null; save(s); }

  /** The current sample with how many of its checks are done, school by school. */
  function sampleProgress() {
    const s = read();
    if (!s.sample) return null;
    const live = new Set(Object.values(s.checks).filter((c) => !isStale(c)).map((c) => keyOf(c.schoolId, c.field)));
    const schools = s.sample.schools.map((x) => {
      const done = s.sample.fields.filter((f) => live.has(keyOf(x.id, f))).length;
      return { ...x, done, total: s.sample.fields.length };
    });
    const done = schools.reduce((a, x) => a + x.done, 0), total = schools.reduce((a, x) => a + x.total, 0);
    return { id: s.sample.id, drawnAt: s.sample.drawnAt, fields: s.sample.fields, schools, done, total };
  }

  // ----------------------------------------------------------------- report ---
  const labelOf = (field) => { try { return String(fieldRow(field).label).replace(/:$/, ''); } catch { return field; } };

  /** Everything the Accuracy page shows. Stale checks are counted separately and left out of every rate. */
  function report() {
    const all = Object.values(read().checks);
    const live = [], stale = [];
    for (const c of all) (isStale(c) ? stale : live).push(c);
    const overall = blank(), perField = new Map(), perConf = new Map(), perTrust = new Map();
    for (const c of live) {
      bump(overall, c);
      if (!perField.has(c.field)) perField.set(c.field, blank());
      bump(perField.get(c.field), c);
      if (c.verdict === 'correct' || c.verdict === 'wrong') {
        const level = (c.snapshot && c.snapshot.confidence) || 'unknown';
        if (!perConf.has(level)) perConf.set(level, blank());
        bump(perConf.get(level), c);
        const tl = c.snapshot && c.snapshot.trust && c.snapshot.trust.level;
        if (tl) { if (!perTrust.has(tl)) perTrust.set(tl, blank()); bump(perTrust.get(tl), c); }
      }
    }
    const fieldOrder = (f) => { const i = KEY_FIELDS.indexOf(f); return i < 0 ? 99 : i; };
    const names = new Map((data.getSchools() ? data.getSchools().schools : []).map((s) => [s.id, s.name]));
    return {
      minChecks: MIN_CHECKS, bars: BARS, keyFields: KEY_FIELDS.map((f) => ({ key: f, label: labelOf(f) })),
      overall: metrics(overall),
      fields: [...perField].sort((a, b) => fieldOrder(a[0]) - fieldOrder(b[0]) || a[0].localeCompare(b[0])).map(([key, c]) => ({ key, label: labelOf(key), ...metrics(c) })),
      confidence: ['high', 'medium', 'low', 'unknown'].filter((l) => perConf.has(l)).map((level) => ({ level, ...metrics(perConf.get(level)) })),
      // does the trust score work? values it called Ready to use should be right far more often than the Doubtful ones
      trust: ['high', 'medium', 'low'].filter((l) => perTrust.has(l)).map((level) => ({ level, ...metrics(perTrust.get(level)) })),
      staleChecks: stale.length,
      errors: live.filter((c) => c.verdict === 'wrong' || c.verdict === 'missed')
        .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 200)
        .map((c) => ({ schoolId: c.schoolId, school: names.get(c.schoolId) || c.schoolId, field: c.field, label: labelOf(c.field), verdict: c.verdict, found: c.snapshot && c.snapshot.found ? c.snapshot.value : null, truth: c.truth || null, truthUrl: c.truthUrl || null, note: c.note || null, at: c.at })),
    };
  }

  /** The checks as a file a person can keep: this is the answer key. */
  function exportKey() {
    const names = new Map((data.getSchools() ? data.getSchools().schools : []).map((s) => [s.id, s.name]));
    return {
      kind: 'school-info-answer-key', format: 1, exportedAt: new Date().toISOString(),
      checks: Object.values(read().checks).map((c) => ({ school: names.get(c.schoolId) || c.schoolId, schoolId: c.schoolId, field: c.field, verdict: c.verdict, truth: c.truth || null, truthUrl: c.truthUrl || null, note: c.note || null, scraperHad: c.snapshot, by: c.by, at: c.at })),
    };
  }

  return { record, remove, resolved, forSchool, drawSample, clearSample, sampleProgress, report, exportKey, file };
}

module.exports = { createVerification, VerificationError, KEY_FIELDS, VERDICTS, MIN_CHECKS, BARS, wilson };
