'use strict';
// Checks the field rules against small made-up pages, one trap at a time. Every case here is a real mistake the
// scraper once made on a real school website (the school is named in the comment), so it cannot come back unnoticed.
//   node tests/rules.test.js
const assert = require('assert');
const { extractSchool } = require('../src/lib/rules');
const { siteIdentity } = require('../src/lib/identity');
const { compareField, qualifiedRange } = require('../src/lib/compare');

const NOW = new Date('2026-11-12T12:00:00Z');
const page = (url, topics, blocks, extra) => ({
  ok: true, url, finalUrl: url, title: 'Test page', topics, kind: 'html', jsonld: [],
  blocks: blocks.map((b) => (typeof b === 'string' ? { k: 'p', z: 'main', text: b } : { z: 'main', ...b })), ...(extra || {}),
});
const run = (pages, school) => extractSchool({ id: 't', name: 'Test School', division: null, region: '', ...(school || {}) }, { pages }, NOW);
const facts = (blocks, school) => run([page('https://school.example/about/at-a-glance', ['facts'], blocks)], school);

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('  ok   ' + name); };

// ------------------------------------------------------------------ enrollment ---
check('enrollment: money, percentages and graduating years are not headcounts (BASIS, Horace Mann, Stanford Online, Granada Hills)', () => {
  const f = facts([
    'Non-Refundable Enrollment Deposit $3,000.00 $3,000.00 Due Upon Enrollment Annual Tuition $36,380.00',
    'The tuition charge does not include an Enrollment Fee of $100, Parent Association Dues of $85.',
    'Percent of students per enrollment level 46%',
    '62 Class of 2026 students recognized as National Merit Finalists',
    '4614 STUDENTS SCORED',
    'Re-enrollment contracts are due in February, 1,200 families',
  ]);
  assert.strictEqual(f.enrollment.status, 'none', JSON.stringify(f.enrollment));
});
check('enrollment: the school\'s own hedge word is kept with the number (Stanford Online, Horace Mann, Merry Moppet)', () => {
  let f = facts(['We enroll more than 1,000 students each year from 48 U.S. states, 47 countries, and six continents.']);
  assert.strictEqual(f.enrollment.value, 'More than 1,000'); assert.strictEqual(f.enrollment.num, 1000);
  f = facts(['Student Body: Approximately 365 students residing in Belmont and neighboring cities throughout the Peninsula']);
  assert.strictEqual(f.enrollment.value, 'Approximately 365'); assert.strictEqual(f.enrollment.num, 365);
});
check('enrollment: real stat tiles and plain statements still work', () => {
  assert.strictEqual(facts([{ k: 'p', text: '416' }, { k: 'p', text: 'Students' }, { k: 'p', text: '14' }, { k: 'p', text: 'Average class size' }]).enrollment.value, '416');
  assert.strictEqual(facts(['Total Enrollment 861']).enrollment.value, '861');
  assert.strictEqual(facts(['Today, our alpine campus is home to 280 students, world-class teachers, and an international network of alumni.']).enrollment.value, '280');
});

// ----------------------------------------------------------------------- ratio ---
check('ratio: a paid add-on service is not the school\'s ratio (Eastside Prep)', () => {
  const f = facts(['Guided Study Hall | $5,300 | 4:1 student to faculty ratio of academic support']);
  assert.strictEqual(f.ratio.status, 'none');
  assert.strictEqual(facts(['8:1 student-teacher ratio']).ratio.value, '8:1');
});
check('ratio: two different ratios on the school\'s own pages are flagged, not silently chosen (Eastside Catholic)', () => {
  const f = run([
    page('https://school.example/facts', ['facts'], ['Our student-teacher ratio is 13:1.']),
    page('https://school.example/about', ['facts'], ['The student-teacher ratio is 18:1.']),
  ]);
  assert.strictEqual(f.ratio.status, 'found');
  assert.strictEqual(f.ratio.confidence, 'medium');
  assert.ok(/also says/.test(f.ratio.note || ''), f.ratio.note);
  assert.ok(f.ratio.alts && f.ratio.alts.length === 1);
});

// -------------------------------------------------------------- faculty degrees ---
check('faculty degrees: another division\'s figure is not used, the right percentage is picked, hedge words kept (Bentley, Eastside Catholic, Nueva)', () => {
  const upper = '76% Upper School faculty who hold advanced degrees';
  assert.strictEqual(facts([upper], { division: 'middle' }).facultyDegrees.status, 'none');
  assert.strictEqual(facts([upper], { division: 'upper' }).facultyDegrees.value, '76%');
  assert.strictEqual(facts(['100% of graduates are college-bound (2025) 89 faculty 57% Faculty holding advanced degrees 12 National Board Certification']).facultyDegrees.value, '57%');
  const n = facts(['More than 80% of our Upper School faculty hold advanced degrees.'], { division: 'upper' }).facultyDegrees;
  assert.strictEqual(n.value, 'More than 80%'); assert.strictEqual(n.num, 80);
});

// -------------------------------------------------------------------- location ---
check('location: hotels and restaurants on a visitor page are not the school (Choate, Deerfield); "Suite" in a real address is fine', () => {
  const hotels = run([page('https://school.example/visit/lodging', ['visit'], [
    'Fairfield Inn by Marriott (Call for discounted rates), (203) 284-0001, 100 Miles Drive, Wallingford, CT 06492',
    'D. Hotel & Suites (21 mi.) 1 Country Club Road, Holyoke, MA 01040 (413) 533-2100',
  ])]);
  assert.strictEqual(hotels.location.status, 'none', JSON.stringify(hotels.location));
  const real = run([page('https://school.example/contact', ['about'], ['Proof School, 221 Main Street, Suite 104, San Francisco, CA 94105'])]);
  assert.strictEqual(real.location.status, 'found');
  assert.ok(/221 Main Street/.test(real.location.value), real.location.value);
});

// ------------------------------------------------------------------- open date ---
check('application open date: a closing date is not an opening date (Granada Hills)', () => {
  const f = run([page('https://school.example/admissions/apply', ['admissions', 'process'], [
    'The Post Lottery Application for 2027-2028 will be made available following the lottery application window closing on December 1 at 3:00 p.m.',
  ])]);
  assert.strictEqual(f.applicationOpenDate.status, 'none', JSON.stringify(f.applicationOpenDate));
  const ok = run([page('https://school.example/admissions/apply', ['admissions', 'process'], ['Applications for 2027-2028 open on September 28, 2026.'])]);
  assert.strictEqual(ok.applicationOpenDate.status, 'found');
});

// --------------------------------------------------------------------- tuition ---
check('tuition: the sliding-scale table of what a family pays after aid is not the tuition (Nueva)', () => {
  const f = run([page('https://school.example/tuition', ['tuition'], [
    'Family’s Tuition Payment, Per Child | $0 | $7,900 | $32,000 | $40,000',
    'Upper School tuition for 2026-27 is $65,065.',
  ])], { division: 'upper' });
  assert.strictEqual(f.tuition.status, 'found');
  assert.ok(f.tuition.value.includes('$65,065') && !f.tuition.value.includes('$7,900'), f.tuition.value);
});

// -------------------------------------------------------------- website identity ---
check('website identity: the school\'s name must appear somewhere on the site it is linked to (Crystal Springs -> Crossroads)', () => {
  const crossroads = [page('https://www.xrds.org/', ['home'], ['Crossroads School for Arts & Sciences in Santa Monica'], { title: 'Crossroads School' })];
  const bad = siteIdentity({ name: 'Crystal Springs (Middle) School', website: 'https://www.xrds.org/' }, crossroads);
  assert.strictEqual(bad.ok, false); assert.deepStrictEqual(bad.checked.sort(), ['crystal', 'springs']);
  const good = siteIdentity({ name: 'Crossroads (Middle) School', website: 'https://www.xrds.org/' }, crossroads);
  assert.strictEqual(good.ok, true);
});
check('website identity: no false alarms for division suffixes, old names, campus tails, accents, web addresses', () => {
  const site = (title, text, host) => [page(`https://${host}/`, ['home'], [text], { title })];
  assert.ok(siteIdentity({ name: 'Menlo (Upper) School', website: 'https://www.menloschool.org/' }, site('Menlo School', 'Welcome', 'www.menloschool.org')).ok);
  assert.ok(siteIdentity({ name: 'AEON School (formerly Avenues Silicon Valley)', website: 'https://aeonschool.org/' }, site('Home', 'Formerly Avenues Silicon Valley', 'aeonschool.org')).ok);
  assert.ok(siteIdentity({ name: 'BASIS Independent (Lower) School | Fremont', website: 'https://basisindependent.com/' }, site('Home', 'x', 'basisindependent.com')).ok);
  assert.ok(siteIdentity({ name: 'Académie Sainte-Croix', website: 'https://academie-saintecroix.example/' }, site('Home', 'Bienvenue à Sainte-Croix', 'academie-saintecroix.example')).ok);
  assert.ok(siteIdentity({ name: 'Convent & Stuart Hall', website: 'https://www.sacredsf.org/' }, site('Home', 'Stuart Hall for Boys', 'www.sacredsf.org')).ok);
  const nameless = siteIdentity({ name: 'The School', website: 'https://x.example/' }, site('Home', 'x', 'x.example'));
  assert.ok(nameless.ok && nameless.checked.length === 0, 'a name with no distinctive words cannot be checked');
});

// ------------------------------------------------------------------ comparison ---
check('comparison: hedge words become ranges, so "1,823" agrees with "More than 1,800" but not with "More than 80%" of 68', () => {
  assert.deepStrictEqual(qualifiedRange('More than 1,800', 1800), [1800, 2250]);
  assert.strictEqual(qualifiedRange('1,800', 1800), null);
  const cells = (t) => [{ text: t }];
  const f = (value, num) => ({ status: 'found', value, num });
  assert.strictEqual(compareField('enrollment', cells('1,823 | Nursery: 146 | Lower: 469'), f('More than 1,800', 1800)), 'match');
  assert.strictEqual(compareField('enrollment', cells('Over 2,200 students'), f('Over 2,200', 2200)), 'match');
  assert.strictEqual(compareField('enrollment', cells('5,000'), f('Over 2,200', 2200)), 'differs');
  assert.strictEqual(compareField('enrollment', cells('Nearly 6,000 students'), f('Nearly 6,000', 6000)), 'match');
  assert.strictEqual(compareField('enrollment', cells('1,800'), f('Approximately 365', 365)), 'differs');
  assert.strictEqual(compareField('facultyDegrees', cells('68%'), f('More than 80%', 80)), 'differs');
  assert.strictEqual(compareField('facultyDegrees', cells('81%'), f('More than 80%', 80)), 'match');
  assert.strictEqual(compareField('enrollment', cells('870'), f('861', 861)), 'differs', 'an exact number must still be exact');
});
check('comparison: a stray space after the comma in a typed price does not break the match (Eastside Catholic)', () => {
  assert.strictEqual(compareField('tuition', [{ text: '2026-27 Tuition Middle School: $33, 750 | High School: $33, 750' }], { status: 'found', value: 'x $33,750', num: 33750 }), 'match');
});

console.log(`\n${passed} checks passed.`);
