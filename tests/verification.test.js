'use strict';
// Checks the spot-check / accuracy feature: what a check may say, how rates and ranges are worked out, stale checks, the sample,
// and the real server over HTTP.
//   node tests/verification.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { createVerification, VerificationError, KEY_FIELDS, wilson } = require('../src/lib/verification');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));

// ------------------------------------------------------------------ fixtures ---
/** A made-up school list shaped like the dashboard's saved data. n schools, tiers 1/2/3 in the given counts. */
function world(counts = { 1: 20, 2: 10, 3: 5 }) {
  const schools = [], results = {};
  let i = 0;
  for (const [tier, n] of Object.entries(counts)) {
    for (let k = 0; k < n; k++) {
      const id = `s${++i}`;
      schools.push({ id, name: `School ${String(i).padStart(2, '0')}`, tier: Number(tier) });
      results[id] = { status: 'ok', scrapedAt: '2026-11-01T00:00:00Z', scraperVersion: '1.1.0', fields: {
        tuition: { status: 'found', value: `$${40000 + i}`, confidence: i % 2 ? 'high' : 'low' },
        enrollment: { status: 'none' },
        notes: { status: 'manual' },
      } };
    }
  }
  const template = { rows: [
    { kind: 'name', key: 'schoolName', label: 'School Name' },
    ...KEY_FIELDS.map((f) => ({ kind: 'field', key: f, label: f.charAt(0).toUpperCase() + f.slice(1) + ':', hasRule: true })),
    { kind: 'field', key: 'notes', label: 'Further Notes', hasRule: false },
  ] };
  const data = {
    getSchools: () => ({ schools }),
    getTemplate: () => template,
    getResult: (id) => results[id] || null,
    overview: () => ({ ready: true, schools: schools.map((s) => ({ ...s, status: results[s.id] ? results[s.id].status : 'not-scraped', wrongSite: !!(results[s.id] && results[s.id].wrong) })) }),
  };
  return { schools, results, data };
}

const request = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
    let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});

(async () => {
  // ============================================ what a check may say =========
  {
    const w = world();
    const file = path.join(tmp(), 'v.json');
    const v = createVerification({ file, data: w.data });
    const right = v.record({ schoolId: 's1', field: 'tuition', verdict: 'correct', by: 'pat@example.org' });
    assert.strictEqual(right.verdict, 'correct'); assert.strictEqual(right.snapshot.found, true); assert.strictEqual(right.snapshot.value, '$40001'); assert.strictEqual(right.snapshot.confidence, 'high');
    assert.throws(() => v.record({ schoolId: 's1', field: 'tuition', verdict: 'missed' }), /did find a value/);
    assert.throws(() => v.record({ schoolId: 's1', field: 'tuition', verdict: 'absent' }), VerificationError);
    assert.throws(() => v.record({ schoolId: 's1', field: 'enrollment', verdict: 'correct' }), /found nothing/);
    assert.throws(() => v.record({ schoolId: 's1', field: 'enrollment', verdict: 'wrong' }), VerificationError);
    assert.throws(() => v.record({ schoolId: 's1', field: 'tuition', verdict: 'maybe' }), /Choose right, wrong/);
    assert.throws(() => v.record({ schoolId: 'nope', field: 'tuition', verdict: 'correct' }), /No such school/);
    assert.throws(() => v.record({ schoolId: 's1', field: 'notes', verdict: 'correct' }), /not a field the scraper looks up/);
    assert.throws(() => v.record({ schoolId: 's1', field: 'tuition', verdict: 'wrong', truthUrl: 'javascript:alert(1)' }), /http/);
    w.results.s2.status = 'blocked';
    assert.throws(() => v.record({ schoolId: 's2', field: 'tuition', verdict: 'correct' }), /not been scraped successfully/);
    const wrong = v.record({ schoolId: 's3', field: 'tuition', verdict: 'wrong', truth: '  $38,000\n per year ', truthUrl: 'https://school.example/tuition', note: 'old page' });
    assert.strictEqual(wrong.truth, '$38,000 per year'); assert.strictEqual(wrong.truthUrl, 'https://school.example/tuition');
    const missed = v.record({ schoolId: 's3', field: 'enrollment', verdict: 'missed', truth: '450' });
    assert.strictEqual(missed.truth, '450');
    assert.strictEqual(v.record({ schoolId: 's4', field: 'enrollment', verdict: 'absent', truth: 'ignored' }).truth, undefined, 'a "not on the site" check carries no value');
    // the same field checked again replaces the earlier check; checks survive a restart; undo removes one
    v.record({ schoolId: 's1', field: 'tuition', verdict: 'wrong' });
    assert.strictEqual(v.forSchool('s1').tuition.verdict, 'wrong');
    const again = createVerification({ file, data: w.data });
    assert.strictEqual(again.forSchool('s3').enrollment.truth, '450');
    again.remove('s1', 'tuition');
    assert.deepStrictEqual(Object.keys(again.forSchool('s1')), []);
    ok('a check must fit what the scraper had; links are validated; a re-check replaces the old one; checks persist and can be undone');
  }

  // ============================================ stale checks =================
  {
    const w = world({ 1: 3 });
    const v = createVerification({ file: path.join(tmp(), 'v.json'), data: w.data });
    for (const id of ['s1', 's2', 's3']) v.record({ schoolId: id, field: 'tuition', verdict: 'correct' });
    assert.strictEqual(v.report().overall.checks, 3);
    w.results.s1.scrapedAt = '2026-11-20T00:00:00Z';   // re-scraped, same value: the check still holds
    assert.strictEqual(v.forSchool('s1').tuition.stale, false);
    w.results.s2.fields.tuition.value = '$99,999';       // re-scraped and the value changed: the old verdict no longer applies
    assert.strictEqual(v.forSchool('s2').tuition.stale, true);
    const rep = v.report();
    assert.strictEqual(rep.overall.checks, 2); assert.strictEqual(rep.staleChecks, 1, 'a stale check is counted apart and left out of every rate');
    v.record({ schoolId: 's2', field: 'tuition', verdict: 'wrong' });
    assert.strictEqual(v.forSchool('s2').tuition.stale, false); assert.strictEqual(v.report().staleChecks, 0);
    ok('a check goes stale when the scraped value changes, and stale checks stay out of the figures');
  }

  // ============================================ the figures ==================
  {
    // Wilson range sanity
    const w95 = wilson(19, 20);
    assert.ok(w95.low > 0.7 && w95.low < 0.95 && w95.high > 0.95 && w95.high <= 1);
    assert.strictEqual(wilson(0, 0), null);
    assert.ok(wilson(5, 5).low < 0.6, 'five right out of five is not proof of 100%');

    const w = world({ 1: 30 });
    const v = createVerification({ file: path.join(tmp(), 'v.json'), data: w.data });
    // tuition: 20 answered, 18 right, 2 wrong (one with the true value) ; enrollment: 3 missed, 2 not on the site
    for (let i = 1; i <= 18; i++) v.record({ schoolId: `s${i}`, field: 'tuition', verdict: 'correct' });
    v.record({ schoolId: 's19', field: 'tuition', verdict: 'wrong', truth: '$1' });
    v.record({ schoolId: 's20', field: 'tuition', verdict: 'wrong' });
    for (let i = 21; i <= 23; i++) v.record({ schoolId: `s${i}`, field: 'enrollment', verdict: 'missed' });
    for (let i = 24; i <= 25; i++) v.record({ schoolId: `s${i}`, field: 'enrollment', verdict: 'absent' });
    const rep = v.report();
    const t = rep.fields.find((f) => f.key === 'tuition'), e = rep.fields.find((f) => f.key === 'enrollment');
    assert.strictEqual(t.checks, 20); assert.strictEqual(t.rightWhenItAnswers, 0.9);
    assert.ok(t.range.low < 0.9 && t.range.high > 0.9);
    assert.ok(Math.abs(t.findsWhatIsThere - 18 / 19) < 1e-9, 'a wrong answer where the true value is known counts against "finds what is there"');
    assert.strictEqual(t.status, 'review', '90% sits between the bars');
    assert.strictEqual(e.rightWhenItAnswers, null); assert.strictEqual(e.findsWhatIsThere, 0); assert.strictEqual(e.status, 'few');
    assert.strictEqual(rep.overall.checks, 25); assert.strictEqual(rep.overall.wrong, 2); assert.strictEqual(rep.overall.missed, 3);
    assert.deepStrictEqual(rep.fields.map((f) => f.key), ['tuition', 'enrollment'], 'fields follow the key-field order');
    // the confidence marks: the fixture gives odd schools "high" and even ones "low"
    const hi = rep.confidence.find((c) => c.level === 'high'), lo = rep.confidence.find((c) => c.level === 'low');
    assert.strictEqual(hi.checks + lo.checks, 20); assert.strictEqual(hi.checks, 10); assert.strictEqual(hi.wrong, 1); assert.strictEqual(lo.wrong, 1);
    assert.strictEqual(hi.rightWhenItAnswers, 0.9); assert.strictEqual(lo.rightWhenItAnswers, 0.9);
    // mistakes list: both wrong answers and the three misses, with the true value where known
    assert.strictEqual(rep.errors.length, 5);
    const withTruth = rep.errors.find((x) => x.truth === '$1');
    assert.ok(withTruth && withTruth.school === 'School 19' && withTruth.found === '$40019');
    assert.strictEqual(rep.errors.filter((x) => x.verdict === 'missed').length, 3);
    // bars
    const reliable = world({ 1: 12 });
    const v2 = createVerification({ file: path.join(tmp(), 'v2.json'), data: reliable.data });
    for (let i = 1; i <= 12; i++) v2.record({ schoolId: `s${i}`, field: 'tuition', verdict: 'correct' });
    assert.strictEqual(v2.report().fields[0].status, 'trust');
    const bad = world({ 1: 12 });
    const v3 = createVerification({ file: path.join(tmp(), 'v3.json'), data: bad.data });
    for (let i = 1; i <= 12; i++) v3.record({ schoolId: `s${i}`, field: 'tuition', verdict: i <= 9 ? 'correct' : 'wrong' });
    assert.strictEqual(v3.report().fields[0].status, 'always-review', '75% is under the lower bar');
    ok('rates, 95% ranges, "finds what is there", confidence marks, status bars and the mistakes list come out right');
  }

  // ============================================ the sample ===================
  {
    const w = world({ 1: 20, 2: 10, 3: 5 });
    w.results.s1.wrong = true;           // a wrong-website school is never drawn
    w.results.s2.status = 'blocked';     // nor one that could not be read
    const v = createVerification({ file: path.join(tmp(), 'v.json'), data: w.data });
    const a = v.drawSample({ schools: 14, seed: 7 });
    assert.strictEqual(a.schools.length, 14); assert.strictEqual(a.total, 14 * KEY_FIELDS.length); assert.strictEqual(a.done, 0);
    assert.ok(!a.schools.some((s) => s.id === 's1' || s.id === 's2'), 'wrong-website and unread schools are left out');
    const perTier = (list) => list.reduce((m, s) => ((m[s.tier] = (m[s.tier] || 0) + 1), m), {});
    const t = perTier(a.schools);
    assert.ok(t[1] >= 6 && t[1] <= 8 && t[2] >= 3 && t[2] <= 5 && t[3] >= 1 && t[3] <= 3, 'the tiers are represented in proportion: ' + JSON.stringify(t));
    const b = v.drawSample({ schools: 14, seed: 7 });
    assert.deepStrictEqual(b.schools.map((s) => s.id), a.schools.map((s) => s.id), 'the same seed draws the same schools');
    assert.notDeepStrictEqual(v.drawSample({ schools: 14, seed: 8 }).schools.map((s) => s.id), a.schools.map((s) => s.id));
    assert.strictEqual(v.drawSample({ schools: 500, seed: 1 }).schools.length, 33, 'cannot ask for more schools than were read (35 minus the wrong-website and the unread one)');
    // progress counts the checks made on the key fields of the sampled schools
    const s0 = a.schools[0].id;
    v.drawSample({ schools: 14, seed: 7 });
    v.record({ schoolId: s0, field: 'tuition', verdict: 'correct' });
    v.record({ schoolId: s0, field: 'enrollment', verdict: 'absent' });
    const p = v.sampleProgress();
    assert.strictEqual(p.done, 2); assert.strictEqual(p.schools.find((s) => s.id === s0).done, 2);
    v.clearSample();
    assert.strictEqual(v.sampleProgress(), null); assert.strictEqual(v.report().overall.checks, 2, 'clearing the list keeps the checks');
    assert.throws(() => createVerification({ file: path.join(tmp(), 'e.json'), data: { ...w.data, overview: () => ({ ready: true, schools: [] }) } }).drawSample(), /No school has been scraped/);
    ok('the sample is spread across tiers, skips unreadable and wrong-website schools, repeats with the same seed and tracks progress');
  }

  // ============================================ the answer key ===============
  {
    const w = world({ 1: 3 });
    const v = createVerification({ file: path.join(tmp(), 'v.json'), data: w.data });
    v.record({ schoolId: 's1', field: 'tuition', verdict: 'wrong', truth: '$1', by: 'pat@example.org' });
    const key = v.exportKey();
    assert.strictEqual(key.kind, 'school-info-answer-key'); assert.strictEqual(key.checks.length, 1);
    assert.deepStrictEqual([key.checks[0].school, key.checks[0].field, key.checks[0].verdict, key.checks[0].truth, key.checks[0].scraperHad.value], ['School 01', 'tuition', 'wrong', '$1', '$40001']);
    ok('the answer key lists each check with the school name, the right value and what the scraper had');
  }

  // ============================================ the real server ==============
  {
    const dir = tmp();
    const put = (rel, obj) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
    const w = world({ 1: 4, 2: 2 });
    put('template.json', { importedAt: 'x', workbook: 'x', tab: 'Master Template', rows: [{ row: 1, label: 'School Name', key: 'schoolName', kind: 'name', section: 'S' },
      ...KEY_FIELDS.map((f, i) => ({ row: i + 2, label: f + ':', key: f, kind: 'field', section: 'S', hasRule: true }))] });
    put('schools.json', { importedAt: 'x', workbook: 'x', schools: w.schools.map((s, i) => ({ ...s, row: i + 2, region: 'Bay Area', website: 'https://x.example/', portal: null, portalLabel: null, appOpen: 'Unknown', division: null, tabs: [s.name] })) });
    for (const s of w.schools) put(`results/${s.id}.json`, { id: s.id, name: s.name, scrapedAt: '2026-11-01T00:00:00Z', scraperVersion: '1.1.0', start: 'https://x.example/', status: 'ok', ms: 1, counts: { found: 1, none: 1, manual: 0 }, identity: { ok: true }, pages: [], portals: [], skipped: [], fields: w.results[s.id].fields });
    const PORT = 4497;
    const server = await new Promise((resolve, reject) => {
      const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir };
      for (const k of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_URL', 'ALLOWED_EMAIL_DOMAIN']) delete env[k];
      const c = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--no-browser'], { cwd: ROOT, env });
      let out = '';
      c.stdout.on('data', (d) => { out += d; if (/dashboard:/.test(out)) resolve(c); });
      c.stderr.on('data', (d) => { out += d; });
      c.on('exit', (code) => reject(new Error('server exited early: ' + out + ' code ' + code)));
      setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    });
    const J = { 'content-type': 'application/json', 'x-dashboard': '1' };
    const post = (p, b) => request(PORT, 'POST', p, { headers: J, body: JSON.stringify(b || {}) });
    try {
      let r = await request(PORT, 'POST', '/api/verify', { headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.strictEqual(r.status, 403, 'a page on another site cannot post checks');
      r = await post('/api/verify', { school_id: 's1', field: 'tuition', verdict: 'correct' });
      assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.text).snapshot.value, '$40001');
      r = await post('/api/verify', { school_id: 's1', field: 'enrollment', verdict: 'correct' });
      assert.strictEqual(r.status, 400); assert.ok(/found nothing/.test(JSON.parse(r.text).error));
      r = await post('/api/verify', { school_id: 's2', field: 'tuition', verdict: 'wrong', truth: '$39,000', truthUrl: 'https://x.example/tuition' });
      assert.strictEqual(r.status, 200);
      r = await request(PORT, 'GET', '/api/verify?school=s2');
      assert.strictEqual(JSON.parse(r.text).tuition.truth, '$39,000');
      r = await post('/api/accuracy/sample', { schools: 6 });   // all six schools, so both checked schools are in it
      assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.text).schools.length, 6);
      r = await request(PORT, 'GET', '/api/accuracy');
      const acc = JSON.parse(r.text);
      assert.strictEqual(acc.report.overall.checks, 2); assert.strictEqual(acc.report.overall.wrong, 1); assert.ok(acc.sample && acc.sample.total === 6 * KEY_FIELDS.length && acc.sample.done === 2);
      r = await request(PORT, 'GET', '/api/accuracy/export');
      assert.strictEqual(r.status, 200); assert.ok(/attachment; filename="answer-key-/.test(r.headers['content-disposition'])); assert.strictEqual(JSON.parse(r.text).checks.length, 2);
      r = await post('/api/verify', { school_id: 's1', field: 'tuition', clear: true });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse((await request(PORT, 'GET', '/api/accuracy')).text).report.overall.checks, 1);
      r = await post('/api/accuracy/sample-clear');
      assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse((await request(PORT, 'GET', '/api/accuracy')).text).sample, null);
      assert.ok(fs.existsSync(path.join(dir, 'verification.json')));
      ok('server: checks are recorded and validated, the sample and the figures follow them, the answer key downloads, and other sites are refused');

      // the trust score reaches the school page, the review queue and the accuracy figures
      r = await request(PORT, 'GET', '/api/school?id=s3');
      const row = JSON.parse(r.text).rows.find((x) => x.key === 'tuition');
      assert.ok(row && row.trust && row.trust.score >= 1 && row.trust.score <= 99 && ['ready', 'check', 'doubtful'].includes(row.trust.triage) && row.trust.reasons.length >= 1, 'a found key fact carries its trust score and reasons');
      assert.ok(!JSON.parse(r.text).rows.find((x) => x.key === 'enrollment' && x.trust), 'a value that was not found has no score');
      r = await request(PORT, 'GET', '/api/review-queue');
      let q = JSON.parse(r.text);
      assert.strictEqual(r.status, 200); assert.strictEqual(q.ready, true); assert.strictEqual(q.facts, 6, 'one found key fact per school');
      assert.strictEqual(q.readyToUse + q.needLook + q.checked, q.facts, 'every fact is ready, waiting for a person, or already checked');
      assert.strictEqual(q.checked, 1, 'the one value checked as wrong is no longer in the queue');
      assert.ok(q.items.every((i, n, a) => n === 0 || a[n - 1].score <= i.score), 'most doubtful first');
      assert.ok(q.items.every((i) => i.triage !== 'ready' && i.why.length >= 1 && i.school), 'only values that need a person, each with its reasons');
      const t1 = JSON.parse((await request(PORT, 'GET', '/api/review-queue?tier=2')).text);
      assert.ok(t1.items.every((i) => i.tier === 2), 'the tier filter narrows the list');
      assert.strictEqual(JSON.parse((await request(PORT, 'GET', '/api/review-queue?field=enrollment')).text).items.length, 0);
      // a check made now records how much the score trusted the value at that moment
      r = await post('/api/verify', { school_id: 's4', field: 'tuition', verdict: 'correct' });
      assert.strictEqual(r.status, 200); assert.ok(JSON.parse(r.text).snapshot.trust && JSON.parse(r.text).snapshot.trust.score >= 1, 'the check keeps the score it was given');
      const acc2 = JSON.parse((await request(PORT, 'GET', '/api/accuracy')).text);
      assert.ok(Array.isArray(acc2.report.trust) && acc2.report.trust.length >= 1 && acc2.report.trust.every((x) => ['high', 'medium', 'low'].includes(x.level)), 'the Accuracy figures say whether higher scores really were more often right');
      assert.strictEqual(JSON.parse((await request(PORT, 'GET', '/api/review-queue')).text).checked, 2);
      ok('server: a found key fact carries a trust score, the review queue lists only values that need a person, and checks feed the score back');
    } finally { server.kill(); }
  }

  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e && e.stack || e); process.exit(1); });
