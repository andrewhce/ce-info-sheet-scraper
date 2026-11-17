'use strict';
// Monte Carlo simulation of how reliable the scraper's answers are, written for the people who use the dashboard.
//
//   node tools/monte-carlo.js                       runs on the saved results, writes docs/MONTE-CARLO-REPORT.md
//   node tools/monte-carlo.js --runs 20000 --seed 7
//   node tools/monte-carlo.js --out some/file.md --json some/file.json
//
// WHY A SIMULATION. Nobody has checked these answers against the real websites yet, so the true accuracy is unknown. A Monte Carlo
// simulation does not make it known. It answers "given what we do know and a clearly stated range of what we do not, what is the
// range of outcomes we should plan for?" by playing the situation out thousands of times with random numbers.
//
// THREE QUESTIONS (each is a section of the report):
//   1. If nobody checked the "Safe to use" answers, how many would be wrong, and how many wrong answers would remain for different
//      amounts of checking?  The unknown is how honest the 1-100 ratings are, so each run draws a different "honesty" for them.
//   2. How many answers must a person check by hand before the Accuracy page can say anything firm?  Plays out random samples.
//   3. If my judgement weights in the rating are somewhat off, how many "Safe to use" answers change?  Perturbs every weight.
//
// The numbers use a seeded random generator, so the same seed always gives the same report.
const fs = require('fs');
const path = require('path');
const trust = require('../src/lib/trust');

// ----------------------------------------------------------------------------- random numbers ---
function rng(seed) {                         // mulberry32: small, fast, repeatable
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const normal = (r) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
function summarize(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = s.reduce((t, x) => t + x, 0) / (s.length || 1);
  return { mean, p5: quantile(s, 0.05), median: quantile(s, 0.5), p95: quantile(s, 0.95) };
}
/** Wilson 95% interval half-width for k successes out of n. */
function wilson(k, n) {
  if (!n) return { low: 0, high: 1, half: 0.5 };
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { low: c - h, high: c + h, half: h };
}

// ------------------------------------------------------------------------------------- the data ---
/** Every found key fact in the saved results, with the inputs the rating needs. Schools whose website looks like another school are left out. */
function loadValues(resultsDir) {
  const out = { values: [], schools: 0, skippedWrongSite: 0 };
  for (const f of fs.readdirSync(resultsDir).filter((x) => x.endsWith('.json'))) {
    let r; try { r = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8')); } catch { continue; }
    if (!r || r.status !== 'ok') continue;
    if (r.identity && r.identity.ok === false) { out.skippedWrongSite++; continue; }
    out.schools++;
    for (const key of Object.keys(trust.FIELDS)) {
      const field = r.fields && r.fields[key];
      if (field && field.status === 'found') out.values.push({ school: r.name || r.id, key, field, pages: r.pages || [] });
    }
  }
  return out;
}
function scoreAll(values, now) {
  return values.map((v) => {
    const t = trust.scoreValue({ key: v.key, field: v.field, pages: v.pages, now });
    return { key: v.key, score: t.score, ready: t.triage === 'ready', review: t.needsReview };
  });
}

// ------------------------------------------------------------ 1. how many would be wrong? ---
// The 1-100 rating is meant to be a chance of being right. It has never been checked, so each run draws how honest it really is:
//   true chance (logit) = shift + slope * rating (logit) + a per-question wobble
//   shift ~ Normal(-0.4, 0.5)     slightly over-confident on average, and unsure by how much
//   slope ~ Uniform(0.6, 1.1)     from "ratings spread too wide" to "about right"
//   wobble ~ Normal(0, 0.6) per question   a question with a bad rule is bad for EVERY school (like the phone-number mistake)
// A person who checks an answer is assumed to catch 95% of the mistakes among the ones they check.
// Because the honesty of the ratings is the one thing nobody knows yet, three scenarios are run and the middle one is the headline:
//   honest      the ratings mean what they say
//   middle      somewhat too optimistic (the default)
//   optimistic  clearly too optimistic, with real rule problems in some questions
const SCENARIOS = {
  honest: { shift: [0, 0.15], slope: [0.95, 1.05], wobble: 0.2, humanCatch: 0.95 },
  middle: { shift: [-0.25, 0.4], slope: [0.75, 1.1], wobble: 0.5, humanCatch: 0.95 },
  optimistic: { shift: [-0.7, 0.4], slope: [0.5, 0.9], wobble: 0.7, humanCatch: 0.95 },
};
const ASSUME = SCENARIOS.middle;

function simulateAccuracy(rows, { runs = 5000, seed = 1, thresholds = [60, 70, 80, 88, 92, 95, 98], assume = ASSUME } = {}) {
  const r = rng(seed);
  const fields = [...new Set(rows.map((x) => x.key))];
  const base = rows.map((x) => logit(clamp(x.score / 100, 0.01, 0.99)));
  const ready = rows.map((x) => x.ready);
  const wrongReady = [], wrongAll = [], overallReadyAcc = [];
  const perField = Object.fromEntries(fields.map((f) => [f, []]));
  const byT = Object.fromEntries(thresholds.map((t) => [t, { remaining: [] }]));
  for (let run = 0; run < runs; run++) {
    const shift = assume.shift[0] + assume.shift[1] * normal(r);
    const slope = assume.slope[0] + (assume.slope[1] - assume.slope[0]) * r();
    const wob = Object.fromEntries(fields.map((f) => [f, assume.wobble * normal(r)]));
    const wrong = new Array(rows.length);
    let wr = 0, wa = 0, nReady = 0;
    const fieldWrong = Object.fromEntries(fields.map((f) => [f, 0]));
    for (let i = 0; i < rows.length; i++) {
      const p = clamp(sigmoid(shift + slope * base[i] + wob[rows[i].key]), 0.02, 0.995);
      wrong[i] = r() >= p ? 1 : 0;
      wa += wrong[i];
      if (ready[i]) { nReady++; wr += wrong[i]; fieldWrong[rows[i].key] += wrong[i]; }
    }
    wrongReady.push(wr); wrongAll.push(wa); overallReadyAcc.push(nReady ? 1 - wr / nReady : 1);
    for (const f of fields) perField[f].push(fieldWrong[f]);
    for (const t of thresholds) {
      let remaining = 0;
      for (let i = 0; i < rows.length; i++) {
        const reviewed = rows[i].score < t || rows[i].review;
        remaining += reviewed ? wrong[i] * (1 - assume.humanCatch) : wrong[i];
      }
      byT[t].remaining.push(remaining);
    }
  }
  const nReadyRows = ready.filter(Boolean).length;
  return {
    values: rows.length, ready: nReadyRows,
    wrongReady: summarize(wrongReady), wrongAll: summarize(wrongAll), readyAccuracy: summarize(overallReadyAcc),
    perField: fields.map((f) => ({ field: f, ready: rows.filter((x, i) => ready[i] && x.key === f).length, wrong: summarize(perField[f]) })).filter((x) => x.ready).sort((a, b) => b.wrong.mean - a.wrong.mean),
    thresholds: thresholds.map((t) => ({ at: t, toReview: rows.filter((x) => x.score < t || x.review).length, remaining: summarize(byT[t].remaining) })),
  };
}

// ------------------------------------------------------------- 2. how many checks are enough? ---
function simulateSampleSize(population, { runs = 5000, seed = 2, accuracies = [0.9, 0.95, 0.98], sizes = [20, 30, 50, 75, 100, 150, 200], separation = [0.95, 0.6] } = {}) {
  const r = rng(seed);
  const sizeList = [...new Set(sizes.filter((n) => n < population).concat([population]))].sort((a, b) => a - b);
  const precision = accuracies.map((acc) => ({
    accuracy: acc,
    bySize: sizeList.map((n) => {
      const halves = []; let within5 = 0, within3 = 0;
      for (let run = 0; run < runs; run++) {
        // the population has a random number of wrong answers around (1 - acc) * N, then n are checked without repeats
        let wrongTotal = 0; for (let i = 0; i < population; i++) if (r() >= acc) wrongTotal++;
        let wrongLeft = wrongTotal, left = population, sampleWrong = 0;
        for (let i = 0; i < n; i++) { if (r() < wrongLeft / left) { sampleWrong++; wrongLeft--; } left--; }
        const w = wilson(n - sampleWrong, n);
        halves.push(w.half); if (w.half <= 0.05) within5++; if (w.half <= 0.03) within3++;
      }
      return { checks: n, within5: within5 / runs, within3: within3 / runs, typicalHalfWidth: summarize(halves).median };
    }),
  }));
  const [aSafe, aCheck] = separation;
  const sep = sizeList.map((n) => {
    let clear = 0;
    for (let run = 0; run < runs; run++) {
      let ks = 0, kc = 0; for (let i = 0; i < n; i++) { if (r() < aSafe) ks++; if (r() < aCheck) kc++; }
      const a = wilson(ks, n), b = wilson(kc, n);
      if (a.low > b.high) clear++;
    }
    return { checks: n, chance: clear / runs };
  });
  return { population, precision, separation: { safe: aSafe, check: aCheck, bySize: sep } };
}

// ---------------------------------------------------- 3. what if my judgement weights are off? ---
function simulateWeights(values, now, { runs = 1000, seed = 3, weightSd = 0.35, baselineSd = 0.4 } = {}) {
  const r = rng(seed);
  const W0 = { ...trust.W }, B0 = Object.fromEntries(Object.entries(trust.FIELDS).map(([k, v]) => [k, v.baseline]));
  const keys = Object.keys(W0);
  const nowRatings = values.map((v) => trust.scoreValue({ key: v.key, field: v.field, pages: v.pages, now }));
  const readyNow = nowRatings.map((t) => t.triage === 'ready');
  const stay = new Array(values.length).fill(0);
  const totals = [];
  const restore = () => { Object.assign(trust.W, W0); for (const k of Object.keys(B0)) trust.FIELDS[k].baseline = B0[k]; };
  const countReady = () => { let n = 0; const flags = values.map((v) => { const t = trust.scoreValue({ key: v.key, field: v.field, pages: v.pages, now }).triage === 'ready'; if (t) n++; return t; }); return { n, flags }; };
  try {
    for (let run = 0; run < runs; run++) {
      for (const k of keys) trust.W[k] = W0[k] * Math.exp(weightSd * normal(r));             // every weight changes by roughly +/- 35%
      for (const k of Object.keys(B0)) trust.FIELDS[k].baseline = clamp(sigmoid(logit(B0[k]) + baselineSd * normal(r)), 0.05, 0.97);   // and every starting number moves
      const { n, flags } = countReady();
      totals.push(n);
      for (let i = 0; i < values.length; i++) if (readyNow[i] && flags[i]) stay[i]++;
    }
    // one weight at a time: how much does the number of "Safe to use" answers move when this weight is halved or raised by half?
    restore();
    const oneAtATime = keys.map((k) => {
      trust.W[k] = W0[k] * 0.5; const lo = countReady().n; trust.W[k] = W0[k] * 1.5; const hi = countReady().n; trust.W[k] = W0[k];
      return { weight: k, lower: lo, higher: hi, swing: Math.abs(hi - lo) };
    }).sort((a, b) => b.swing - a.swing);
    restore();
    const now0 = readyNow.filter(Boolean).length;
    const shares = readyNow.map((was, i) => (was ? stay[i] / runs : null)).filter((x) => x != null);
    const perField = {};
    values.forEach((v, i) => { if (!readyNow[i]) return; const p = perField[v.key] || (perField[v.key] = { n: 0, stable: 0 }); p.n++; if (stay[i] / runs >= 0.95) p.stable++; });
    const shakyScores = values.map((v, i) => (readyNow[i] && stay[i] / runs < 0.8 ? nowRatings[i].score : null)).filter((x) => x != null);
    return {
      shakyScores: shakyScores.length ? [Math.min(...shakyScores), Math.max(...shakyScores)] : null,
      readyNow: now0, readyWhenVaried: summarize(totals),
      stable: shares.filter((x) => x >= 0.95).length, mostlyStable: shares.filter((x) => x >= 0.8 && x < 0.95).length, shaky: shares.filter((x) => x < 0.8).length,
      perField: Object.entries(perField).map(([field, p]) => ({ field, ready: p.n, stable: p.stable })).sort((a, b) => (a.stable / a.ready) - (b.stable / b.ready)),
      oneAtATime: oneAtATime.slice(0, 6), weightSd, baselineSd,
    };
  } finally { restore(); }
}

// ------------------------------------------------------------------------------------ the report ---
const FIELD_NAME = { tuition: 'Tuition', enrollment: 'Total enrollment', ratio: 'Student-teacher ratio', classSize: 'Class size', facultyDegrees: 'Faculty with advanced degrees', collegeEnrollment: 'College enrollment %', counselors: 'Number of counselors', location: 'Address', grades: 'Grades', applicationOpenDate: 'Application open date', decisionDate: 'Decision release date' };
const WEIGHT_NAME = {
  official: 'the school’s own fact sheet counting as very reliable', dedicated: 'the school’s own page on the topic counting as reliable', related: 'a page that only touches the topic',
  general: 'a general page', newsy: 'a news or blog post', pages2: 'the same answer on 2 pages', pages3: 'the same answer on 3 pages', pages5: 'the same answer on 5+ pages',
  conflictEach: 'another page giving a different answer', conflictMax: 'the most that conflicts can lower an answer', ownPagesDisagree: 'the school’s own pages disagreeing',
  quoteShows: 'the quote showing the number', quoteMissing: 'the quote not showing the number', counted: 'a number counted from job titles', divisionUnclear: 'not knowing which division a number covers',
  partialCount: 'a day-only or boarding-only count', ruleConfidence: 'the rule’s own mark', yearCurrent: 'a current school year on the page', yearOld1: 'a one-year-old figure', yearOld2: 'a much older figure',
  noYear: 'no school year shown', noYearDate: 'no year on a date', monthOnly: 'only a month given', dateYearOk: 'a date with a fitting year', dateYearOld: 'a date from an earlier cycle', dateOdd: 'a date in an unusual month',
  earlyRound: 'an early-round date', hard: 'an impossible value', unusual: 'an unusual value', address: 'a full address', noAddress: 'an incomplete address', otherAddresses: 'another campus address on the site',
  campusLabelled: 'the school labelling the campus', campusGuess: 'several campuses with no label',
};
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
const num = (x, d = 0) => Number(x).toFixed(d);
const range = (s, d = 0) => `${num(s.p5, d)} to ${num(s.p95, d)}`;

/** The smallest number of checks (from the list) at which `pick(row)` reaches `level`, or null. */
const firstAt = (rows, pick, level) => { const r = rows.find((x) => pick(x) >= level); return r ? r.checks : null; };

function buildReport(res) {
  const a = res.accuracy, sc = res.scenarios, s = res.sampling, w = res.weights, m = res.meta;
  const at88 = a.thresholds.find((t) => t.at === 88);
  const lines = [];
  const wrongShare = (x) => pct(1 - x.readyAccuracy.median, 1);
  lines.push('# How reliable are the answers? A simulation', '');
  lines.push(`Made on ${m.date} from ${m.schools} checked schools and ${m.values} answers to the main questions (${m.runs.toLocaleString()} simulated runs for each test, seed ${m.seed}). `
    + (m.skippedWrongSite ? `${m.skippedWrongSite} school${m.skippedWrongSite === 1 ? ' was' : 's were'} left out because the website link looks like a different school.` : ''), '');

  // ---- the short version
  const need80 = s.precision.map((p) => ({ acc: p.accuracy, n: firstAt(p.bySize, (x) => x.within5, 0.8) }));
  const sepN = firstAt(s.separation.bySize, (x) => x.chance, 0.9);
  const shakyShare = w.readyNow ? w.shaky / w.readyNow : 0;
  lines.push('## The short version', '');
  lines.push(`- **${a.ready} of the ${a.values} answers are rated “Safe to use”.** If nobody checked them, we would expect about **${num(a.wrongReady.median)} of them to be wrong** (${wrongShare(a)}), plausibly anywhere from ${range(a.wrongReady)}. `
    + `That depends on how honest the ratings are, which nobody knows yet: if they mean exactly what they say it would be about ${num(sc.honest.wrongReady.median)}, and if they are clearly too optimistic about ${num(sc.optimistic.wrongReady.median)}.`);
  lines.push(`- **Checking the ${at88.toReview} answers that are not “Safe to use”** (the “To check” page) would leave about ${num(at88.remaining.median)} wrong answers in all ${a.values} (${range(at88.remaining)}), assuming a careful person catches 95% of the mistakes they look at.`);
  lines.push(`- **To learn the real accuracy** of the Safe to use answers: ${need80.map((x) => `about ${x.n || 'all'} checks if it is really ${pct(x.acc)} right`).join(', ')} (that many checks gives an 80% chance of being within 5 points). `
    + `To see whether the ratings mean anything, about ${sepN || 'many'} checks in each of the two groups is enough.`);
  lines.push(`- **The ratings depend on my judgement, and about ${pct(shakyShare)} of the Safe to use answers sit close enough to the line that a modest change in judgement would make them “Quick look”** (${w.shaky} of ${w.readyNow}). The rest are steady (section 4).`);
  lines.push('', '**What this cannot do:** it cannot tell you the true accuracy. Nobody has checked these answers against the real websites yet. The simulation turns a clearly stated range of guesses into a range of outcomes to plan for. Only your ✓ Right and ✗ Wrong checks can replace the guesses with facts.', '');

  // ---- 1
  lines.push('## 1. If nobody checked the “Safe to use” answers, how many would be wrong?', '');
  lines.push('The 1 to 100 rating is meant to be the chance an answer is right, but it has never been checked. So in every simulated run the ratings are allowed to be a bit too optimistic or about right, '
    + 'and each question can have its own hidden problem (for example, a rule that misreads phone numbers is wrong at every school). Then every answer is randomly right or wrong according to that run’s chances.', '');
  lines.push(`Across ${m.runs.toLocaleString()} runs, among the ${a.ready} “Safe to use” answers, under three guesses about how honest the ratings are:`, '');
  lines.push('| If the ratings are… | Wrong answers (most likely) | Plausible range (90% of runs) | Share wrong |', '| --- | --- | --- | --- |');
  for (const [name, label] of [['honest', 'exactly honest'], ['middle', 'somewhat too optimistic (used for the short version)'], ['optimistic', 'clearly too optimistic']]) {
    const x = sc[name];
    lines.push(`| ${label} | ${num(x.wrongReady.median)} | ${range(x.wrongReady)} | ${pct(1 - x.readyAccuracy.median, 1)} |`);
  }
  lines.push('', 'By question (among the answers rated Safe to use, in the middle guess):', '');
  lines.push('| Question | Safe to use answers | Expected wrong | Plausible range |', '| --- | --- | --- | --- |');
  for (const f of a.perField) lines.push(`| ${FIELD_NAME[f.field] || f.field} | ${f.ready} | ${num(f.wrong.mean, 1)} | ${range(f.wrong)} |`);
  lines.push('');

  // ---- 2
  lines.push('## 2. How much checking is worth it?', '');
  lines.push('You choose where to draw the line: answers rated below the line get checked by a person, answers above it are used as they are (middle guess).', '');
  lines.push('| Check answers rated below | Answers to check | Wrong answers left (most likely) | Plausible range |', '| --- | --- | --- | --- |');
  for (const t of a.thresholds) lines.push(`| ${t.at}${t.at === 88 ? ' (today)' : ''} | ${t.toReview} | ${num(t.remaining.median)} | ${range(t.remaining)} |`);
  lines.push('', `Wrong answers left include the ones in answers nobody looks at, plus the few (5%) that a person misses when checking. Even checking everything would leave about ${num(a.wrongAll.mean * 0.05)}, because people miss some. The “To check” page lists exactly the answers below the line, least certain first.`, '');

  // ---- 3
  lines.push('## 3. How many answers do you need to check by hand to learn the real accuracy?', '');
  lines.push(`This plays out random spot-checks of the ${s.population} “Safe to use” answers. The “typical margin” is how far the percentage on the Accuracy page is likely to be from the truth (a 95% margin).`, '');
  lines.push(`| Answers checked | Typical margin if the real accuracy is ${s.precision.map((p) => pct(p.accuracy)).join(' / ')} |`, '| --- | --- |');
  const sizes = s.precision[0].bySize.map((x) => x.checks);
  for (const n of sizes) lines.push(`| ${n} | ${s.precision.map((p) => '±' + num(p.bySize.find((x) => x.checks === n).typicalHalfWidth * 100, 1)).join(' / ')} points |`);
  lines.push('', 'Chance of being within 5 points:', '');
  lines.push(`| Answers checked | ${s.precision.map((p) => `if really ${pct(p.accuracy)}`).join(' | ')} |`, `| --- | ${s.precision.map(() => '---').join(' | ')} |`);
  for (const n of sizes) lines.push(`| ${n} | ${s.precision.map((p) => pct(p.bySize.find((x) => x.checks === n).within5)).join(' | ')} |`);
  lines.push('', `Can the Accuracy page tell “Safe to use” from “Check this”? If Safe to use answers are really right ${pct(s.separation.safe)} of the time and Check this ones ${pct(s.separation.check)}, this is the chance the two margins do not overlap after checking this many of each:`, '');
  lines.push('| Checked in each group | Chance the page shows a clear difference |', '| --- | --- |');
  for (const x of s.separation.bySize) lines.push(`| ${x.checks} | ${pct(x.chance)} |`);
  lines.push('', `Rule of thumb: about ${sepN || 'many'} checks in each group is enough to see whether the ratings mean anything; a precise accuracy figure needs more, and the more accurate the answers really are, the fewer checks that takes.`, '');

  // ---- 4
  lines.push('## 4. What if my judgement is off?', '');
  lines.push(`The rating uses weights I chose by judgement (how much a fact sheet counts, how much a missing school year costs, and so on). To see how much that matters, every weight was changed at random by roughly ±${Math.round(w.weightSd * 100)}% and every starting number moved, ${m.weightRuns.toLocaleString()} times, and every answer was rated again.`, '');
  lines.push(`- Today ${w.readyNow} answers are “Safe to use”. Across the variations the count is typically **${num(w.readyWhenVaried.median)}** (${range(w.readyWhenVaried)}).`);
  lines.push(`- ${w.stable} of today’s Safe to use answers stay Safe to use in at least 95% of the variations, ${w.mostlyStable} in 80% to 95%, and ${w.shaky} in fewer than 80%.${w.shakyScores ? ` The shaky ones all have ratings between ${w.shakyScores[0]} and ${w.shakyScores[1]}: they sit right at the line of 88, so a small change in judgement tips them over. Answers rated well above the line stay put.` : ''}`, '');
  lines.push('The most sensitive judgements (the number of Safe to use answers when this one weight is halved, and when it is raised by half):', '');
  lines.push('| Judgement | Safe to use if halved | if raised by half |', '| --- | --- | --- |');
  for (const x of w.oneAtATime) lines.push(`| ${WEIGHT_NAME[x.weight] || x.weight} | ${x.lower} | ${x.higher} |`);
  lines.push('', 'Questions whose Safe to use answers are least steady:', '');
  lines.push('| Question | Safe to use | Steady in 95% of variations |', '| --- | --- | --- |');
  for (const f of w.perField.slice(0, 6)) lines.push(`| ${FIELD_NAME[f.field] || f.field} | ${f.ready} | ${f.stable} |`);
  lines.push('');

  // ---- what to do
  lines.push('## What to do with this', '');
  lines.push('1. Pick the “check answers rated below” line from section 2 that matches how much checking time you have. 88 is the line today.');
  lines.push(`2. Check about ${Math.max(30, sepN || 30)} “Safe to use” answers spread across different questions (open any school and press ✓ Right or ✗ Wrong), and about as many “Check this” ones. If several Safe to use answers turn out wrong, tell whoever looks after the dashboard: a rule has a problem, as the phone-number mistake did.`);
  lines.push('3. Run this again after you have made checks (`node tools/monte-carlo.js`). Real checks then replace the guesses in section 1.', '');
  lines.push('## The guesses behind the numbers', '');
  for (const [name, x] of Object.entries(SCENARIOS)) lines.push(`- **${name}:** ratings shifted by ${x.shift[0]} (give or take ${x.shift[1]}) and spread between ${pct(x.slope[0])} and ${pct(x.slope[1])} of what they say; a hidden problem per question of typical size ${x.wobble}; a person catches ${pct(x.humanCatch)} of the mistakes in answers they check.`);
  lines.push('- Answers are treated as independent apart from the per-question effect.');
  lines.push('- Changing these guesses changes the numbers. They are written at the top of `tools/monte-carlo.js` so they can be changed and the report remade.');
  return lines.join('\n') + '\n';
}

// -------------------------------------------------------------------------------------- running it ---
function runAll({ resultsDir, runs = 5000, weightRuns = 1000, seed = 20261117, now = new Date() }) {
  const loaded = loadValues(resultsDir);
  const rows = scoreAll(loaded.values, now);
  const accuracy = simulateAccuracy(rows, { runs, seed });
  const scenarios = {
    honest: simulateAccuracy(rows, { runs, seed: seed + 10, assume: SCENARIOS.honest }),
    middle: accuracy,
    optimistic: simulateAccuracy(rows, { runs, seed: seed + 11, assume: SCENARIOS.optimistic }),
  };
  const sampling = simulateSampleSize(accuracy.ready, { runs: Math.min(runs, 3000), seed: seed + 1 });
  const weights = simulateWeights(loaded.values, now, { runs: weightRuns, seed: seed + 2 });
  return { meta: { date: now.toISOString().slice(0, 10), schools: loaded.schools, skippedWrongSite: loaded.skippedWrongSite, values: rows.length, runs, weightRuns, seed }, accuracy, scenarios, sampling, weights };
}

module.exports = { rng, normal, wilson, summarize, quantile, loadValues, scoreAll, simulateAccuracy, simulateSampleSize, simulateWeights, buildReport, runAll, ASSUME, SCENARIOS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
  const root = path.join(__dirname, '..');
  const { PATHS } = require('../src/lib/util');
  const runs = Number(opt('runs', 5000)), seed = Number(opt('seed', 20261117));
  const t0 = Date.now();
  const res = runAll({ resultsDir: PATHS.resultsDir, runs, weightRuns: Math.max(200, Math.round(runs / 5)), seed });
  const out = path.resolve(root, opt('out', path.join('docs', 'MONTE-CARLO-REPORT.md')));
  fs.writeFileSync(out, buildReport(res));
  const json = opt('json', null);
  if (json) fs.writeFileSync(path.resolve(root, json), JSON.stringify(res, null, 1));
  console.log(`Simulated ${res.meta.values} answers from ${res.meta.schools} schools in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
  console.log(`Report written to ${out}`);
}
