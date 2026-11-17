'use strict';
// Checks the Monte Carlo simulation: repeatable, sensible, and it leaves the rating weights exactly as it found them.
//   node tests/monte-carlo.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trust = require('../src/lib/trust');
const mc = require('../tools/monte-carlo');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };
const NOW = new Date('2026-11-17T00:00:00Z');

// a made-up school: plain statements on the school's own fact page and tuition page
const pages = [{ url: 'https://s.example/about/at-a-glance', topics: ['facts'] }, { url: 'https://s.example/tuition', topics: ['tuition'] }, { url: 'https://s.example/', topics: ['home'] }];
const value = (key, url, extra) => ({ school: 'S', key, pages, field: { status: 'found', value: '$40,000', num: 40000, confidence: 'medium', snippet: 'Tuition $40,000', sources: [{ url }], note: 'School year on the page: 2026-2027', ...(extra || {}) } });
const values = [
  value('tuition', 'https://s.example/tuition'), value('tuition', 'https://s.example/about/at-a-glance'), value('tuition', 'https://s.example/'),
  value('enrollment', 'https://s.example/about/at-a-glance', { value: '450', num: 450, snippet: 'Enrollment 450', note: undefined }),
  value('counselors', 'https://s.example/', { value: '3', num: 3, snippet: 'x', note: 'Counted from job titles', confidence: 'low' }),
  value('grades', 'https://s.example/about/at-a-glance', { value: '9–12', num: null, snippet: 'grades 9-12', note: undefined }),
];
const rows = mc.scoreAll(values, NOW);

// ---------------------------------------------------------------------------------------- basics ---
{
  const a = mc.rng(5), b = mc.rng(5), c = mc.rng(6);
  const xs = [a(), a(), a()], ys = [b(), b(), b()];
  assert.deepStrictEqual(xs, ys, 'the same seed gives the same numbers');
  assert.notDeepStrictEqual(xs, [c(), c(), c()]);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const r = mc.rng(1); let sum = 0, sq = 0; const n = 20000;
  for (let i = 0; i < n; i++) { const z = mc.normal(r); sum += z; sq += z * z; }
  assert.ok(Math.abs(sum / n) < 0.03 && Math.abs(sq / n - 1) < 0.05, 'normal numbers have mean 0 and spread 1');
  const w = mc.wilson(95, 100), w2 = mc.wilson(950, 1000);
  assert.ok(w.low < 0.95 && w.high > 0.95 && w2.half < w.half, 'more checks, narrower margin');
  assert.deepStrictEqual(mc.summarize([1, 2, 3, 4, 5]), { mean: 3, p5: 1.2, median: 3, p95: 4.8 });
  ok('seeded random numbers repeat, normal numbers behave, margins shrink with more checks');
}

// -------------------------------------------------------------------------------- 1. how many wrong ---
{
  const run = (assume, seed) => mc.simulateAccuracy(rows, { runs: 800, seed, assume });
  const x = run(mc.SCENARIOS.middle, 11), y = run(mc.SCENARIOS.middle, 11);
  assert.deepStrictEqual(x, y, 'same seed, same answer');
  assert.ok(x.ready >= 1 && x.values === rows.length);
  const honest = run(mc.SCENARIOS.honest, 12), optimistic = run(mc.SCENARIOS.optimistic, 13);
  assert.ok(honest.wrongAll.mean < x.wrongAll.mean && x.wrongAll.mean < optimistic.wrongAll.mean, 'a more optimistic rating means more wrong answers');
  // honest ratings: the expected number wrong is the sum of (1 - rating)
  const expected = rows.reduce((t, r) => t + (1 - Math.min(0.995, Math.max(0.02, r.score / 100))), 0);
  assert.ok(Math.abs(honest.wrongAll.mean - expected) < 0.6, `honest ratings give about ${expected.toFixed(2)} wrong, got ${honest.wrongAll.mean.toFixed(2)}`);
  // a higher line means more answers get checked, and fewer wrong answers are left
  const left = x.thresholds.map((t) => t.remaining.mean);
  for (let i = 1; i < left.length; i++) assert.ok(left[i] <= left[i - 1] + 0.3, 'a higher line (more checking) never leaves meaningfully more wrong answers');
  const toReview = x.thresholds.map((t) => t.toReview);
  assert.deepStrictEqual(toReview, toReview.slice().sort((p, q) => p - q), 'a higher line means more answers to check');
  assert.ok(x.thresholds[x.thresholds.length - 1].remaining.mean <= x.wrongAll.mean * 0.5, 'checking nearly everything leaves far fewer wrong answers');
  assert.ok(x.perField.every((f) => f.ready > 0), 'only questions that have Safe to use answers are listed');
  ok('the wrong-answer simulation repeats, grows with optimism, matches the honest-rating arithmetic, and shrinks as more is checked');
}

// -------------------------------------------------------------------------- 2. how many checks ---
{
  const opts = { runs: 600, seed: 21, accuracies: [0.9, 0.98], sizes: [20, 50, 100] };
  const a = mc.simulateSampleSize(150, opts), b = mc.simulateSampleSize(150, opts);
  assert.deepStrictEqual(a, b);
  for (const p of a.precision) {
    const hw = p.bySize.slice(0, 3).map((x) => x.typicalHalfWidth);
    assert.ok(hw[0] > hw[1] && hw[1] > hw[2], 'more checks, smaller typical margin');
    assert.ok(p.bySize[2].within5 >= p.bySize[0].within5, 'more checks, more likely to be within 5 points');
  }
  assert.ok(a.precision[1].bySize[1].typicalHalfWidth < a.precision[0].bySize[1].typicalHalfWidth, 'a more accurate set needs fewer checks for the same margin');
  const sep = a.separation.bySize.map((x) => x.chance);
  assert.ok(sep[sep.length - 1] >= sep[0] && sep[2] > 0.9, 'with enough checks in each group the page shows a clear difference');
  assert.strictEqual(a.precision[0].bySize[a.precision[0].bySize.length - 1].checks, 150, 'checking every answer is the last row');
  ok('the sample-size simulation repeats and behaves: more checks mean smaller margins and a clearer difference between groups');
}

// ------------------------------------------------------------------------------- 3. the weights ---
{
  const W0 = JSON.stringify(trust.W), B0 = JSON.stringify(Object.values(trust.FIELDS).map((f) => f.baseline));
  const w = mc.simulateWeights(values, NOW, { runs: 60, seed: 31, weightSd: 0.35, baselineSd: 0.4 });
  assert.strictEqual(JSON.stringify(trust.W), W0, 'the weights are put back exactly as they were');
  assert.strictEqual(JSON.stringify(Object.values(trust.FIELDS).map((f) => f.baseline)), B0, 'and so are the starting numbers');
  assert.strictEqual(w.readyNow, rows.filter((r) => r.ready).length, 'the "today" count is the real count');
  assert.strictEqual(w.stable + w.mostlyStable + w.shaky, w.readyNow, 'every Safe to use answer is in exactly one steadiness group');
  assert.ok(w.oneAtATime.length > 0 && w.oneAtATime.every((x, i, arr) => i === 0 || arr[i - 1].swing >= x.swing), 'most sensitive judgement first');
  const again = mc.simulateWeights(values, NOW, { runs: 60, seed: 31 });
  assert.deepStrictEqual(again.readyWhenVaried, w.readyWhenVaried, 'same seed, same result');
  assert.deepStrictEqual(mc.scoreAll(values, NOW), rows, 'ratings after the simulation are identical to before it');
  ok('the weight stress test varies every weight, then restores them exactly, and groups answers by how steady they are');
}

// ------------------------------------------------------------------------------------ the report ---
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
  const mkSchool = (id, identityOk) => ({ id, name: 'School ' + id, status: 'ok', identity: { ok: identityOk }, pages,
    fields: { tuition: { status: 'found', value: '$40,000', num: 40000, confidence: 'medium', snippet: 'Tuition $40,000', sources: [{ url: 'https://s.example/tuition' }], note: 'School year on the page: 2026-2027' }, enrollment: { status: 'none' }, mission: { status: 'found', value: 'text' } } });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `s${i}.json`), JSON.stringify(mkSchool('s' + i, true)));
  fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify(mkSchool('wrong', false)));
  fs.writeFileSync(path.join(dir, 'unread.json'), JSON.stringify({ id: 'u', name: 'U', status: 'error', fields: {} }));
  const loaded = mc.loadValues(dir);
  assert.deepStrictEqual([loaded.schools, loaded.values.length, loaded.skippedWrongSite], [12, 12, 1], 'a wrong-website school and an unread school are left out; only key facts are counted');
  const res = mc.runAll({ resultsDir: dir, runs: 300, weightRuns: 20, now: NOW });
  const text = mc.buildReport(res);
  assert.ok(/^# How reliable are the answers\?/.test(text) && text.includes('## The short version') && text.includes('## 4. What if my judgement is off?'));
  assert.ok(!/\b(null|undefined|NaN)\b/.test(text), 'the report never prints null, undefined or NaN');
  assert.ok(text.includes('1 school was left out'), 'the report says a school was left out');
  assert.ok(text.includes('Nobody has checked these answers against the real websites yet'), 'the report says what it cannot do');
  assert.deepStrictEqual(mc.buildReport(mc.runAll({ resultsDir: dir, runs: 300, weightRuns: 20, now: NOW })), text, 'the same seed gives the same report');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the report is built from saved results, leaves out wrong-website and unread schools, repeats, and never prints null');
}

console.log(`\n${passed} checks passed.`);
