'use strict';
// Answers from pages a person saved by hand from Ravenna, Niche, Private School Review and Boarding School Review, and
// adding a school without loading the whole sheet. Nothing here contacts a website: it only reads files.
//   node tests/sources.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sources-'));
process.env.DATA_DIR = tmp;                       // set before the modules read their folders
const { PATHS, readJson, writeJson } = require('../src/lib/util');
const sources = require('../src/lib/sources');
const { readSavedPage } = require('../src/lib/source-readers');
const { parseHtml } = require('../src/lib/html');
const schoolList = require('../src/lib/school-list');
fs.mkdirSync(PATHS.resultsDir, { recursive: true });

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ok   ' + name); };
const NOW = new Date('2026-11-19T12:00:00Z');
const TEMPLATE_KEYS = ['grades', 'enrollment', 'classSize', 'ratio', 'tuition', 'schoolType', 'location', 'sports', 'testScores', 'facultyDegrees', 'timeline', 'demographics', 'notes', 'peerSchools'];
writeJson(PATHS.template, { rows: TEMPLATE_KEYS.map((key) => ({ kind: 'field', key, label: key })) });

const filler = '<p>Example Hill School is an independent day school for students in grades 6 to 12 near the bay, with small classes and a long tradition of teaching.</p>'.repeat(3);
const bytes = (title, head, body) => Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head || ''}</head><body><main><h1>${title}</h1>${filler}${body || ''}</main></body></html>`);
const school = { id: 'example-hill-school', name: 'Example Hill School', division: null, region: 'Palo Alto, CA', tier: 1, website: 'https://www.examplehill.org/' };

// A page laid out like Private School Review: a facts table, a quick-facts list, and traps (a regional average, other schools)
const row = (n, v) => `<div class="dt-single-row-table"><div class="dt-row dt-single-row"><div class="dt-name-cell t-body">${n}</div><div class="dt-value-cell t-body">${v}</div></div></div>`;
const psrBody = `
  <section><h2>Quick Facts (26-27)</h2><ul class="quick-stats-ul"><li class="quick-stats-li">Grades: <strong>6-12</strong></li><li>Enrollment: <strong>424 students</strong></li><li>Yearly Tuition: <strong>$59,600</strong></li></ul></section>
  <div class="general-data-table">
    ${row('Religious Affiliation', '<a>Nonsectarian</a>')}${row('Grades Offered', 'Grades 6-12')}${row('Total Students', '424 students')}${row('Student Body Type', 'All-girls')}
    ${row('% Students of Color', '53%')}${row('Student-Teacher Ratio', "7:1<div class='dt-vc-avg'><em>National avg.: <a>11:1</a></em></div>")}${row('% Faculty w/Advanced Degree', '<div class="dt-percent-mask" data-percent="87">87%</div>')}
    ${row('Average Class Size', '15 students')}${row('Average SAT score', "1480<div class='dt-vc-avg'><em>(Out of 1600)</em></div>")}${row('Average ACT score', '33')}
    ${row('Admission Deadline', 'Jan. 9')}${row('Yearly Tuition Cost', '$59,600')}${row('Total Sports Offered', '11 sports')}
    ${row('Sports', '<span class="sports-section"><span>Basketball</span><span>Cross Country</span><span>Golf</span><span>Water Polo</span></span>')}
  </div>
  <p>The average private school tuition in Palo Alto, CA is $40,368 for elementary schools and $50,831 for high schools.</p>
  <section><h2>Nearby schools</h2><p>Avg. class size: 10 students</p><p>Gr: 9-12 | 1,891 students Student-Teacher Ratio: 17:1 Minority enrollment: 69%</p></section>`;
const psrHead = '<link rel="canonical" href="https://www.privateschoolreview.com/example-hill-school-profile"><script type="application/ld+json">{"@context":"http://schema.org","@type":"School","name":"Example Hill School","address":{"@type":"PostalAddress","streetAddress":"1310 Bryant St","addressLocality":"Palo Alto","addressRegion":"CA","postalCode":"94301"}}</script>';
const psrPage = () => bytes('Example Hill School (Top Ranked Private School) - Palo Alto, CA', psrHead, psrBody);

// A page laid out like Niche is believed to be: label and value elements with matching class names, a definition list, a table, plain lines
const nicheBody = `
  <div class="scalar"><div class="scalar__label">Student-Teacher Ratio</div><div class="scalar__value">8 to 1</div></div>
  <dl><dt>Total students</dt><dd>1,240</dd><dt>Grades</dt><dd>K-5</dd></dl>
  <table><tr><th>Tuition</th><td>$52,000</td></tr><tr><th>Average SAT</th><td>1450</td></tr></table>
  <p>Average class size: 14 students</p>`;
const nicheHead = '<link rel="canonical" href="https://www.niche.com/k12/d/example-hill-school-palo-alto-ca/">';
const nichePage = () => bytes('Example Hill School Reviews, Rankings | Niche', nicheHead, nicheBody);

(async () => {
  await check('a Private School Review page: every fact comes from the school’s own facts table, with its evidence, and the traps are ignored', async () => {
    const rec = { url: 'x', finalUrl: 'https://www.privateschoolreview.com/example-hill-school-profile', ok: true, kind: 'html', ...parseHtml(psrPage().toString(), 'https://x/') };
    rec._html = psrPage().toString('utf8');
    const f = readSavedPage(rec, 'psr', school, NOW).fields;
    const v = (k) => f[k] && f[k].value;
    assert.strictEqual(v('grades'), '6–12');
    assert.strictEqual(v('enrollment'), '424');
    assert.strictEqual(v('ratio'), '7:1', 'the national average beside it is not the answer');
    assert.strictEqual(v('classSize'), '15', 'a nearby school’s class size is not this school’s');
    assert.strictEqual(v('tuition'), '$59,600', 'the regional average tuition sentence is not this school’s tuition');
    assert.strictEqual(v('facultyDegrees'), '87%');
    assert.strictEqual(v('schoolType'), 'All Girls | Nonsectarian');
    assert.strictEqual(v('testScores'), 'Average SAT score: 1480\nAverage ACT score: 33');
    assert.strictEqual(v('sports'), 'Basketball, Cross Country, Golf, Water Polo', 'a bare count such as "11 sports" is not a list');
    assert.strictEqual(v('location'), '1310 Bryant St, Palo Alto, CA 94301');
    assert.strictEqual(v('timeline'), 'Application deadline: Jan. 9');
    assert.strictEqual(v('demographics'), 'Students of Color: 53%');
    for (const x of Object.values(f)) assert.ok(x.status === 'found' && x.snippet && x.sources[0].url && x.confidence === 'medium', JSON.stringify(x));
    assert.match(f.ratio.snippet, /Student-Teacher Ratio: 7:1/);
  });

  await check('a page with another layout (Niche): definition lists, tables, label/value elements and plain lines all work', async () => {
    const html = nichePage().toString('utf8');
    const rec = { url: 'x', finalUrl: 'https://www.niche.com/k12/d/example-hill-school-palo-alto-ca/', ok: true, kind: 'html', ...parseHtml(html, 'https://x/'), _html: html };
    const f = readSavedPage(rec, 'niche', school, NOW).fields;
    assert.strictEqual(f.ratio.value, '8:1', '"8 to 1" is written as 8:1');
    assert.strictEqual(f.enrollment.value, '1,240');
    assert.strictEqual(f.grades.value, 'K–5');
    assert.strictEqual(f.tuition.value, '$52,000');
    assert.strictEqual(f.classSize.value, '14');
    assert.strictEqual(f.testScores.value, 'Average SAT score: 1450');
  });

  await check('a real Niche page (checked on a saved AEON page): facts sit under headings with an explanation line before the value, the content area is marked as navigation, and Niche uses its own words', async () => {
    const expl = (t) => `<p>${t} Please contact the school for more details.</p>`;
    const niche = `<!doctype html><html><head><meta charset="utf-8"><title>Aeon School - Niche</title><link rel="canonical" href="https://www.niche.com/k12/aeon-school-new-york-ny/">
<script type="application/ld+json">{"@type":"Organization","name":"Niche","address":{"@type":"PostalAddress","streetAddress":"116 15th St, Suite 302","addressLocality":"Pittsburgh","addressRegion":"PA","postalCode":"15222"}}</script>
<script type="application/ld+json">{"@type":"School","name":"Aeon School"}</script></head><body>
<header><nav class="menu"><ul><li>Tuition</li><li>Students</li><li>Best Private Schools</li></ul></nav></header>
<main><h1>Aeon School</h1><ul><li>grade A+</li><li>5-12</li><li>New York, NY</li><li>Rating 4.75 out of 5</li></ul></main>
<nav class="page-sections"><ul><li>Applying</li><li>Tuition</li><li>Students</li><li>Teachers</li></ul>
<h2>About</h2><p>aeonschool.org</p><p>(516) 518-8782</p><p>447 BROADWAY NEW YORK, NY 10013</p>
<h3>About Aeon School...</h3><ul><li>High School</li><li>Middle School</li><li>NAIS Member</li><li>Online School</li><li>Private</li><li>New York</li></ul>
<h2>Applying</h2><p>Application Deadline</p>${expl('Deadline for application submissions.')}<p>Rolling Admissions</p><p>Application Fee</p><p>$50</p>
<p>Interview Required</p>${expl('Interview requirements for admission to the school.')}<p>Yes</p>
<h3>Required/Recommended Tests</h3>${expl('Tests that are either required or recommended for admission to the school.')}<p>None</p>
<h2>Tuition</h2><h3>Yearly Tuition</h3><p>$39,500</p><p>Tuition is for the highest grade offered and may have changed for the current school year.</p><p>Received Financial Aid</p><p>40%</p><p>Average Financial Aid</p><p>$18,262</p>
<h2>From Aeon School</h2><p>AEON School is an online independent school that is rethinking education for a connected world, with live classes and a project-based curriculum.</p>
<h2>Academics</h2><h3>Average Graduation Rate</h3><p>100%</p>
<h3>Average SAT</h3><p>Average SAT composite score out of 1600, as reported by Niche users from this school.</p><p>1390</p><p>12 responses</p>
<h3>Average ACT</h3><p>Average ACT composite score out of 36, as reported by Niche users from this school.</p><p>31</p><p>6 responses</p>
<h3>Academics at AEON</h3><p>The foundation of an AEON School education is Great Works, our core curriculum integrating English, social studies and science.</p>
<h2>Students</h2><p>Diversity</p><p>grade A+</p><p>Based on racial and economic diversity and survey responses on school culture from students and parents.</p><h3>Students</h3><p>176</p>
<h2>Teachers</h2><h3>Student-Teacher Ratio</h3><p>Student-Teacher Ratio may not be indicative of class size. It is calculated using the reported number of students and full-time equivalent teachers.</p><p>10:1</p><p>National 16:1</p>
</nav></body></html>`;
    const rec = (url) => ({ url, finalUrl: url, ok: true, kind: 'html', ...parseHtml(niche, url), _html: niche });
    const aeon = { id: 'aeon', name: 'AEON School (formerly Avenues Silicon Valley)', division: null, website: 'https://aeonschool.org/' };
    const f = readSavedPage(rec('https://www.niche.com/k12/aeon-school-new-york-ny/'), 'niche', aeon, NOW).fields;
    const v = (k) => f[k] && f[k].value;
    assert.strictEqual(v('location'), '447 Broadway, New York, NY 10013', 'the school’s address, never Niche’s own office in the page’s structured data');
    assert.strictEqual(v('grades'), '5–12');
    assert.strictEqual(v('schoolType'), 'Private | Online');
    assert.strictEqual(v('partners'), 'NAIS');
    assert.strictEqual(v('enrollment'), '176', '“Students” after a heading is the headcount, not the menu entry or the diversity section');
    assert.strictEqual(v('ratio'), '10:1', 'the explanation line is skipped and “National 16:1” is not the answer');
    assert.strictEqual(v('tuition'), '$39,500');
    assert.match(f.tuition.note, /highest grade offered/); assert.match(f.tuition.note, /40% of students receive it, average \$18,262/);
    assert.strictEqual(v('testScores'), 'Average SAT score: 1390\nAverage ACT score: 31');
    assert.match(f.testScores.note, /reported by Niche users[^.]*SAT from 12 responses, ACT from 6 responses/);
    assert.strictEqual(v('timeline'), 'Application deadline: Rolling Admissions', 'the line explaining the deadline is not the deadline');
    assert.strictEqual(v('interviews'), 'Interview Required: Yes');
    assert.strictEqual(v('testingPolicy'), 'Required/Recommended Tests: None');
    assert.strictEqual(v('application'), 'Application Fee: $50');
    assert.match(v('about'), /^AEON School is an online independent school/); assert.match(f.about.note, /school’s own description, as shown on Niche/);
    assert.match(v('academics'), /^The foundation of an AEON School education/);
    assert.strictEqual(f.classSize, undefined, 'nothing is invented for what the page does not say');
    // a page about the whole school is not about one division of it
    const upper = { ...aeon, division: 'upper' };
    const g = readSavedPage(rec('https://www.niche.com/k12/aeon-school-new-york-ny/'), 'niche', upper, NOW).fields;
    assert.match(g.enrollment.note, /covers grades 5–12, wider than the upper school alone/);
    assert.strictEqual(f.enrollment.note, undefined, 'a whole-school record needs no such warning');
  });

  await check('a saved page is refused when it is a security-check page, empty, a web archive, from another site, or about another school', async () => {
    const denied = Buffer.from('<!DOCTYPE html><html><head><title>Access to this page has been denied</title></head><body><p>Press and hold to confirm you are a human</p></body></html>');
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'niche.html', bytes: denied }), /security check or “access denied”/);
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'tiny.html', bytes: Buffer.from('<html><head><title>Example Hill School | Niche</title><link rel="canonical" href="https://www.niche.com/x"></head><body><p>Short.</p></body></html>') }), /almost no text/);
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'a.mhtml', bytes: Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related') }), /web archive/);
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'a.docx', bytes: Buffer.from('PK\u0003\u0004 not a page') }), /\.html or \.htm, or PDF/);
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'e.html', bytes: Buffer.alloc(0) }), /empty/);
    await assert.rejects(sources.addFile({ school, source: 'nope', name: 'a.html', bytes: nichePage() }), /Unknown source/);
    // a Private School Review page added as a Niche page
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'psr.html', bytes: psrPage() }), /is from privateschoolreview\.com, not Niche/);
    // a typed address on the wrong site
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'n.html', url: 'https://www.example.com/x', bytes: nichePage() }), /not on Niche/);
    // a page with no sign of the site it should be from
    await assert.rejects(sources.addFile({ school, source: 'niche', name: 'plain.html', bytes: bytes('Example Hill School', '', '<p>Hello.</p>') }), /does not look like a Niche page/);
    // another school's page
    const other = { ...school, id: 'other-school', name: 'Westbrook Academy of Arts' };
    await assert.rejects(sources.addFile({ school: other, source: 'niche', name: 'n.html', bytes: nichePage() }), /does not look like Westbrook Academy of Arts/);
    assert.deepStrictEqual(sources.list(school, 'niche').pages, [], 'nothing is kept when a file is refused');
  });

  await check('Ravenna pages are accepted without a trace of the site, with a warning; the same page twice is refused', async () => {
    const page = bytes('Example Hill School Application', '', '<h2>Application deadline</h2><p>Applications are due January 10, 2027.</p>');
    const e = await sources.addFile({ school, source: 'ravenna', name: 'ravenna application.html', bytes: page });
    assert.match(e.warning, /Nothing on this page says it comes from Ravenna/);
    await assert.rejects(sources.addFile({ school, source: 'ravenna', name: 'again.html', bytes: page }), /already saved/);
    const fromRavenna = await sources.addFile({ school, source: 'ravenna', name: 'r2.html', url: 'https://www.ravenna-hub.com/schools/209506', bytes: bytes('Example Hill School — Apply', '', '<p>Enter the application.</p>') });
    assert.strictEqual(fromRavenna.url, 'https://www.ravenna-hub.com/schools/209506');
    assert.strictEqual(fromRavenna.warning, undefined);
    assert.strictEqual(sources.list(school, 'ravenna').pages.length, 2);
    for (const p of sources.list(school, 'ravenna').pages) sources.remove(school, 'ravenna', p.id);
    assert.deepStrictEqual(sources.list(school, 'ravenna').pages, []);
  });

  await check('the school’s website comes first, then Niche, then Private School Review: a later source only fills what is still empty', async () => {
    const file = path.join(PATHS.resultsDir, school.id + '.json');
    const site = (value) => ({ status: 'found', value, confidence: 'high', sources: [{ url: 'https://www.examplehill.org/admissions', title: 'Admissions' }], snippet: 'x' });
    const websiteFields = { tuition: site('$50,000'), grades: { status: 'none' }, ratio: { status: 'none' }, classSize: { status: 'none' }, enrollment: { status: 'none' }, notes: { status: 'manual', note: 'x' } };
    writeJson(file, { id: school.id, name: school.name, status: 'ok', scrapedAt: '2026-11-01T00:00:00Z', start: school.website, counts: { found: 1, none: 4, manual: 1 }, pages: [{ url: 'https://www.examplehill.org/admissions', title: 'Admissions', topics: ['admissions'] }], fields: websiteFields });

    await sources.addFile({ school, source: 'psr', name: 'psr.html', bytes: psrPage() });
    await sources.reapply(school, NOW);
    let r = readJson(file);
    assert.strictEqual(r.fields.tuition.value, '$50,000', 'the website’s tuition is kept, not the review site’s $59,600');
    assert.strictEqual(r.fields.tuition.source, undefined);
    assert.strictEqual(r.fields.ratio.value, '7:1');
    assert.strictEqual(r.fields.ratio.source.key, 'psr');
    assert.match(r.fields.ratio.note, /From Private School Review, a page saved by hand\. The school’s website did not give this answer\./);

    await sources.addFile({ school, source: 'niche', name: 'niche.html', bytes: nichePage() });
    await sources.reapply(school, NOW);
    r = readJson(file);
    assert.strictEqual(r.fields.ratio.value, '8:1', 'Niche comes before Private School Review');
    assert.strictEqual(r.fields.ratio.source.key, 'niche');
    assert.strictEqual(r.fields.grades.value, 'K–5', 'Niche answers grades before Private School Review');
    assert.strictEqual(r.fields.classSize.value, '14');
    assert.strictEqual(r.fields.sports.value, 'Basketball, Cross Country, Golf, Water Polo', 'what only the later source knows is still used');
    assert.strictEqual(r.fields.sports.source.key, 'psr');
    assert.strictEqual(r.fields.notes.status, 'manual', 'a "fill in by hand" row is never filled');
    assert.deepStrictEqual(Object.keys(r.websiteFields).sort(), Object.keys(websiteFields).sort(), 'the website-only answers are kept to undo from');
    assert.strictEqual(r.websiteFields.ratio.status, 'none');
    assert.strictEqual(r.status, 'ok');
    assert.ok(r.counts.found > 1 && r.counts.found === Object.values(r.fields).filter((x) => x.status === 'found').length);
    assert.ok(r.pages.some((p) => p.fromSource === 'niche') && r.pages.some((p) => p.url === 'https://www.examplehill.org/admissions'));
    assert.deepStrictEqual(Object.keys(r.otherSources).sort(), ['niche', 'psr']);
    assert.ok(r.otherSources.niche.filled.includes('ratio'));

    // running it again changes nothing (safe after every scrape)
    const before = JSON.stringify(readJson(file).fields);
    await sources.reapply(school, NOW);
    assert.strictEqual(JSON.stringify(readJson(file).fields), before);

    // taking Niche's page away takes its answers with it; Private School Review fills in again
    sources.remove(school, 'niche', sources.list(school, 'niche').pages[0].id);
    await sources.reapply(school, NOW);
    r = readJson(file);
    assert.strictEqual(r.fields.ratio.value, '7:1');
    assert.strictEqual(r.fields.ratio.source.key, 'psr');

    // a new scrape writes the website's answers fresh; the saved pages are put back on top of them
    writeJson(file, { id: school.id, name: school.name, status: 'ok', scrapedAt: '2026-11-18T00:00:00Z', start: school.website, counts: { found: 1, none: 4, manual: 1 }, pages: [], fields: { ...websiteFields, tuition: site('$51,000') } });
    await sources.reapply(school, NOW);
    r = readJson(file);
    assert.strictEqual(r.fields.tuition.value, '$51,000');
    assert.strictEqual(r.fields.ratio.value, '7:1');

    // with nothing left saved, the school is exactly as the website alone left it
    sources.remove(school, 'psr', sources.list(school, 'psr').pages[0].id);
    await sources.reapply(school, NOW);
    r = readJson(file);
    assert.deepStrictEqual(Object.keys(r).filter((k) => ['websiteFields', 'websiteStatus', 'otherSources'].includes(k)), []);
    assert.strictEqual(r.fields.ratio.status, 'none');
    assert.strictEqual(r.fields.tuition.value, '$51,000');
    assert.ok(!r.pages.some((p) => p.fromSource));
  });

  await check('a school whose website cannot be read still gets its answers from saved pages, and goes back to “blocked” when they are removed', async () => {
    const blocked = { ...school, id: 'blocked-school', name: 'Blocked Hill School' };
    const file = path.join(PATHS.resultsDir, blocked.id + '.json');
    writeJson(file, { id: blocked.id, name: blocked.name, status: 'blocked', detail: 'site refused automated access (HTTP 403)', pages: [], fields: {} });
    const e = await sources.addFile({ school: blocked, source: 'psr', name: 'p.html', bytes: bytes('Blocked Hill School - Palo Alto, CA', psrHead, psrBody) });
    assert.ok(e.id);
    await sources.reapply(blocked, NOW);
    let r = readJson(file);
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.source, 'other-sources');
    assert.strictEqual(r.websiteStatus.status, 'blocked');
    assert.strictEqual(r.fields.ratio.value, '7:1');
    assert.strictEqual(r.fields.tuition.value, '$59,600');
    sources.remove(blocked, 'psr', e.id);
    await sources.reapply(blocked, NOW);
    r = readJson(file);
    assert.strictEqual(r.status, 'blocked');
    assert.strictEqual(r.source, undefined);
    assert.deepStrictEqual(r.fields, {});

    // a school that was never scraped: the saved pages create its result, and removing them removes it again
    const fresh = { ...school, id: 'fresh-school', name: 'Fresh Hill School', website: null };
    const f2 = path.join(PATHS.resultsDir, fresh.id + '.json');
    const e2 = await sources.addFile({ school: fresh, source: 'psr', name: 'p.html', bytes: bytes('Fresh Hill School - Palo Alto, CA', psrHead, psrBody) });
    await sources.reapply(fresh, NOW);
    assert.strictEqual(readJson(f2).status, 'ok');
    assert.strictEqual(readJson(f2).fields.ratio.value, '7:1');
    sources.remove(fresh, 'psr', e2.id);
    await sources.reapply(fresh, NOW);
    assert.ok(!fs.existsSync(f2), 'a result that only existed because of saved pages goes away with them');
  });

  await check('the overview lists what is saved for each school and source', async () => {
    await sources.addFile({ school, source: 'niche', name: 'niche.html', bytes: nichePage() });
    await sources.reapply(school, NOW);
    const o = sources.overview();
    assert.strictEqual(o[school.id].niche.pages, 1);
    assert.ok(o[school.id].niche.filled >= 1 && o[school.id].niche.facts >= 4);
    assert.strictEqual(o[school.id].ravenna, undefined);
  });

  await check('a batch of saved pages is matched to schools by the page’s own name; unclear ones are left for a person', async () => {
    const schools = [
      { id: 'example-hill-school', name: 'Example Hill School' },
      { id: 'marlborough-upper', name: 'Marlborough (Upper) School', division: 'upper' },
      { id: 'marlborough-middle', name: 'Marlborough (Middle) School', division: 'middle' },
      { id: 'st-pauls', name: 'St. Paul’s School' },
    ];
    assert.strictEqual(sources.matchSchool({ name: 'x.html', bytes: nichePage() }, schools).school.id, 'example-hill-school');
    const marl = (t) => bytes(t, '', '<p>Marlborough is a girls school in Los Angeles.</p>');
    assert.strictEqual(sources.matchSchool({ name: 'm.html', bytes: marl('Marlborough Upper School Reviews | Niche') }, schools).school.id, 'marlborough-upper');
    const amb = sources.matchSchool({ name: 'm.html', bytes: marl('Marlborough School | Niche') }, schools);
    assert.ok(!amb.school && amb.candidates.length === 2, 'two divisions fit: a person chooses');
    assert.deepStrictEqual(sources.matchSchool({ name: 'z.html', bytes: bytes('Totally Different Place | Niche') }, schools).candidates, []);
    assert.strictEqual(sources.matchSchool({ name: 'St Pauls Niche.html', bytes: bytes('Niche', '', '<p>Reviews.</p>') }, schools).school.id, 'st-pauls', 'the file name can say it');
    // the city in a title must not pull in schools whose names share the city's words
    const sf = [...schools, { id: 'sf-day', name: 'San Francisco Day School' }, { id: 'bay-sf', name: 'The Bay School of San Francisco' }, { id: 'westbrook', name: 'Westbrook Academy (Upper) School', division: 'upper' }];
    assert.strictEqual(sources.matchSchool({ name: 'w.html', bytes: bytes('Westbrook Academy (Top Ranked Private School) - San Francisco, CA', '', '<p>Westbrook.</p>') }, sf).school.id, 'westbrook');
    assert.strictEqual(sources.matchSchool({ name: 'w.html', bytes: bytes('Westbrook Academy Reviews, Rankings | Niche San Francisco, CA', '', '<p>Westbrook.</p>') }, sf).school.id, 'westbrook');
    assert.strictEqual(sources.matchSchool({ name: 'd.html', bytes: bytes('San Francisco Day School (Top Ranked) - San Francisco, CA', '', '<p>Day.</p>') }, sf).school.id, 'sf-day');
    assert.strictEqual(sources.matchSchool({ name: 'b.html', bytes: bytes('The Bay School of San Francisco - San Francisco, CA', '', '<p>Bay.</p>') }, sf).school.id, 'bay-sf', 'the longer, more specific name wins');
    // a short name word must not be found inside another word of the page title ("king" in "Rankings"), whether in the title or the file name
    const king = [...sf, { id: 'kings', name: 'The King’s Academy (Middle) School', division: 'middle' }];
    assert.strictEqual(sources.matchSchool({ name: 'Westbrook Academy Reviews, Rankings | Niche.html', bytes: bytes('Westbrook Academy Reviews, Rankings | Niche', '', '<p>Westbrook.</p>') }, king).school.id, 'westbrook');
    assert.deepStrictEqual(sources.matchSchool({ name: 'Rankings | Niche.html', bytes: bytes('Top Rankings | Niche', '', '<p>Lists.</p>') }, king).candidates, [], 'a page about nothing is not matched to King’s Academy');
  });

  await check('adding a school by hand: checked, saved to the list at once, kept when the whole sheet is loaded later, removable', async () => {
    writeJson(PATHS.schools, { importedAt: '2026-11-01', workbook: 'x.xlsx', schools: [{ id: 'old-school', name: 'Old School', tier: 1, website: 'https://old.example.edu/', tabs: [] }] });
    assert.throws(() => schoolList.addSchool({ name: 'ab' }), /at least 3 letters/);
    assert.throws(() => schoolList.addSchool({ name: 'Old School' }), /already in the list/);
    assert.throws(() => schoolList.addSchool({ name: 'New Hill School', tier: 7 }), /Tier must be 1, 2 or 3/);
    assert.throws(() => schoolList.addSchool({ name: 'New Hill School', website: 'not a site' }), /website address does not look right/);
    const s = schoolList.addSchool({ name: '  New Hill  (Upper) School ', website: 'newhill.org', tier: '2', region: 'Oakland, CA', portal: 'https://www.ravenna-hub.com/schools/123' });
    assert.deepStrictEqual([s.id, s.name, s.website, s.tier, s.division, s.portalLabel, s.addedByHand], ['new-hill-upper-school', 'New Hill (Upper) School', 'https://newhill.org/', 2, 'upper', 'Ravenna', true]);
    assert.strictEqual(readJson(PATHS.schools).schools.length, 2, 'the school is on the list straight away');
    assert.throws(() => schoolList.addSchool({ name: 'new hill (upper) school' }), /already in the list/);
    const bare = schoolList.addSchool({ name: 'Bare Name School' });
    assert.deepStrictEqual([bare.website, bare.tier, bare.portal], [null, null, null], 'only the name is needed');

    // loading the whole sheet again: the sheet's schools, plus the ones added by hand that it does not list
    const sheet = [{ id: 'old-school', name: 'Old School' }, { id: 'bare-name-school', name: 'Bare Name School' }];
    const merged = schoolList.mergeAdded(sheet);
    assert.deepStrictEqual(merged.schools.map((x) => x.id), ['old-school', 'bare-name-school', 'new-hill-upper-school'], 'the sheet now lists Bare Name School itself, so its row wins');
    assert.strictEqual(merged.kept, 1);
    assert.deepStrictEqual(schoolList.loadAdded().map((x) => x.id), ['new-hill-upper-school'], 'a school the sheet lists is no longer kept separately');

    assert.throws(() => schoolList.removeSchool('old-school'), /Only schools added by hand/);
    assert.throws(() => schoolList.removeSchool('nobody'), /not found/);
    fs.writeFileSync(path.join(PATHS.resultsDir, 'new-hill-upper-school.json'), '{}');
    schoolList.removeSchool('new-hill-upper-school');
    assert.deepStrictEqual(readJson(PATHS.schools).schools.map((x) => x.id), ['old-school', 'bare-name-school']);
    assert.ok(!fs.existsSync(path.join(PATHS.resultsDir, 'new-hill-upper-school.json')));
    assert.deepStrictEqual(schoolList.loadAdded(), []);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
