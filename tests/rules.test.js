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

// ------------------------------------------- weak fields fixed after the first trust-score review ---
check('enrollment: a phone number, a graduating class and a label that belongs to another number are not headcounts (Woodside Priory, St. Mark\'s, Nueva, Mitty)', () => {
  let f = facts(['Director of Enrollment Management and Access (650) 851-6158', 'Director of Enrollment Management 214-346-8202 CrouchA@smtexas.org']);
  assert.strictEqual(f.enrollment.status, 'none', JSON.stringify(f.enrollment));
  f = facts(['Class of 2026 enrollment 113']);
  assert.strictEqual(f.enrollment.status, 'none', JSON.stringify(f.enrollment));
  // "Total Exams: 2,564" is the number of AP exams; the students are the number that follows "Total Students:"
  f = facts(['Total Exams: 2,564 Total Students: 947 Scored 3 or higher: 92% AP Subjects % Scoring 3 or Higher']);
  assert.strictEqual(f.enrollment.value, '947', JSON.stringify(f.enrollment));
  f = facts(['Total students: 845']);
  assert.strictEqual(f.enrollment.value, '845');
});
check('enrollment: a day-only or boarding-only count loses to the whole-school number (Woodside Priory)', () => {
  const f = facts(['57 Boarding Students (Grades 9-12)', 'Total Enrollment 427']);
  assert.strictEqual(f.enrollment.value, '427', JSON.stringify(f.enrollment));
  const only = facts(['57 Boarding Students (Grades 9-12)']);
  assert.ok(only.enrollment.status !== 'found' || /only the day or only the boarding/.test(only.enrollment.note || ''), JSON.stringify(only.enrollment));
});
check('ratio: "collaboration" is not "ratio", and a clock time is not a ratio (Pingry)', () => {
  const f = facts(['10:00 AM Read More about LS Faculty Collaboration Morning Schedule | LS Classes begin at 10:00 a.m.', 'The faculty collaboration time is 8:30 for students and teachers']);
  assert.strictEqual(f.ratio.status, 'none', JSON.stringify(f.ratio));
  assert.strictEqual(facts(['Student-teacher ratio 10:1, with classes starting at 10:00 a.m.']).ratio.value, '10:1');
});
check('counselors: "our five counselors" on the college counseling page is a stated number, and a counted value can be compared (Lakeside)', () => {
  let f = run([page('https://school.example/academics/college-counseling', ['college'], ['A professional team: Our five counselors’ expertise is drawn from more than 50 years of collective college counseling experience.'])]);
  assert.strictEqual(f.counselors.value, '5'); assert.strictEqual(f.counselors.num, 5);
  f = run([page('https://school.example/academics/college-counseling', ['college'], ['Our student life team includes 21 peer counselors and five grade-level deans.'])]);
  assert.notStrictEqual(f.counselors.value, '21', 'peer counselors are students');
  f = run([page('https://school.example/academics/college-counseling/team', ['college'], [
    'Ari Worthman, director of college counseling', 'Erin Foster, associate director of college counseling', 'Frances Nan, associate director of college counseling'])]);
  assert.strictEqual(f.counselors.num, 3, 'a count of titles carries its number so the sheet can be compared');
  assert.strictEqual(compareField('counselors', [{ text: '3 Ari Worthman ...' }], f.counselors), 'match');
  assert.strictEqual(compareField('counselors', [{ text: '7 Ari Worthman ...' }], f.counselors), 'differs');
});
check('decision date: an early-round or late-applicant date loses to the regular one (Pingry, Deerfield, Trinity)', () => {
  const f = run([page('https://school.example/apply/process', ['admissions', 'process'], [
    'December 10, 2026 - Early Action (Grade 9 only) Admission Decisions are published in the admissions portal',
    'February 18, 2027 - Regular Admission Decisions are published in the admissions portal',
  ])]);
  assert.strictEqual(f.decisionDate.value, 'February 18, 2027', JSON.stringify(f.decisionDate));
  const only = run([page('https://school.example/apply/process', ['admissions', 'process'], [
    'December 10, 2026 - Early Action Admission Decisions are published in the admissions portal'])]);
  assert.strictEqual(only.decisionDate.confidence, 'low'); assert.ok(/early-round/.test(only.decisionDate.note), 'with no main date, the early one is shown but flagged');
});
check('dates: a kindergarten calendar is not a middle or upper school\'s, and an open house is not the application opening (Dalton, Trinity, Overlake)', () => {
  const kg = run([page('https://school.example/apply/steps', ['admissions', 'process'], ['Kindergarten applications open on August 13 and will be accepted until November 13.'])], { division: 'upper' });
  assert.strictEqual(kg.applicationOpenDate.status, 'none', JSON.stringify(kg.applicationOpenDate));
  const lower = run([page('https://school.example/apply/steps', ['admissions', 'process'], ['Kindergarten applications open on August 13 and will be accepted until November 13.'])], { division: 'lower' });
  assert.strictEqual(lower.applicationOpenDate.status, 'found');
  const oh = run([page('https://school.example/admissions/visit', ['admissions', 'visit'], ['Sunday, December 13th, 2026 — You can register for an Open House through your application account.'])]);
  assert.strictEqual(oh.applicationOpenDate.status, 'none', JSON.stringify(oh.applicationOpenDate));
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

check('location: a campus label in another block picks the campus for this division, and two addresses in one town are not told apart by town (Pingry, Sidwell, Nueva, Harker)', () => {
  const campuses = (division, extra) => run([page('https://school.example/contact', ['contact'], [
    'Basking Ridge Campus: Grades 6–12', '131 Martinsville Road, Basking Ridge, NJ 07920',
    'Short Hills Campus: Grades K-5', '50 Country Day Drive, Short Hills, NJ 07078',
    ...(extra || [])])], { division });
  let f = campuses('lower');
  assert.ok(/Country Day Drive/.test(f.location.value), f.location.value);
  assert.ok(/labels this campus for this division/.test(f.location.note), f.location.note);
  f = campuses('upper');
  assert.ok(/Martinsville Road/.test(f.location.value) && /labels this campus/.test(f.location.note), JSON.stringify(f.location));
  // "Grade 6 through Grade 8 in Basking Ridge": the wording on an admissions page
  f = run([page('https://school.example/contact', ['contact'], ['131 Martinsville Road, Basking Ridge, NJ 07920', '50 Country Day Drive, Short Hills, NJ 07078']),
    page('https://school.example/apply', ['admissions'], ['Kindergarten through Grade 5 in Short Hills, New Jersey', 'Grade 6 through Grade 8 in Basking Ridge, New Jersey'])], { division: 'middle' });
  assert.ok(/Martinsville Road/.test(f.location.value) && /Grade 6 through Grade 8 in Basking Ridge/.test(f.location.note), JSON.stringify(f.location));
  // nothing says which campus: the rule still answers but says to check
  const footer = ['131 Martinsville Road, Basking Ridge, NJ 07920', '50 Country Day Drive, Short Hills, NJ 07078'];
  f = run(['contact', 'about', 'visit'].map((t) => page('https://school.example/' + t, [t], footer)), { division: 'middle' });
  assert.ok(/check which campus/.test(f.location.note || ''), JSON.stringify(f.location));
  // two campuses in the same town cannot be told apart by the town name, so a "Middle School in San Jose" line must not decide
  f = run([page('https://school.example/contact', ['contact'], [
    'Middle School in San Jose', '4525 Union Ave., San Jose, CA 95124', '500 Saratoga Ave., San Jose, CA 95129'])], { division: 'middle' });
  assert.ok(!/labels this campus/.test(f.location.note || ''), 'same-town campuses are not separated by a town label: ' + JSON.stringify(f.location));
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

check('mission: "Admissions" is not a mission heading, and a quoted testimonial is not a mission statement (ACS Cobham, Aiglon, BASIS, Pingry)', () => {
  const adm = page('https://school.example/admissions', ['admissions'], [
    { k: 'h', level: 2, text: 'Admissions' },
    'A warm welcome to our school. Whether you are making an international move or changing schools locally, we make admissions smooth.',
  ]);
  assert.strictEqual(run([adm]).mission.status, 'none', 'an Admissions heading must not produce a mission');
  const quote = page('https://school.example/about', ['about'], [
    { k: 'h', level: 2, text: 'Our Mission' },
    '“Welcoming, nurturing environment. Plenty of opportunities for the student to participate. My child is very happy here.”',
    'We inspire every student to think critically, act with integrity and build a life of service to the wider community.',
  ]);
  const m = run([quote]).mission;
  assert.strictEqual(m.status, 'found');
  assert.ok(m.value.startsWith('We inspire every student'), 'the quoted line is skipped, the real statement is used: ' + m.value);
  const real = page('https://school.example/about/mission', ['about'], [
    { k: 'h', level: 2, text: 'Mission & Values' },
    'Our mission is to develop curious, capable and kind young people ready to lead in a changing world.',
  ]);
  assert.strictEqual(run([real]).mission.status, 'found', 'a real "Mission & Values" heading still works');
});

console.log(`\n${passed} checks passed.`);
