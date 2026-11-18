'use strict';
// Pages a person saves by hand for a website that refuses automatic reading (for example Harvard-Westlake's
// Cloudflare "Just a moment..." check). Nothing here contacts a website: it only reads files.
//   node tests/manual-pages.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-pages-'));
process.env.DATA_DIR = tmp;                       // set before the modules read their folders
const manual = require('../src/lib/manual-pages');
const { PATHS, readJson } = require('../src/lib/util');
fs.mkdirSync(PATHS.resultsDir, { recursive: true });

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('  ok   ' + name); };
const NOW = new Date('2026-11-17T12:00:00Z');

const mid = { id: 'hw-middle', name: 'Harvard-Westlake (Middle) School', division: 'middle', region: 'Los Angeles, CA', tier: 1, website: 'https://www.hw.com/' };
const up = { id: 'hw-upper', name: 'Harvard-Westlake (Upper) School', division: 'upper', region: 'Los Angeles, CA', tier: 1, website: 'https://www.hw.com/' };
const other = { id: 'other', name: 'Other School', division: null, region: '', tier: 2, website: 'https://www.other.edu/' };
const schools = [mid, up, other];

const filler = 'Harvard-Westlake is an independent coeducational day school in Los Angeles. '.repeat(6);
const page = (title, body, head) => Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head || ''}</head><body><main><h1>${title}</h1>${body}</main></body></html>`);
const tuitionPage = (head) => page('Tuition and Financial Aid | Harvard-Westlake', `<p>${filler}</p><p>Tuition for the 2026-2027 school year is $54,100 for Grades 7-12.</p><p>The student-teacher ratio is 8:1 and the average class size is 15 students.</p>`, head);
const challenge = Buffer.from('<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body><p>Enable JavaScript and cookies to continue</p><script>window._cf_chl_opt={}</script></body></html>');
(async () => {
  await check('a security-check page, an empty page, a web archive and a wrong kind of file are refused with a plain explanation', async () => {
    await assert.rejects(manual.addFile({ school: mid, name: 'hw.html', bytes: challenge }), /security check page/);
    await assert.rejects(manual.addFile({ school: mid, name: 'tiny.html', bytes: page('Hi', '<p>Short.</p>') }), /almost no text/);
    await assert.rejects(manual.addFile({ school: mid, name: 'x.mhtml', bytes: Buffer.from('MIME-Version: 1.0\r\nContent-Type: multipart/related') }), /web archive/);
    await assert.rejects(manual.addFile({ school: mid, name: 'notes.docx', bytes: Buffer.from('PK\u0003\u0004 not a page') }), /\.html or \.htm, or PDF/);
    await assert.rejects(manual.addFile({ school: mid, name: 'empty.html', bytes: Buffer.alloc(0) }), /empty/);
    await assert.rejects(manual.addFile({ school: { ...mid, website: '' }, name: 'a.html', bytes: tuitionPage() }), /no website link/);
    assert.deepStrictEqual(manual.list(mid).pages, [], 'nothing is kept when a file is refused');
  });

  await check('the page address comes from what the person typed, else the file itself, else the file name; another website is refused', async () => {
    const fromFile = await manual.addFile({ school: mid, name: 'Tuition and Aid.html', bytes: tuitionPage('<link rel="canonical" href="https://www.hw.com/admissions/tuition-and-financial-aid?utm_source=x">') });
    assert.strictEqual(fromFile.url, 'https://www.hw.com/admissions/tuition-and-financial-aid');
    assert.strictEqual(fromFile.urlFrom, 'page');
    const typed = await manual.addFile({ school: mid, name: 'facts.html', url: 'https://www.hw.com/about/facts-and-figures', bytes: page('Facts and Figures', `<p>${filler}</p><p>Total enrollment is 1,640 students.</p>`) });
    assert.deepStrictEqual([typed.url, typed.urlFrom], ['https://www.hw.com/about/facts-and-figures', 'typed']);
    const named = await manual.addFile({ school: mid, name: 'Admission Dates.html', bytes: page('Admission Dates', `<p>${filler}</p><p>The application opens on September 1, 2026 and closes on January 10, 2027.</p>`) });
    assert.deepStrictEqual([named.url, named.urlFrom], ['https://www.hw.com/admission-dates', 'name']);
    await assert.rejects(manual.addFile({ school: mid, name: 'y.html', url: 'https://evil.example.com/tuition', bytes: tuitionPage() }), /not on this school.s website/);
    await assert.rejects(manual.addFile({ school: mid, name: 'dup.html', url: 'https://www.hw.com/about/facts-and-figures', bytes: tuitionPage() }), /already saved/);
    assert.strictEqual(manual.list(mid).pages.length, 3);
    assert.strictEqual(manual.list(up).pages.length, 3, 'the middle and upper divisions share one set of saved pages');
    assert.deepStrictEqual(manual.list(other).pages, [], 'another school does not see them');
  });

  await check('reading the saved pages writes a normal result for every division that shares the website, and nothing for other schools', async () => {
    fs.writeFileSync(path.join(PATHS.resultsDir, 'hw-middle.json'), JSON.stringify({ id: 'hw-middle', name: mid.name, status: 'blocked', detail: 'site refused automated access (HTTP 403)', fields: {} }));
    const out = await manual.build({ school: mid, schools, now: NOW });
    assert.strictEqual(out.pages, 3);
    assert.deepStrictEqual(out.schools.map((s) => s.id).sort(), ['hw-middle', 'hw-upper']);
    const r = readJson(path.join(PATHS.resultsDir, 'hw-middle.json'));
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.source, 'saved-pages');
    assert.strictEqual(r.savedPages.count, 3);
    assert.ok(r.fields.tuition && r.fields.tuition.status === 'found' && /54,100/.test(r.fields.tuition.value), 'tuition is read from the saved tuition page: ' + JSON.stringify(r.fields.tuition));
    assert.ok(r.pages.length === 3 && r.pages.every((p) => /^https:\/\/www\.hw\.com\//.test(p.url)), 'the saved pages are listed with their web addresses');
    assert.ok(r.counts.found >= 2, 'several answers are found');
    assert.ok(readJson(path.join(PATHS.resultsDir, 'hw-upper.json')).status === 'ok');
    assert.ok(!fs.existsSync(path.join(PATHS.resultsDir, 'other.json')), 'a school on another website is untouched');
  });

  await check('a PDF is saved, named and read like a web page (the PDF reader is stood in for), and a damaged PDF is refused by the real reader', async () => {
    const broken = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
    await assert.rejects(manual.addFile({ school: mid, name: 'broken.pdf', bytes: broken }), /could not be read|almost no text/, 'a damaged PDF is refused, not saved');
    assert.strictEqual(manual.list(mid).pages.length, 3);
    // The real PDF reader is already used by every normal check. Here it is replaced by one that returns known text, so this
    // test covers the saving, naming and reading of a PDF without needing a real PDF file.
    const readerPath = require.resolve('pdf-parse/lib/pdf-parse.js');
    const realReader = require.cache[readerPath];
    const text = 'Harvard-Westlake Fast Facts 2026-2027\n\nHarvard-Westlake is an independent coeducational day school in Los Angeles, California.\n\nTotal enrollment is 1,640 students in Grades 7-12. The student-teacher ratio is 8:1.\n\nThe average class size is 15 students. Tuition for the 2026-2027 school year is $54,100.\n';
    require.cache[readerPath] = { id: readerPath, filename: readerPath, loaded: true, exports: async () => ({ text, info: { Title: 'Fast Facts' } }) };
    let added;
    try { added = await manual.addFile({ school: mid, name: 'Fast Facts.pdf', bytes: Buffer.from('%PDF-1.4 stand-in file') }); } finally { /* kept until the result is built below */ }
    assert.deepStrictEqual([added.kind, added.urlFrom, added.url], ['pdf', 'name', 'https://www.hw.com/fast-facts']);
    const out = await manual.build({ school: mid, schools, now: NOW });
    assert.strictEqual(out.pages, 4, 'the PDF joins the three web pages');
    const r = readJson(path.join(PATHS.resultsDir, 'hw-middle.json'));
    assert.ok(r.pages.some((p) => p.kind === 'pdf' && p.topics.includes('pdf')), 'the PDF is listed as a PDF page');
    manual.remove(mid, added.id);
    if (realReader) require.cache[readerPath] = realReader; else delete require.cache[readerPath];
  });

  await check('a later normal check that is blocked again keeps the answers read from saved pages', async () => {
    const saved = readJson(path.join(PATHS.resultsDir, 'hw-middle.json'));
    assert.strictEqual(manual.keepSavedPages(saved, { status: 'blocked' }), true);
    assert.strictEqual(manual.keepSavedPages(saved, { status: 'error' }), true);
    assert.strictEqual(manual.keepSavedPages(saved, { status: 'ok' }), false, 'when the website lets us in, the normal result replaces the saved one');
    assert.strictEqual(manual.keepSavedPages({ status: 'blocked' }, { status: 'blocked' }), false, 'a plain blocked result is not kept as if it were answers');
    assert.strictEqual(manual.keepSavedPages(null, { status: 'blocked' }), false);
  });

  await check('removing a page deletes its file; reading with nothing saved says what to do', async () => {
    const before = manual.list(mid).pages;
    manual.remove(mid, before[0].id);
    assert.strictEqual(manual.list(mid).pages.length, 2);
    assert.strictEqual(fs.readdirSync(path.join(PATHS.data, 'manual-pages', 'hw.com')).filter((f) => /\.html$/.test(f)).length, 2);
    assert.throws(() => manual.remove(mid, 'nope'), /not found/);
    for (const e of manual.list(mid).pages) manual.remove(mid, e.id);
    await assert.rejects(manual.build({ school: mid, schools, now: NOW }), /Add at least one saved page/);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error(e); process.exit(1); });
