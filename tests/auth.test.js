'use strict';
// Checks team sign-in end to end against a stand-in for Google, and the refusal to run open to the network.
//   node tests/auth.test.js
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const SECRET = 'test-session-secret-test-session-secret-0123456789';
process.env.SESSION_SECRET = SECRET;            // so this file can make cookies the server will accept or reject
const { sign } = require('../src/auth');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };

/** Plain http request (lets a test set the Host header). */
const request = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
    let text = ''; res.on('data', (d) => (text += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  r.on('error', reject); if (body) r.write(body); r.end();
});
const cookieOf = (res, name) => ((res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=')) || '').replace(name + '=', '');
const rawCookie = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(name + '='));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
  // a stand-in for Google's token endpoint
  let claims = {};
  let tokenCalls = [];
  const google = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
      const f = new URLSearchParams(b); tokenCalls.push(Object.fromEntries(f));
      res.setHeader('Content-Type', 'application/json');
      if (f.get('code') !== 'good-code' || f.get('client_secret') !== 'test-secret') { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_grant' })); }
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      res.end(JSON.stringify({ id_token: `x.${payload}.y` }));
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  const gPort = google.address().port;

  const start = (port, extra = {}) => new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tmp, PUBLIC_URL: `http://localhost:${port}`, GOOGLE_CLIENT_ID: 'test-client',
      GOOGLE_CLIENT_SECRET: 'test-secret', ALLOWED_EMAIL_DOMAIN: 'example.edu', SESSION_SECRET: SECRET,
      GOOGLE_AUTH_URL: `http://127.0.0.1:${gPort}/auth`, GOOGLE_TOKEN_URL: `http://127.0.0.1:${gPort}/token`, ...extra };
    const c = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--no-browser'], { cwd: ROOT, env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; if (/dashboard:/.test(out)) resolve(c); });
    c.stderr.on('data', (d) => { out += d; });
    c.on('exit', (code) => reject(new Error('server exited early: ' + out + ' code ' + code)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
  });
  const PORT = 4491;
  const server = await start(PORT);
  const validClaims = (nonce, over = {}) => ({ iss: 'https://accounts.google.com', aud: 'test-client', exp: Math.floor(Date.now() / 1000) + 600, nonce, email: 'pat@example.edu', email_verified: true, hd: 'example.edu', name: 'Pat Lee', ...over });
  /** Runs the login and callback; returns the callback response. */
  const signIn = async (over, mutate) => {
    const login = await request(PORT, 'GET', '/auth/login');
    const loc = new URL(login.headers.location);
    const oauth = cookieOf(login, 'oauth');
    claims = validClaims(loc.searchParams.get('nonce'), over);
    if (mutate) mutate(claims);
    const state = loc.searchParams.get('state');
    return request(PORT, 'GET', `/auth/callback?code=good-code&state=${state}`, { headers: { cookie: 'oauth=' + oauth } });
  };

  try {
    // nothing works without signing in
    let r = await request(PORT, 'GET', '/api/overview');
    assert.strictEqual(r.status, 401); assert.strictEqual(JSON.parse(r.text).signIn, '/auth/login');
    r = await request(PORT, 'GET', '/'); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/auth/login');
    r = await request(PORT, 'GET', '/app.js'); assert.strictEqual(r.status, 302);
    r = await request(PORT, 'POST', '/api/run', { headers: { 'x-dashboard': '1', 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 401);
    r = await request(PORT, 'GET', '/healthz'); assert.strictEqual(r.status, 200);
    ok('without signing in every page and every action is refused (only the health check is open)');

    // the redirect to Google
    r = await request(PORT, 'GET', '/auth/login');
    assert.strictEqual(r.status, 302);
    const loc = new URL(r.headers.location);
    assert.strictEqual(loc.origin + loc.pathname, `http://127.0.0.1:${gPort}/auth`);
    const q = loc.searchParams;
    assert.strictEqual(q.get('client_id'), 'test-client');
    assert.strictEqual(q.get('redirect_uri'), `http://localhost:${PORT}/auth/callback`);
    assert.strictEqual(q.get('response_type'), 'code');
    assert.ok(/openid/.test(q.get('scope')) && /email/.test(q.get('scope')));
    assert.ok(q.get('state').length >= 16 && q.get('nonce').length >= 16);
    assert.strictEqual(q.get('code_challenge_method'), 'S256'); assert.ok(q.get('code_challenge'));
    assert.strictEqual(q.get('hd'), 'example.edu');
    assert.ok(/HttpOnly/.test(rawCookie(r, 'oauth')) && /SameSite=Lax/.test(rawCookie(r, 'oauth')));
    ok('login sends people to Google with state, nonce, PKCE and the company domain');

    // the callback refuses anything that is not a clean sign-in
    r = await request(PORT, 'GET', '/auth/callback?code=good-code&state=wrong');
    assert.strictEqual(r.status, 400); assert.ok(!cookieOf(r, 'session'));
    const login = await request(PORT, 'GET', '/auth/login');
    const st = new URL(login.headers.location).searchParams.get('state');
    r = await request(PORT, 'GET', `/auth/callback?code=good-code&state=${st}`, { headers: { cookie: 'oauth=' + cookieOf(login, 'oauth') + 'x' } });
    assert.strictEqual(r.status, 400); assert.ok(!cookieOf(r, 'session'));
    r = await request(PORT, 'GET', '/auth/callback?error=access_denied'); assert.strictEqual(r.status, 400);
    ok('a callback with the wrong state, a tampered cookie or a cancelled sign-in is refused');

    for (const [name, over, mutate] of [
      ['another company\'s account', { email: 'x@other.org', hd: 'other.org' }],
      ['a personal Gmail account', { email: 'pat@gmail.com', hd: undefined }],
      ['the right domain but no Workspace marker', { hd: undefined }],
      ['the right address on a different Workspace', { hd: 'other.org' }],
    ]) {
      r = await signIn(over);
      assert.strictEqual(r.status, 403, name); assert.ok(!cookieOf(r, 'session'), name);
    }
    ok('only Workspace accounts of the company domain get in (other companies, Gmail and look-alikes are refused)');

    for (const [name, over] of [['the wrong client', { aud: 'someone-else' }], ['an old token', { exp: 1000 }], ['an unverified email', { email_verified: false }], ['a different nonce', { nonce: 'other' }]]) {
      r = await signIn(over); assert.strictEqual(r.status, 400, name); assert.ok(!cookieOf(r, 'session'), name);
    }
    ok('a token for another client, an expired token, an unverified email or a wrong nonce is refused');

    // the good path
    tokenCalls = [];
    r = await signIn({});
    assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/');
    const session = cookieOf(r, 'session');
    assert.ok(session);
    assert.ok(/HttpOnly/.test(rawCookie(r, 'session')) && /SameSite=Lax/.test(rawCookie(r, 'session')) && !/Secure/.test(rawCookie(r, 'session')), 'cookie flags on http');
    assert.ok(tokenCalls[0].code_verifier && tokenCalls[0].redirect_uri === `http://localhost:${PORT}/auth/callback`, 'PKCE verifier was sent to Google');
    const auth = { cookie: 'session=' + session };
    r = await request(PORT, 'GET', '/api/me', { headers: auth });
    assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.text).email, 'pat@example.edu');
    r = await request(PORT, 'GET', '/api/overview', { headers: auth }); assert.strictEqual(r.status, 200);
    r = await request(PORT, 'GET', '/', { headers: auth }); assert.strictEqual(r.status, 200); assert.ok(/School Info Sheet/.test(r.text));
    ok('a company account signs in, gets a session, and reaches the dashboard');

    // sessions cannot be forged or reused wrongly
    const tampered = session.slice(0, -3) + (session.endsWith('abc') ? 'xyz' : 'abc');
    r = await request(PORT, 'GET', '/api/overview', { headers: { cookie: 'session=' + tampered } }); assert.strictEqual(r.status, 401);
    const forged = Buffer.from(JSON.stringify({ email: 'boss@example.edu', exp: 9999999999 })).toString('base64url') + '.' + 'A'.repeat(43);
    r = await request(PORT, 'GET', '/api/overview', { headers: { cookie: 'session=' + forged } }); assert.strictEqual(r.status, 401);
    const expired = sign({ email: 'pat@example.edu', exp: Math.floor(Date.now() / 1000) - 5 });
    r = await request(PORT, 'GET', '/api/overview', { headers: { cookie: 'session=' + expired } }); assert.strictEqual(r.status, 401);
    const good = sign({ email: 'pat@example.edu', exp: Math.floor(Date.now() / 1000) + 60 });
    r = await request(PORT, 'GET', '/api/overview', { headers: { cookie: 'session=' + good } }); assert.strictEqual(r.status, 200, 'a correctly signed cookie works');
    ok('a tampered, forged or expired session cookie is refused');

    // actions still need the dashboard header, and the right Host
    r = await request(PORT, 'POST', '/api/stop', { headers: { ...auth, 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 403);
    r = await request(PORT, 'POST', '/api/stop', { headers: { ...auth, 'content-type': 'application/json', 'x-dashboard': '1' }, body: '{}' });
    assert.strictEqual(r.status, 200);
    r = await request(PORT, 'GET', '/api/overview', { headers: { ...auth, host: 'evil.example.com' } }); assert.strictEqual(r.status, 403);
    ok('actions need the dashboard header, and a wrong Host name is refused even when signed in');

    r = await request(PORT, 'GET', '/auth/logout', { headers: auth });
    assert.strictEqual(r.status, 200); assert.ok(/Max-Age=0/.test(rawCookie(r, 'session')));
    ok('signing out clears the session');
  } finally { server.kill(); }

  // https settings: Secure cookies, the public host name, strict transport security
  const HPORT = 4492;
  const httpsServer = await start(HPORT, { PUBLIC_URL: 'https://schools.example.com' });
  try {
    let r = await request(HPORT, 'GET', '/api/overview', { headers: { host: 'schools.example.com' } });
    assert.strictEqual(r.status, 401, 'the public host name is accepted');
    assert.ok(/max-age=/.test(r.headers['strict-transport-security'] || ''));
    r = await request(HPORT, 'GET', '/auth/login', { headers: { host: 'schools.example.com' } });
    assert.strictEqual(new URL(r.headers.location).searchParams.get('redirect_uri'), 'https://schools.example.com/auth/callback');
    assert.ok(/; Secure/.test(rawCookie(r, 'oauth')));
    r = await request(HPORT, 'GET', '/api/overview', { headers: { host: 'other.example.com' } }); assert.strictEqual(r.status, 403);
    ok('with an https address: Secure cookies, strict transport security, and only that host name is accepted');
  } finally { httpsServer.kill(); }

  // refusing to start
  const tryStart = (env) => spawnSync(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--no-browser'], { cwd: ROOT, env: { PATH: process.env.PATH, DATA_DIR: tmp, ...env }, encoding: 'utf8', timeout: 8000 });
  let s = tryStart({ HOST: '0.0.0.0', PORT: '4493' });
  assert.strictEqual(s.status, 1); assert.ok(/sign-in is not set up/.test(s.stderr), s.stderr);
  s = tryStart({ HOST: '0.0.0.0', PORT: '4493', GOOGLE_CLIENT_ID: 'only-the-id', PUBLIC_URL: 'https://x.example.com', ALLOWED_EMAIL_DOMAIN: 'example.edu' });
  assert.strictEqual(s.status, 1); assert.ok(/GOOGLE_CLIENT_SECRET/.test(s.stderr), s.stderr);
  s = tryStart({ HOST: '0.0.0.0', PORT: '4493', GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', PUBLIC_URL: 'https://x.example.com' });
  assert.strictEqual(s.status, 1); assert.ok(/ALLOWED_EMAIL_DOMAIN/.test(s.stderr), s.stderr);
  s = tryStart({ HOST: '0.0.0.0', PORT: '4493', GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', PUBLIC_URL: 'http://schools.example.com', ALLOWED_EMAIL_DOMAIN: 'example.edu' });
  assert.strictEqual(s.status, 1); assert.ok(/https/.test(s.stderr), s.stderr);
  ok('the program will not start open to the network without complete sign-in settings (or over plain http)');

  google.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed.`);
})().catch((e) => { console.error('\nFAILED:', e.message, '\n', (e.stack || '').split('\n').slice(1, 5).join('\n')); process.exit(1); });
