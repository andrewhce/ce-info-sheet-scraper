'use strict';
// Checks the automatic trust score: what moves it, by how much, and that real cases land where a researcher would expect.
// The score never looks at the user's sheet (it can be old or wrong): it judges where a value came from and how plainly the page states it.
//   node tests/trust.test.js
const assert = require('assert');
const { scoreValue, priorsFromChecks, isFact, currentYearStart, sourceTier, FIELDS, LEVELS, MIN_PRIOR_CHECKS } = require('../src/lib/trust');
const { buildQueue } = require('../src/lib/review-queue');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };
const NOW = new Date('2026-11-17T00:00:00Z');   // the 2026-27 school year is the current one

/** A found value as the scraper saves it. */
const found = (over) => ({ status: 'found', value: '$40,000', confidence: 'medium', sources: [{ url: 'https://school.example/tuition' }], snippet: 'Tuition for 2026-2027 is $40,000.', num: 40000, ...over });
const score = (key, field, extra) => scoreValue({ key, field, now: NOW, ...(extra || {}) });
const s = (key, field, extra) => score(key, field, extra).score;
// the school's pages, by what kind of page each is
const pages = [
  { url: 'https://school.example/tuition', topics: ['tuition'], kind: 'html' },
  { url: 'https://school.example/about/at-a-glance', topics: ['facts'], kind: 'html' },
  { url: 'https://school.example/files/school-profile.pdf', topics: ['pdf'], kind: 'pdf' },
  { url: 'https://school.example/admissions', topics: ['admissions'], kind: 'html' },
  { url: 'https://school.example/about', topics: ['about'], kind: 'html' },
  { url: 'https://school.example/news/story', topics: ['about'], kind: 'html' },
  { url: 'https://school.example/', topics: ['home'], kind: 'html' },
  { url: 'https://school.example/college', topics: ['college'], kind: 'html' },
];
const from = (key, url, over, extra) => score(key, found({ sources: [{ url }], ...(over || {}) }), { pages, ...(extra || {}) });

// ---------------------------------------------------------------- what is scored ---
{
  assert.deepStrictEqual(Object.keys(FIELDS).sort(), ['applicationOpenDate', 'classSize', 'collegeEnrollment', 'counselors', 'decisionDate', 'enrollment', 'facultyDegrees', 'grades', 'location', 'ratio', 'tuition'].sort());
  assert.ok(isFact('tuition') && !isFact('about') && !isFact('mission') && !isFact('hasOwnProperty'));
  assert.strictEqual(score('about', found({ value: 'A long paragraph' })), null, 'copied text sections are not scored');
  assert.strictEqual(score('tuition', { status: 'none' }), null, 'nothing found, nothing to score');
  assert.strictEqual(score('tuition', null), null);
  const t = score('tuition', found());
  assert.ok(t.score >= 1 && t.score <= 99 && ['high', 'medium', 'low'].includes(t.level) && ['ready', 'check', 'doubtful'].includes(t.triage));
  assert.ok(t.reasons.length >= 2 && t.reasons[0].effect === 0, 'the first reason is the starting point');
  assert.ok(FIELDS.grades.baseline > FIELDS.tuition.baseline && FIELDS.tuition.baseline > FIELDS.enrollment.baseline && FIELDS.enrollment.baseline > FIELDS.counselors.baseline, 'a field the rule reads plainly starts higher than one it has to guess at');
  ok('only the key facts are scored, and a plainly labelled field starts higher than one the rule has to guess at');
}

// ------------------------------------------------------ the sheet plays no part ---
{
  const f = found({ note: 'School year on the page: 2026-2027' });
  const base = score('tuition', f, { pages });
  for (const verdict of ['match', 'differs', 'fills', 'both']) {
    const t = score('tuition', f, { pages, verdict, sheetText: '$12,345 something else entirely' });
    assert.deepStrictEqual([t.score, t.needsReview, t.triage], [base.score, base.needsReview, base.triage], `the sheet (${verdict}) must not change the score`);
    assert.ok(!t.reasons.some((r) => /sheet/i.test(r.text)), 'no reason mentions the sheet');
  }
  ok('the sheet is not an input: whatever it says, the score, the review flag and the reasons do not change');
}

// ------------------------------------------------------------ where it came from ---
{
  const tier = (u) => sourceTier(FIELDS.tuition, [u], pages).tier;
  assert.strictEqual(tier('https://school.example/about/at-a-glance'), 'official', 'an at-a-glance page is the school\'s own summary of record');
  assert.strictEqual(tier('https://school.example/files/school-profile.pdf'), 'official', 'a school profile PDF is official');
  assert.strictEqual(tier('https://school.example/tuition'), 'dedicated', 'the tuition page is the school\'s page about tuition');
  assert.strictEqual(tier('https://school.example/admissions'), 'related');
  assert.strictEqual(tier('https://school.example/'), 'general');
  assert.strictEqual(tier('https://school.example/news/story'), 'news');
  assert.strictEqual(tier('https://school.example/unknown-page'), 'general', 'a page the scraper has no record of is treated as general');
  assert.strictEqual(sourceTier(FIELDS.tuition, ['https://x.example/files/fact-sheet.pdf'], []).tier, 'official', 'a fact-sheet address is recognised even without a page record');
  assert.strictEqual(sourceTier(FIELDS.counselors, ['https://school.example/tuition'], pages).tier, 'general', 'a tuition page is not about counselors');
  assert.strictEqual(sourceTier(FIELDS.tuition, [], pages), null);
  // news is only a penalty when nothing better is listed
  assert.strictEqual(sourceTier(FIELDS.tuition, ['https://school.example/news/story', 'https://school.example/tuition'], pages).tier, 'dedicated');
  const order = ['https://school.example/about/at-a-glance', 'https://school.example/tuition', 'https://school.example/admissions', 'https://school.example/', 'https://school.example/news/story'].map((u) => from('tuition', u, { note: 'School year on the page: 2026-2027' }).score);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] >= order[i], `more reliable sources score at least as high: ${order}`);
  assert.ok(order[0] > order[4] + 15, 'a fact sheet is far above a news post');
  const t = from('tuition', 'https://school.example/about/at-a-glance', { note: 'School year on the page: 2026-2027' });
  assert.ok(t.reasons.some((r) => /very reliable/.test(r.text) && r.effect > 0), 'the reason names the source and is a plus');
  ok('a fact sheet or profile is the most reliable source, then the page about that topic, then a general page; a news post is the weakest');
}

// ----------------------------------------------------------------- the signals ---
{
  const base = s('tuition', found({ note: undefined }));
  // the quote
  assert.ok(s('tuition', found({ snippet: 'Tuition is $40,000 for the year.', note: undefined })) > s('tuition', found({ snippet: 'Tuition is listed on the page.', note: undefined })), 'a quote that shows the number beats one that does not');
  const word = (snippet) => s('counselors', found({ value: '5', num: 5, snippet, sources: [{ url: 'https://school.example/college' }] }), { pages });
  assert.ok(word('Our five counselors have 50 years of experience.') > word('Our counselors have 50 years of experience.'), 'a number written as a word ("five") is still shown by the quote');
  // the school year
  const yr = (note) => s('tuition', found({ note }));
  assert.ok(yr('School year on the page: 2026-2027') > yr('School year on the page: 2025-2026'), 'a current year beats one a year old');
  assert.ok(yr('School year on the page: 2025-2026') > yr('School year on the page: 2023-2024'), 'a year old beats three years old');
  assert.ok(yr('School year on the page: 2026-2027') > yr('No school year shown next to the figure.'), 'a stated year beats none');
  assert.strictEqual(currentYearStart(new Date('2026-03-01')), 2025); assert.strictEqual(currentYearStart(new Date('2026-09-01')), 2026);
  assert.strictEqual(s('enrollment', found({ value: '450', num: 450, snippet: '450 students', note: 'School year on the page: 2020-2021' })), s('enrollment', found({ value: '450', num: 450, snippet: '450 students', note: undefined })), 'the year only matters for fields that change every year');
  // which division
  const enr = (note) => s('enrollment', found({ value: '2,564', num: 2564, snippet: '2,564 students', note }));
  assert.ok(enr(undefined) > enr('The page does not say which division this number covers. It may be the whole school.'));
  // other pages
  const withAlts = (alts) => s('enrollment', found({ value: '861', num: 861, snippet: '861 students', alts }));
  assert.ok(withAlts(undefined) > withAlts([{ value: '247', url: 'https://x/y' }]), 'a different number elsewhere lowers it');
  assert.strictEqual(withAlts([{ value: '861', url: 'https://x/z' }]), withAlts(undefined), 'the same number elsewhere is not a conflict');
  const seen = (n) => s('classSize', found({ value: '15', num: 15, snippet: '15 students', seen: n }));
  assert.ok(seen(2) > seen(1) && seen(3) > seen(2) && seen(5) > seen(3), 'the same value on more pages of the school\'s site helps more');
  assert.ok(score('ratio', found({ value: '9:1', num: 9, snippet: '9:1', note: 'The site also says 13:1 (see other matches), so its own pages do not agree. Check which is current.' })).needsReview, 'two answers on the school\'s own pages always need a person');
  // grades and addresses: other ranges and other addresses on a page are normal
  const grades = (alts) => s('grades', found({ value: '9–12', num: null, snippet: 'Grades 9-12', alts }));
  assert.strictEqual(grades([{ value: 'K–6', url: 'a' }, { value: '7–8', url: 'b' }]), grades(undefined), 'other grade ranges are other divisions, not conflicts');
  const loc = (alts) => s('location', found({ value: '1310 Bryant St, Palo Alto, CA 94301', num: null, snippet: 'x', alts }));
  assert.strictEqual(loc([{ value: '1000 University Ave, Palo Alto, CA 94301' }]), loc(undefined), 'another address in the same postal code is not a warning');
  assert.ok(loc([{ value: '50 Country Day Drive, Short Hills, NJ 07078' }]) < loc(undefined) - 5, 'an address with another postal code suggests another campus');
  assert.strictEqual(s('location', found({ value: '1310 Bryant St, Palo Alto, CA 94301', num: null, snippet: 'x', alts: [{ value: '052-330 Castilleja School 1310 Bryant St, Palo Alto, CA 94301', url: 'u' }] })), loc(undefined), 'a wording that merely contains the address is not a conflict');
  const campus = (note) => s('location', found({ value: '131 Martinsville Road, Basking Ridge, NJ 07920', num: null, snippet: 'x', note, alts: [{ value: '50 Country Day Drive, Short Hills, NJ 07078' }] }));
  assert.ok(campus('seen on 20 pages; the site labels this campus for this division: “Grade 6 through Grade 8 in Basking Ridge”') > campus('seen on 20 pages; the site lists more than one address; check which campus this division uses') + 15, 'a campus the school labels for this division beats a guess between several campuses');
  // plausibility
  const hard = score('tuition', found({ value: '$500', num: 500, snippet: '$500' }));
  assert.ok(hard.needsReview && hard.score < base && hard.triage !== 'ready' && hard.reasons.some((r) => /impossible/.test(r.text)), 'an impossible tuition is sent to a person');
  assert.ok(score('enrollment', found({ value: '40,000', num: 40000, snippet: '40,000 students' })).needsReview);
  assert.ok(score('ratio', found({ value: '50:1', num: null, snippet: '50:1' })).needsReview, 'a ratio is tested as its larger number');
  assert.ok(s('classSize', found({ value: '40', num: 40, snippet: '40 students' })) < s('classSize', found({ value: '15', num: 15, snippet: '15 students' })), 'an unusual value is lower than a typical one');
  assert.ok(s('applicationOpenDate', found({ value: 'September 1, 2026', num: null, snippet: 'x' })) > s('applicationOpenDate', found({ value: 'June 1, 2026', num: null, snippet: 'x' })), 'an unusual month lowers a date');
  assert.ok(s('location', found({ value: '1310 Bryant Street, Palo Alto, CA 94301', num: null, snippet: 'x' })) > s('location', found({ value: 'Palo Alto, California', num: null, snippet: 'x' })), 'a full address beats a town');
  assert.ok(s('applicationOpenDate', found({ value: 'October 2, 2026', num: null, snippet: 'x' })) > s('applicationOpenDate', found({ value: 'October', num: null, snippet: 'x', note: 'Only a month is given on the page.' })), 'a month alone is weaker than a date');
  // counted, not stated
  const counted = score('counselors', found({ value: '4', num: 4, snippet: 'Director of College Counseling', note: 'Counted from job titles, not a stated number. Check the page for names.', confidence: 'low', sources: [{ url: 'https://school.example/college' }] }), { pages });
  const stated = score('counselors', found({ value: '4', num: 4, snippet: 'Four full-time college counselors support students.', confidence: 'high', sources: [{ url: 'https://school.example/college' }] }), { pages });
  assert.ok(stated.score > counted.score + 25 && counted.reasons.some((r) => /Counted from job titles/.test(r.text)), 'a count of job titles is far weaker than a number the school states');
  assert.strictEqual(counted.triage, 'doubtful');
  // the rule's own mark counts for very little
  assert.ok(Math.abs(s('tuition', found({ confidence: 'high' })) - s('tuition', found({ confidence: 'low' }))) <= 8, 'the rule\'s own confidence moves the score only a little');
  ok('every signal moves the score the right way: quote, school year, division, other pages, plausibility, counted values, the rule\'s own mark');
}

// ----------------------------------------------- a very reliable source is ready ---
{
  const yr = { note: 'School year on the page: 2026-2027' };
  const good = from('tuition', 'https://school.example/tuition', yr);
  assert.ok(good.score >= LEVELS.high && good.triage === 'ready', `a plainly stated, current tuition on the school's own tuition page is ready: ${good.score}`);
  assert.ok(from('tuition', 'https://school.example/about/at-a-glance', yr).triage === 'ready');
  assert.ok(from('tuition', 'https://school.example/', yr).score < good.score, 'the same figure on a general page is weaker');
  assert.notStrictEqual(from('tuition', 'https://school.example/tuition', { note: 'No school year shown next to the figure.' }).triage, 'ready', 'a tuition with no school year is a quick check, even on the tuition page');
  const grades = from('grades', 'https://school.example/about/at-a-glance', { value: '9–12', num: null, snippet: 'grades 9-12', seen: 5 });
  assert.ok(grades.score >= LEVELS.high && grades.triage === 'ready');
  const enr = (url, over) => from('enrollment', url, { value: '861', num: 861, snippet: 'Total Enrollment 861', confidence: 'high', ...(over || {}) });
  assert.strictEqual(enr('https://school.example/about/at-a-glance').triage, 'ready', 'a headcount stated on the school\'s fact page is ready');
  assert.notStrictEqual(enr('https://school.example/about/at-a-glance', { note: 'The page does not say which division this number covers. It may be the whole school.' }).triage, 'ready', 'but not when it may be the whole school\'s number');
  assert.notStrictEqual(enr('https://school.example/about').triage, 'ready', 'a headcount from a general about page needs a quick check');
  // a field the rule can only guess at never reaches ready without a strong source
  const weak = from('counselors', 'https://school.example/college', { value: '5', num: 5, snippet: 'five names', note: 'Counted from job titles', confidence: 'low' });
  assert.strictEqual(weak.triage, 'doubtful');
  // wrong-website schools are never trusted, even from a perfect source
  const wrong = from('location', 'https://school.example/about/at-a-glance', { value: '1310 Bryant St, Palo Alto, CA 94301', num: null, snippet: '1310 Bryant St' }, { identityBad: true });
  assert.ok(wrong.score <= 5 && wrong.triage === 'doubtful' && wrong.needsReview && /different school/.test(wrong.reasons[0].text), 'nothing from a wrong-website school is trusted');
  assert.ok(LEVELS.high > LEVELS.medium);
  ok('a plainly stated value from the school\'s own fact sheet or topic page is ready; guessed, ambiguous or general-page values are not; wrong-website schools never are');
}

// ------------------------------------------------ learning from the spot-checks ---
{
  const checks = {};
  for (let i = 0; i < 12; i++) checks['s' + i + '|tuition'] = { field: 'tuition', verdict: i < 6 ? 'correct' : 'wrong' };
  for (let i = 0; i < 4; i++) checks['t' + i + '|ratio'] = { field: 'ratio', verdict: 'wrong' };
  for (let i = 0; i < 20; i++) checks['c' + i + '|counselors'] = { field: 'counselors', verdict: i < 19 ? 'correct' : 'wrong' };
  checks['m|tuition'] = { field: 'tuition', verdict: 'missed' }; checks['a|tuition'] = { field: 'tuition', verdict: 'absent' };
  const priors = priorsFromChecks(checks);
  assert.deepStrictEqual([priors.get('tuition').n, priors.get('tuition').p], [12, 0.5], 'only right and wrong checks count');
  assert.ok(!priors.has('ratio'), `fewer than ${MIN_PRIOR_CHECKS} checks do not move a field`);
  const f = found({ note: 'School year on the page: 2026-2027' });
  assert.ok(s('tuition', f, { prior: priors.get('tuition') }) < s('tuition', f), 'a field the person found wrong half the time drops');
  const cf = found({ value: '5', num: 5, snippet: 'x', note: 'Counted from job titles' });
  assert.ok(s('counselors', cf, { prior: priors.get('counselors') }) > s('counselors', cf), 'a field the person found right 95% of the time rises, even from a weak start');
  assert.ok(score('tuition', f, { prior: priors.get('tuition') }).reasons[0].text.includes('Your spot-checks'), 'the reason says the number came from the person\'s checks');
  assert.ok(score('tuition', f, { prior: { n: 3, p: 0 } }).reasons[0].text.includes('Starting point'), 'too few checks are ignored');
  ok('the person\'s Right / Wrong spot-checks replace a field\'s starting number once there are enough of them');
}

// ------------------------------------------------------------------------ dates ---
{
  const d = (value, extra, ctx) => score('decisionDate', found({ value, num: null, snippet: 'Decisions released ' + value, sources: [{ url: 'https://school.example/admissions' }], ...(extra || {}) }), { pages, ...(ctx || {}) });
  assert.ok(d('March 12, 2027').score > d('March 12', { note: 'The page gives no year for this date.' }).score, 'a date with its year beats one without');
  assert.ok(d('March 12, 2027').reasons.some((r) => /includes the year \(2027\)/.test(r.text) && r.effect > 0));
  assert.ok(d('March 12, 2026').score < d('March 12, 2027').score && d('March 12, 2026').reasons.some((r) => /before this admission cycle/.test(r.text)), 'a date from last cycle is lowered');
  const early = d('December 10, 2026', { confidence: 'low', note: 'This looks like an early-round or late-applicant date. The main date was not found, so check the page.' });
  assert.ok(early.score < d('February 18, 2027').score - 10 && early.reasons.some((r) => /early-round/.test(r.text)), 'an early-round date is marked down');
  const partial = score('enrollment', found({ value: '57', num: 57, snippet: '57 Boarding Students', note: 'This counts only the day or only the boarding students, so the whole school is probably larger.' }));
  assert.ok(partial.score < s('enrollment', found({ value: '57', num: 57, snippet: '57 students' })) && partial.reasons.some((r) => /only the day or only the boarding/.test(r.text)), 'a boarding-only count is marked down');
  assert.strictEqual(d('March 12, 2027', null, { verdict: 'differs', sheetText: 'March 13, 2026' }).score, d('March 12, 2027').score, 'an old date in the sheet changes nothing');
  ok('dates: the year helps, early rounds and boarding-only counts are marked down');
}

// ---------------------------------------------------------------- real cases ---
{
  // shapes taken from real saved results
  const profilePages = [{ url: 'https://mitty.example/assets/files/schoolprofile.pdf', topics: ['pdf'], kind: 'pdf' }, { url: 'https://mitty.example/about', topics: ['about'], kind: 'html' }, { url: 'https://mitty.example/tuition-and-fees', topics: ['tuition'], kind: 'html' }];
  const mittyEnrollment = score('enrollment', { status: 'found', value: '947', confidence: 'medium', num: 947, snippet: 'Total Exams: 2,564 Total Students: 947', sources: [{ url: 'https://mitty.example/assets/files/schoolprofile.pdf' }], alts: [{ value: 'Approximately 450', url: 'https://mitty.example/x' }], note: 'The page does not say which division this number covers. It may be the whole school.' }, { pages: profilePages });
  assert.notStrictEqual(mittyEnrollment.triage, 'ready', 'a headcount that may cover the whole school, with another number elsewhere, is not ready');
  const mittyTuition = score('tuition', { status: 'found', value: 'The tuition for 2026-2027 is $33,860.00 per student', confidence: 'medium', num: 33860, snippet: 'The tuition for 2026-2027 is $33,860.00 per student', sources: [{ url: 'https://mitty.example/tuition-and-fees' }, { url: 'https://mitty.example/faq' }], note: 'School year on the page: 2026-2027' }, { pages: profilePages });
  assert.strictEqual(mittyTuition.triage, 'ready', 'a current tuition on the tuition page is ready');
  const aeonTuition = score('tuition', { status: 'found', value: 'Full tuition $40,500/yr', confidence: 'medium', num: 40500, snippet: 'Full tuition $40,500/yr', sources: [{ url: 'https://aeon.example/' }], note: 'No school year shown next to the figure.' }, { pages: [{ url: 'https://aeon.example/', topics: ['home'] }] });
  assert.notStrictEqual(aeonTuition.triage, 'ready', 'a tuition from a general page with no school year needs a look');
  assert.ok(mittyTuition.score > aeonTuition.score + 15);
  assert.strictEqual(score('location', { status: 'found', value: '1310 Bryant Street, Palo Alto, CA 94301', confidence: 'high', snippet: '1310 Bryant Street', sources: [{ url: 'https://castilleja.example/contact' }], seen: 22 }, { pages: [{ url: 'https://castilleja.example/contact', topics: ['contact'] }] }).triage, 'ready');
  ok('real cases land where a researcher would put them (a current tuition on the tuition page ready; a whole-school headcount or a tuition with no year not)');
}

// ------------------------------------------------------------ the review queue ---
{
  const mk = (id, name, tier, rows, bad) => ({ id, name, tier, rows, bad });
  const world = [
    mk('a', 'Alpha', 1, [['tuition', 'ready', 90], ['enrollment', 'doubtful', 20], ['counselors', 'check', 70]]),
    mk('b', 'Beta', 2, [['tuition', 'check', 75], ['ratio', 'doubtful', 30]]),
    mk('c', 'Gamma', 1, [['tuition', 'doubtful', 5]], true),
  ];
  const data = {
    overview: () => ({ ready: true, schools: world.map((w) => ({ id: w.id, name: w.name, tier: w.tier, status: 'ok', wrongSite: !!w.bad })) }),
    compareSchool: (id) => ({ rows: world.find((w) => w.id === id).rows.map(([key, triage, score]) => ({ kind: 'field', key, label: key + ':', verdict: 'differs', sheet: [{ text: 'sheet-' + key }], scraped: { status: 'found', value: 'v-' + key, sources: key === 'counselors' ? [] : [{ url: 'https://school.example/' + key }] }, trust: { triage, score, level: score >= 88 ? 'high' : score >= 65 ? 'medium' : 'low', reasons: [{ text: 'because ' + key, effect: score < 65 ? -10 : 0 }] } })) }),
  };
  const q = buildQueue(data, new Set(), {});
  assert.deepStrictEqual([q.facts, q.readyToUse, q.needLook, q.skippedWrongSite], [5, 1, 4, 1], 'ready values and wrong-website schools are not queued');
  assert.deepStrictEqual(q.items.map((i) => i.field), ['enrollment', 'ratio', 'counselors', 'tuition'], 'most doubtful first');
  assert.strictEqual(q.items[0].source, 'https://school.example/enrollment', 'each item links to the page the value came from');
  assert.strictEqual(q.items.find((i) => i.field === 'counselors').source, null, 'no source, no link');
  assert.ok(q.items.every((i) => !('sheet' in i) && !('verdict' in i)), 'the sheet plays no part in the queue');
  assert.strictEqual(buildQueue(data, new Set(['a|enrollment']), {}).needLook, 3, 'a value a person has checked leaves the queue');
  assert.strictEqual(buildQueue(data, new Set(['a|enrollment']), {}).checked, 1);
  assert.deepStrictEqual(buildQueue(data, new Set(), { tier: 2 }).items.map((i) => i.school), ['Beta', 'Beta']);
  assert.deepStrictEqual(buildQueue(data, new Set(), { field: 'tuition' }).items.map((i) => i.school), ['Beta']);
  assert.deepStrictEqual(buildQueue(data, new Set(), { level: 'doubtful' }).items.map((i) => i.field), ['enrollment', 'ratio']);
  assert.deepStrictEqual(q.byField.map((f) => f.n), [1, 1, 1, 1]);
  ok('the review queue lists only values that need a person, most doubtful first, with a link to the source page, and drops checked ones and wrong-website schools');
}

console.log(`\n${passed} checks passed.`);
