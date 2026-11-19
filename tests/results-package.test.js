'use strict';
// Checks sharing results between computers: the file round trip, "newer wins", and that a bad or hostile file cannot do harm.
//   node tests/results-package.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const JSZip = require('jszip');
const ROOT = path.join(__dirname, '..');
const { buildPackage, importPackage, ShareError } = require('../src/lib/results-package');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };
const mk = (dir, id, extra = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const r = { id, name: 'School ' + id, scrapedAt: '2026-11-10T10:00:00.000Z', status: 'ok', pages: [], fields: { tuition: { status: 'found', value: '$1' } }, ...extra };
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(r)); return r;
};
const read = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
const zipOf = async (entries, manifest = { kind: 'school-info-results', format: 1, by: 'pat@example.edu' }) => {
  const z = new JSZip();
  if (manifest) z.file('manifest.json', JSON.stringify(manifest));
  for (const [n, v] of Object.entries(entries)) z.file(n, typeof v === 'string' ? v : JSON.stringify(v));
  return z.generateAsync({ type: 'nodebuffer' });
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-test-'));
  const A = path.join(tmp, 'a'), B = path.join(tmp, 'b');
  const known = new Set(['alpha', 'beta', 'gamma', 'delta']);

  // round trip
  mk(A, 'alpha'); mk(A, 'beta'); mk(A, 'gamma', { status: 'blocked', detail: 'site refused', fields: {}, pages: [] });
  fs.writeFileSync(path.join(A, 'notes.txt'), 'not a result'); fs.writeFileSync(path.join(A, 'Bad Name.json'), '{}');
  const { buffer, count } = await buildPackage({ resultsDir: A, by: 'pat@example.edu' });
  assert.strictEqual(count, 3);
  const loaded = await JSZip.loadAsync(buffer);
  const inside = Object.keys(loaded.files).filter((n) => !loaded.files[n].dir).sort();
  assert.deepStrictEqual(inside, ['manifest.json', 'results/alpha.json', 'results/beta.json', 'results/gamma.json']);
  let s = await importPackage(buffer, { resultsDir: B, knownIds: known });
  assert.strictEqual(s.added, 3); assert.strictEqual(s.from.by, 'pat@example.edu');
  assert.deepStrictEqual(read(B, 'alpha'), read(A, 'alpha'));
  ok('a results file round-trips and carries only the results (no stray files)');

  // newer wins, nothing is ever deleted
  s = await importPackage(buffer, { resultsDir: B, knownIds: known });
  assert.deepStrictEqual([s.added, s.updated, s.same, s.keptNewer], [0, 0, 3, 0]);
  mk(B, 'beta', { scrapedAt: '2026-11-12T10:00:00.000Z', fields: { tuition: { status: 'found', value: '$LOCAL-NEWER' } } });
  mk(B, 'delta');                                                      // a school only this computer has
  mk(A, 'alpha', { scrapedAt: '2026-11-11T10:00:00.000Z', fields: { tuition: { status: 'found', value: '$THEIRS-NEWER' } } });
  const pack2 = await buildPackage({ resultsDir: A });
  s = await importPackage(pack2.buffer, { resultsDir: B, knownIds: known });
  assert.strictEqual(s.updated, 1); assert.strictEqual(s.keptNewer, 1); assert.strictEqual(s.same, 1);
  assert.strictEqual(read(B, 'alpha').fields.tuition.value, '$THEIRS-NEWER');
  assert.strictEqual(read(B, 'beta').fields.tuition.value, '$LOCAL-NEWER', 'a newer local result was overwritten');
  assert.ok(fs.existsSync(path.join(B, 'delta.json')), 'a result only this computer had was deleted');
  ok('a school\'s result is only replaced by a newer one, and nothing is deleted');

  // schools that are not in this computer's list
  const C = path.join(tmp, 'c');
  s = await importPackage(buffer, { resultsDir: C, knownIds: new Set(['alpha']) });
  assert.strictEqual(s.added, 1); assert.strictEqual(s.unknown, 2); assert.ok(s.unknownNames.length === 2);
  assert.ok(!fs.existsSync(path.join(C, 'beta.json')));
  ok('results for schools that are not in the list are skipped and named');

  // files that are not what they claim
  await assert.rejects(() => importPackage(Buffer.from('not a zip'), { resultsDir: C }), ShareError);
  const noManifest = await zipOf({}, null);
  const otherKind = await zipOf({}, { kind: 'something-else', format: 1 });
  const newerFormat = await zipOf({}, { kind: 'school-info-results', format: 99 });
  const wb = new JSZip(); wb.file('xl/workbook.xml', '<x/>');
  const workbook = await wb.generateAsync({ type: 'nodebuffer' });
  await assert.rejects(() => importPackage(noManifest, { resultsDir: C }), /not a results file/);
  await assert.rejects(() => importPackage(otherKind, { resultsDir: C }), /not a results file/);
  await assert.rejects(() => importPackage(newerFormat, { resultsDir: C }), /newer version/);
  await assert.rejects(() => importPackage(workbook, { resultsDir: C }), ShareError);
  ok('a non-zip, a zip without the right manifest, a workbook or a newer format is refused with a clear message');

  // hostile or damaged entries
  const D = path.join(tmp, 'd');
  const good = { id: 'alpha', name: 'A', scrapedAt: '2026-11-10T10:00:00.000Z', status: 'ok', pages: [], fields: {} };
  const evil = await zipOf({
    'results/alpha.json': good,
    'results/../../evil.json': good, 'results/../evil.json': good, '../evil.json': good, 'results/Evil Name.json': good,
    'results/sub/dir.json': good, 'results/beta.json': '{ this is not json',
    'results/gamma.json': { ...good, id: 'someone-else' },                    // id does not match the file name
    'results/delta.json': { ...good, id: 'delta', status: 'weird' },          // unknown status
    'results/epsilon.json': { ...good, id: 'epsilon', scrapedAt: 'yesterday' },
    'results/zeta.json': { ...good, id: 'zeta', fields: { tuition: 'not an object' } },
    'other/stuff.txt': 'ignored',
  });
  s = await importPackage(evil, { resultsDir: D, knownIds: new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) });
  assert.strictEqual(s.added, 1, JSON.stringify(s)); assert.strictEqual(s.invalid, 5, JSON.stringify(s));
  assert.deepStrictEqual(fs.readdirSync(D), ['alpha.json']);
  for (const p of [path.join(tmp, 'evil.json'), path.join(tmp, '..', 'evil.json'), path.join(D, '..', 'evil.json')]) assert.ok(!fs.existsSync(p), 'a file was written outside the results folder: ' + p);
  const big = await zipOf({ 'results/alpha.json': { ...good, junk: 'x'.repeat(5 * 1024 * 1024) } });
  s = await importPackage(big, { resultsDir: path.join(tmp, 'e'), knownIds: known });
  assert.strictEqual(s.invalid, 1); assert.strictEqual(s.added, 0);
  ok('path tricks, broken JSON, mismatched ids, odd values and oversized entries are skipped; nothing is written outside the results folder');

  // through the dashboard, between two copies of the program
  const mkData = (dir) => { fs.mkdirSync(path.join(dir, 'results'), { recursive: true }); for (const f of ['schools.json', 'template.json']) fs.copyFileSync(path.join(ROOT, 'data', f), path.join(dir, f)); };
  const dataA = path.join(tmp, 'dash-a'), dataB = path.join(tmp, 'dash-b');
  mkData(dataA); mkData(dataB);
  // the first four saved results that were read fine (a school whose latest check was blocked would not count as "ok" below)
  const isOk = (f) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'results', f), 'utf8')).status === 'ok'; } catch { return false; } };
  const real = fs.readdirSync(path.join(ROOT, 'data', 'results')).filter(isOk).slice(0, 4);
  for (const f of real) fs.copyFileSync(path.join(ROOT, 'data', 'results', f), path.join(dataA, 'results', f));
  const startServer = (port, dir) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--no-browser'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dir } });
    let out = ''; c.stdout.on('data', (d) => { out += d; if (/dashboard:/.test(out)) resolve(c); }); c.stderr.on('data', (d) => (out += d));
    c.on('exit', () => reject(new Error('server exited: ' + out))); setTimeout(() => reject(new Error('no start: ' + out)), 8000);
  });
  const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { const chunks = []; res.on('data', (d) => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
  const sa = await startServer(4501, dataA), sb = await startServer(4502, dataB);
  try {
    let r = await call(4501, 'GET', '/api/results-package');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-type'], 'application/zip');
    assert.ok(/attachment; filename="school-results-\d{4}-\d\d-\d\d\.zip"/.test(r.headers['content-disposition']));
    const file = r.body;
    r = await call(4502, 'GET', '/api/results-package'); assert.strictEqual(r.status, 404);
    r = await call(4502, 'POST', '/api/results-package', { headers: { 'content-type': 'application/octet-stream' }, body: file }); assert.strictEqual(r.status, 403, 'needs the dashboard header');
    r = await call(4502, 'POST', '/api/results-package', { headers: { 'content-type': 'application/octet-stream', 'x-dashboard': '1' }, body: file });
    const j = JSON.parse(r.body.toString()); assert.strictEqual(r.status, 200, r.body.toString()); assert.strictEqual(j.added, real.length);
    const ov = JSON.parse((await call(4502, 'GET', '/api/overview')).body.toString());
    assert.strictEqual(ov.schools.filter((x) => x.status === 'ok').length, real.length);
    r = await call(4502, 'POST', '/api/results-package', { headers: { 'content-type': 'application/octet-stream', 'x-dashboard': '1' }, body: Buffer.from('nonsense') });
    assert.strictEqual(r.status, 422);
    ok('between two copies of the program: save, add, and the teammate\'s dashboard shows the schools; nonsense is refused');
  } finally { sa.kill(); sb.kill(); }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', (e.stack || '').split('\n').slice(1, 5).join('\n')); process.exit(1); });
