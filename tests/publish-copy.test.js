'use strict';
// Checks publish-copy.js end to end with a local "GitHub" (a bare git repository) and stand-in Cloudflare
// addresses: one that answers with an Access login redirect and one that does not.
//   node tests/publish-copy.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'data', 'publish.json');

const run = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [path.join(ROOT, 'deploy', 'publish-copy.js'), ...args], { cwd: ROOT });
  let out = ''; c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (out += d));
  c.on('close', (code) => resolve({ code, out }));
});
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const count = (gitDir) => Number(spawnSync('git', ['--git-dir', gitDir, 'rev-list', '--count', 'main'], { encoding: 'utf8' }).stdout.trim());
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });

let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };

(async () => {
  const hadState = fs.existsSync(STATE) ? fs.readFileSync(STATE) : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-test-'));
  const repo = path.join(tmp, 'site-repo'), bare = path.join(tmp, 'origin.git');
  const guarded = await listen((q, r) => { r.writeHead(302, { Location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' }); r.end(); });
  const open = await listen((q, r) => { r.writeHead(200); r.end('hello'); });
  const url = (s) => `http://127.0.0.1:${s.address().port}/`;
  try {
    // setup
    let r = await run(['--setup', '--repo', repo]);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(repo, '.git')) && fs.existsSync(path.join(repo, 'public', 'index.html')));
    assert.strictEqual(git(repo, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');
    assert.ok(!/G:|drodo/.test(fs.readFileSync(path.join(repo, 'README.md'), 'utf8') + fs.readFileSync(path.join(repo, 'public', 'index.html'), 'utf8')));
    ok('setup makes a repository with one placeholder commit and nothing from the data');
    r = await run(['--setup', '--repo', repo]);
    assert.strictEqual(r.code, 0); assert.ok(/already a git repository/.test(r.out));
    ok('setup run twice does nothing the second time');

    // no GitHub address yet
    r = await run(['--repo', repo, '--url', url(guarded)]);
    assert.strictEqual(r.code, 1); assert.ok(/no GitHub address yet/.test(r.out));
    ok('refuses when the repository has no remote');

    spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-u', 'origin', 'main');
    assert.strictEqual(count(bare), 1);

    // not protected: nothing is built, committed or pushed
    r = await run(['--repo', repo, '--url', url(open)]);
    assert.strictEqual(r.code, 2, r.out); assert.ok(/Not publishing/.test(r.out));
    assert.strictEqual(count(bare), 1); assert.ok(!fs.existsSync(path.join(repo, 'public', 'data')));
    ok('refuses to build or push when the address has no Access login');

    // no address given at all
    r = await run(['--repo', repo]);
    assert.strictEqual(r.code, 1); assert.ok(/Give the Cloudflare Pages address/.test(r.out));
    ok('asks for the Pages address when none is known');

    // dry run
    r = await run(['--repo', repo, '--url', url(guarded), '--dry-run']);
    assert.strictEqual(r.code, 0); assert.ok(/Login check passed/.test(r.out) && /Dry run/.test(r.out));
    assert.ok(!fs.existsSync(path.join(repo, 'public', 'data')));
    ok('dry run passes the check and changes nothing');

    // protected: build, commit, push
    r = await run(['--repo', repo, '--url', url(guarded)]);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(repo, 'public', 'data', 'overview.json')) && fs.existsSync(path.join(repo, 'public', 'index.html')));
    assert.ok(fs.existsSync(path.join(repo, '.git')), 'the build removed .git');
    assert.strictEqual(count(bare), 2, 'the push did not reach the remote');
    const files = git(repo, 'ls-files').stdout;
    assert.ok(/public\/data\/school\//.test(files) && /public\/_headers/.test(files));
    assert.ok(!/node_modules|data\/cache|results\//.test(files), 'source data was committed');
    ok('with the login in place: builds, commits and pushes only the finished pages');

    // a second publish is another snapshot
    r = await run(['--repo', repo, '--url', url(guarded)]);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(count(bare) >= 2);
    ok('publishing again works (the address is remembered if not given)');

    // no-sheet: no login check, no workbook text
    const nr = await run(['--repo', repo, '--url', url(open), '--no-sheet']);
    assert.strictEqual(nr.code, 0, nr.out); assert.ok(/Login check skipped/.test(nr.out));
    const all = git(repo, 'ls-files', 'public/data/school').stdout.trim().split('\n');
    const blob = all.slice(0, 40).map((f) => fs.readFileSync(path.join(repo, f), 'utf8')).join('');
    assert.ok(!/"sheet":\s*\[\s*\{/.test(blob), 'workbook text found in a no-sheet copy');
    ok('--no-sheet skips the login check and carries no workbook text');
  } finally {
    guarded.close(); open.close();
    if (hadState) fs.writeFileSync(STATE, hadState); else fs.rmSync(STATE, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', (e.stack || '').split('\n').slice(1, 4).join('\n')); process.exit(1); });
