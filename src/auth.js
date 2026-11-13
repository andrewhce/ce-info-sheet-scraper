'use strict';
// Team sign-in with company Google accounts, and the settings that let the program run on a server.
//
// On a personal computer nothing here is switched on: the dashboard only answers that computer and needs no sign-in.
// On a server, set these (see docs/ONLINE-SETUP.md):
//   HOST                   0.0.0.0 on a server (default 127.0.0.1, this computer only)
//   PUBLIC_URL             the https address people use, for example https://schools.example.com
//   GOOGLE_CLIENT_ID       from Google Cloud (OAuth client, "Web application")
//   GOOGLE_CLIENT_SECRET   the matching secret
//   ALLOWED_EMAIL_DOMAIN   for example cardinaleducation.com: only Google Workspace accounts of that domain get in
//   ALLOWED_EMAILS         optional extra single addresses, comma separated
//   SESSION_SECRET         optional, 32+ random characters; if missing one is made and kept in the data folder
// The program refuses to listen on anything but this computer unless sign-in is fully set up.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./lib/util');

const env = process.env;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const SESSION_SECONDS = 12 * 3600;

const settings = {
  host: env.HOST || '127.0.0.1',
  publicUrl: (env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  clientId: (env.GOOGLE_CLIENT_ID || '').trim(),
  clientSecret: (env.GOOGLE_CLIENT_SECRET || '').trim(),
  domain: (env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase().replace(/^@/, ''),
  emails: (env.ALLOWED_EMAILS || '').toLowerCase().split(/[,\s]+/).filter(Boolean),
  // changed only by the automatic checks
  authUrl: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
};
const enabled = !!(settings.clientId || settings.clientSecret || settings.publicUrl && settings.domain);
const loopbackOnly = LOOPBACK.has(settings.host);
const secureCookies = settings.publicUrl.startsWith('https://');

/** Things that are wrong with the settings. An empty list means the program may start. */
function problems() {
  const out = [];
  if (enabled) {
    if (!settings.clientId || !settings.clientSecret) out.push('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both needed for sign-in.');
    if (!/^https?:\/\/[^/\s]+$/i.test(settings.publicUrl)) out.push('PUBLIC_URL is needed, for example https://schools.example.com (no path).');
    if (!settings.domain && !settings.emails.length) out.push('Set ALLOWED_EMAIL_DOMAIN (or ALLOWED_EMAILS) so the program knows who may sign in.');
    if (settings.publicUrl.startsWith('http://') && !LOOPBACK.has(new URL(settings.publicUrl || 'http://x').hostname)) out.push('PUBLIC_URL must start with https:// on a server.');
  } else if (!loopbackOnly) {
    out.push(`HOST is ${settings.host}, which other computers can reach, but sign-in is not set up. Refusing to start without it.`);
  }
  return out;
}

// ----------------------------------------------------------------- sessions ---

let cachedSecret = null;
function secret() {
  if (cachedSecret) return cachedSecret;
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return (cachedSecret = env.SESSION_SECRET);
  const file = path.join(PATHS.data, 'session-secret');
  try { cachedSecret = fs.readFileSync(file, 'utf8').trim(); } catch { /* make one below */ }
  if (!cachedSecret || cachedSecret.length < 32) {
    cachedSecret = crypto.randomBytes(48).toString('base64url');
    fs.mkdirSync(PATHS.data, { recursive: true });
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

const mac = (body) => crypto.createHmac('sha256', secret()).update(body).digest('base64url');
function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  return body + '.' + mac(body);
}
function verify(token) {
  const [body, given] = String(token || '').split('.');
  if (!body || !given) return null;
  const good = mac(body);
  if (given.length !== good.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(good))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return o && o.exp > Date.now() / 1000 ? o : null;
  } catch { return null; }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const cookie = (name, value, seconds) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secureCookies ? '; Secure' : ''}`;

/** The signed-in person, or null. Without sign-in set up (this computer only) everyone is the local user. */
function sessionUser(req) {
  if (!enabled) return { email: null, name: 'This computer', local: true };
  const s = verify(cookies(req).session);
  return s && s.email ? { email: s.email, name: s.name || s.email } : null;
}

function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (LOOPBACK.has(host)) return true;
  if (!settings.publicUrl) return false;
  try { return host === new URL(settings.publicUrl).hostname.toLowerCase(); } catch { return false; }
}

// -------------------------------------------------------------- sign-in flow ---

const redirectUri = () => settings.publicUrl + '/auth/callback';
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(n) && !n.startsWith('/auth/') ? n : '/');

function page(title, message, link) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title><link rel="stylesheet" href="/auth/page.css"></head><body><main class="authbox"><h1>${title}</h1><p>${message}</p>` +
    (link ? `<p><a class="btn primary" href="${link.href}">${link.text}</a></p>` : '') + `</main></body></html>`;
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const PAGE_CSS = 'body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f4ef;color:#1d1b18}.authbox{max-width:460px;margin:12vh auto;padding:0 20px}' +
  'h1{font:600 26px Georgia,serif}.btn{display:inline-block;padding:9px 16px;border-radius:8px;background:#9b1c2e;color:#fff;text-decoration:none;font-weight:600}' +
  '@media (prefers-color-scheme:dark){body{background:#151412;color:#ece8e1}}';

function claimsOf(idToken) {
  const part = String(idToken || '').split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

function allowed(email, hostedDomain) {
  const e = String(email || '').toLowerCase();
  if (settings.emails.includes(e)) return true;
  // a company address only counts when Google says the account belongs to the company's Workspace
  return !!settings.domain && e.endsWith('@' + settings.domain) && String(hostedDomain || '').toLowerCase() === settings.domain;
}

/**
 * Handles /auth/* and the public health check. Returns true when it answered the request.
 * send(res, status, body, contentType, extraHeaders)
 */
async function handle(req, res, url, send) {
  const p = url.pathname;
  if (p === '/healthz') { send(res, 200, 'ok', 'text/plain; charset=utf-8'); return true; }
  if (!p.startsWith('/auth/')) return false;
  const html = (status, body, headers) => send(res, status, body, 'text/html; charset=utf-8', headers);
  if (p === '/auth/page.css') { send(res, 200, PAGE_CSS, 'text/css; charset=utf-8'); return true; }
  if (!enabled) { html(404, page('Sign-in is not set up', 'This copy of the program runs on one computer and does not use sign-in.')); return true; }

  if (p === '/auth/login') {
    const state = crypto.randomBytes(16).toString('base64url');
    const nonce = crypto.randomBytes(16).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const q = new URLSearchParams({
      client_id: settings.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    });
    if (settings.domain) q.set('hd', settings.domain);
    const oauth = sign({ state, nonce, verifier, next: safeNext(url.searchParams.get('next')), exp: Math.floor(Date.now() / 1000) + 600 });
    send(res, 302, '', 'text/plain; charset=utf-8', { Location: settings.authUrl + '?' + q, 'Set-Cookie': cookie('oauth', oauth, 600) });
    return true;
  }

  if (p === '/auth/callback') {
    const clearOauth = cookie('oauth', '', 0);
    const fail = (status, title, msg) => html(status, page(title, msg, { href: '/auth/login', text: 'Try again' }), { 'Set-Cookie': clearOauth });
    const o = verify(cookies(req).oauth);
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    if (url.searchParams.get('error')) { fail(400, 'Sign-in was cancelled', 'Google did not sign you in. You can try again.'); return true; }
    if (!o || !code || !state || state !== o.state) { fail(400, 'Sign-in did not finish', 'The sign-in took too long or was opened in a different browser. Please try again.'); return true; }
    let claims;
    try {
      const r = await fetch(settings.tokenUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: settings.clientId, client_secret: settings.clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code', code_verifier: o.verifier }),
      });
      const j = await r.json();
      if (!r.ok || !j.id_token) throw new Error(j.error_description || j.error || 'no token');
      // The token came straight from Google over TLS, so its claims are checked rather than its signature (OpenID Connect Core 3.1.3.7).
      claims = claimsOf(j.id_token);
    } catch (e) { fail(502, 'Google would not confirm the sign-in', 'Please try again in a moment. If it keeps happening, the Google sign-in settings need checking.'); return true; }
    const now = Math.floor(Date.now() / 1000);
    const okIssuer = ['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || settings.tokenUrl !== 'https://oauth2.googleapis.com/token';
    if (!okIssuer || claims.aud !== settings.clientId || !(claims.exp > now) || claims.nonce !== o.nonce || claims.email_verified !== true) {
      fail(400, 'Sign-in could not be verified', 'Google’s answer did not check out. Please try again.'); return true;
    }
    if (!allowed(claims.email, claims.hd)) {
      html(403, page('This account is not allowed in', `${escapeHtml(claims.email)} is not on the list for this program. Sign in with your company Google account.`, { href: '/auth/login', text: 'Use another account' }), { 'Set-Cookie': clearOauth });
      return true;
    }
    const session = sign({ email: String(claims.email).toLowerCase(), name: claims.name || claims.email, exp: now + SESSION_SECONDS });
    send(res, 302, '', 'text/plain; charset=utf-8', { Location: safeNext(o.next), 'Set-Cookie': [cookie('session', session, SESSION_SECONDS), clearOauth] });
    return true;
  }

  if (p === '/auth/logout') {
    html(200, page('Signed out', 'You have been signed out.', { href: '/auth/login', text: 'Sign in again' }), { 'Set-Cookie': cookie('session', '', 0) });
    return true;
  }
  html(404, page('Not found', 'There is nothing at this address.'));
  return true;
}

module.exports = { settings, enabled, loopbackOnly, problems, sessionUser, hostAllowed, handle, sign, verify };
