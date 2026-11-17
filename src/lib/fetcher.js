'use strict';
// Polite page fetcher.
//   - identifies itself honestly (no browser disguise) and obeys robots.txt
//   - one request at a time per website, with a pause between requests
//   - keeps a local cache so re-runs and sibling divisions do not re-download pages
//   - when a site refuses automated access it is reported as "blocked", never worked around
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dns = require('dns').promises;
const { PATHS, readJson, writeJson } = require('./util');
const { parseHtml, parsePdfText, PARSER_VERSION } = require('./html');
const { fetchRenderedHtml } = require('./browser-fetch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOCK_MARKERS = /just a moment\.\.\.|cf-chl-|cf_chl_|attention required|access denied|request unsuccessful|incapsula|captcha|are you a (robot|human)|pardon our interruption|unusual traffic|security check|verify(ing)? you are human|enable javascript and cookies/i;
const JS_SHELL_MARKERS = /id=["'](?:__next|root|app|gatsby|__nuxt)["']|data-reactroot|window\.__NEXT_DATA__|enable javascript|noscript/i;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const BLOCKED_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);
const BLOCKED_TLDS = ['.localhost', '.local', '.internal', '.arpa', '.home', '.lan'];

function ssrfError(message) {
  const err = new Error(message);
  err.ssrfBlocked = true;
  return err;
}

function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function ipv6Words(ip) {
  const parts = ip.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':').map((x) => parseInt(x, 16)) : [];
  const right = parts[1] ? parts[1].split(':').map((x) => parseInt(x, 16)) : [];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return null;
  const fill = 8 - left.length - right.length;
  if (parts.length === 1 && left.length !== 8) return null;
  if (parts.length === 2 && fill < 0) return null;
  return [...left, ...Array(Math.max(0, fill)).fill(0), ...right];
}

/** True when an IP literal is loopback, link-local, RFC1918 private, CGNAT, unspecified, or reserved. */
function isPrivateIp(rawIp) {
  const ip = String(rawIp || '').trim().replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  const family = net.isIP(ip);
  if (!family) return true;
  if (family === 4) return isPrivateIpv4(ip);
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) return isPrivateIpv4(ip.slice(7));
  const w = ipv6Words(ip);
  if (!w) return true;
  if (w.every((n) => n === 0)) return true;                                  // ::
  if (w.slice(0, 7).every((n) => n === 0) && w[7] === 1) return true;        // ::1
  if (w.slice(0, 5).every((n) => n === 0) && w[5] === 0xffff) {              // ::ffff:0:0/96
    return isPrivateIpv4(`${(w[6] >> 8) & 255}.${w[6] & 255}.${(w[7] >> 8) & 255}.${w[7] & 255}`);
  }
  const head = w[0];
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Rejects non-HTTP(S), localhost/.local/.internal hostnames, and private/metadata IP targets before fetching. */
async function assertPublicUrl(rawUrl, dnsLookup = dns.lookup) {
  let u;
  try { u = new URL(rawUrl); } catch { throw ssrfError('blocked invalid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw ssrfError('blocked non-HTTP URL');
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host || BLOCKED_HOSTS.has(host) || BLOCKED_TLDS.some((sfx) => host.endsWith(sfx))) {
    throw ssrfError(`blocked internal host (${host || 'empty'})`);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw ssrfError(`blocked private IP (${host})`);
    return u;
  }
  const records = await dnsLookup(host, { all: true });
  const list = Array.isArray(records) ? records : records ? [records] : [];
  for (const rec of list) {
    const addr = rec && (rec.address || rec);
    if (addr && isPrivateIp(addr)) throw ssrfError(`blocked private IP resolution (${host} -> ${addr})`);
  }
  return u;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseRobots(txt, agentToken) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [], delay: null }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (k === 'disallow' || k === 'allow') cur.rules.push({ allow: k === 'allow', path: v });
      else if (k === 'crawl-delay' && !isNaN(parseFloat(v))) cur.delay = parseFloat(v);
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && agentToken.includes(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return { rules: use.flatMap((g) => g.rules), delay: use.map((g) => g.delay).find((d) => d != null) || null };
}

function robotsAllows(rules, pathAndQuery) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue;
    let src = r.path.split('*').map(escapeRe).join('.*');
    if (src.endsWith('\\$')) src = src.slice(0, -2) + '$';
    if (!new RegExp('^' + src).test(pathAndQuery)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

class Fetcher {
  constructor(cfg, opts = {}) {
    this.c = cfg.crawl;
    this.refresh = !!opts.refresh;
    this.cacheDir = opts.cacheDir || PATHS.cacheDir;
    this.dnsLookup = opts.dnsLookup || dns.lookup;
    this.fetchImpl = opts.fetch || fetch;
    this.headlessFallback = opts.headlessFallback !== false && this.c.headlessFallback !== false;
    this.renderHtml = opts.renderHtml || ((u) => fetchRenderedHtml(u, { assertPublic: (x) => assertPublicUrl(x, this.dnsLookup) }));
    this.agentToken = this.c.userAgent.split('/')[0].toLowerCase();
    this.chains = new Map();
    this.lastHit = new Map();
    this.hostDelay = new Map();
    this.robots = new Map();
    this.requests = 0;
    this.cacheHits = 0;
  }

  cacheFile(url) {
    const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
    return path.join(this.cacheDir, host, crypto.createHash('sha1').update(url).digest('hex').slice(0, 20) + '.json');
  }

  fresh(rec) {
    if (!rec || rec.parser !== PARSER_VERSION) return false;
    if (!(Date.now() - Date.parse(rec.fetchedAt) < this.c.cacheDays * 86400000)) return false;
    // Never cache transient errors or rate limits for 7 days, and self-heal old 0-mainChars wrapper bugs
    if (!rec.ok && !rec.robots && !(rec.blocked && rec.status !== 429)) return false;
    if (rec.ok && rec.kind === 'html' && !(rec.mainChars > 0) && Array.isArray(rec.blocks) && rec.blocks.length > 15) return false;
    return true;
  }

  enqueue(host, delayMs, fn) {
    const prev = this.chains.get(host) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const effectiveDelay = Math.min(10000, Math.max(delayMs, this.hostDelay.get(host) || 0));
      const wait = (this.lastHit.get(host) || 0) + effectiveDelay - Date.now();
      if (wait > 0) await sleep(wait);
      try { return await fn(); } finally { this.lastHit.set(host, Date.now()); }
    });
    this.chains.set(host, run);
    return run;
  }

  async raw(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.c.timeoutMs);
    this.requests++;
    let curUrl = url;
    try {
      for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
        await assertPublicUrl(curUrl, this.dnsLookup);
        const res = await this.fetchImpl(curUrl, {
          redirect: 'manual', signal: ctrl.signal,
          headers: {
            'User-Agent': this.c.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
            'Accept-Language': 'en-US,en;q=0.8',
          },
        });
        const loc = res.headers && res.headers.get ? res.headers.get('location') : null;
        if (REDIRECT_STATUSES.has(res.status) && loc) {
          if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {});
          if (hops === MAX_REDIRECTS) throw ssrfError('too many redirects');
          curUrl = new URL(loc, curUrl).toString();
          continue;
        }
        const finalUrl = res.url || curUrl;
        const type = ((res.headers && res.headers.get ? res.headers.get('content-type') : '') || '').toLowerCase();
        const isPdf = type.includes('application/pdf') || (/\.pdf($|\?)/i.test(finalUrl) && !type.includes('html'));
        const cap = isPdf ? this.c.maxPdfBytes : this.c.maxHtmlBytes;
        const retryAfterRaw = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
        const retryAfterSec = retryAfterRaw != null && retryAfterRaw !== '' ? Number(retryAfterRaw) : NaN;
        const out = { status: res.status, finalUrl, type, isPdf, retryAfterSec };
        if (Number((res.headers && res.headers.get && res.headers.get('content-length')) || 0) > cap) { ctrl.abort(); return { ...out, tooBig: true }; }
        const chunks = [];
        let size = 0;
        if (res.body) {
          for await (const chunk of res.body) {
            size += chunk.length;
            if (size > cap) { ctrl.abort(); return { ...out, tooBig: true }; }
            chunks.push(chunk);
          }
        }
        return { ...out, body: Buffer.concat(chunks) };
      }
    } finally { clearTimeout(timer); }
  }

  async rawWithRetry(url, host) {
    let first;
    try {
      first = await this.raw(url);
      if (first.status !== 429 && first.status !== 503) return first;
      if (host) {
        const nextDelay = Math.min(10000, Math.max(this.hostDelay.get(host) || 0, this.c.delayMs * 2, 2500));
        this.hostDelay.set(host, nextDelay);
      }
      const waitMs = Number.isFinite(first.retryAfterSec) && first.retryAfterSec >= 0
        ? Math.min(5000, first.retryAfterSec * 1000)
        : 2000;
      if (waitMs > 0) await sleep(waitMs);
      try { return await this.raw(url); } catch { return first; }
    } catch (e) {
      if (e && e.ssrfBlocked) return { error: e.message, ssrfBlocked: true };
      await sleep(800);
      try { return await this.raw(url); } catch (e2) {
        if (e2 && e2.ssrfBlocked) return { error: e2.message, ssrfBlocked: true };
        return { error: e2.name === 'AbortError' ? 'timed out' : (e2.cause && e2.cause.code) || e2.message || 'network error' };
      }
    }
  }

  decode(buf, type) {
    let charset = (type.match(/charset=([\w-]+)/) || [])[1];
    if (!charset) charset = (buf.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1];
    try { return new TextDecoder(charset || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
  }

  async robotsFor(origin) {
    if (this.robots.has(origin)) return this.robots.get(origin);
    const p = (async () => {
      const host = new URL(origin).hostname;
      const file = path.join(this.cacheDir, host.replace(/[^a-z0-9.-]/gi, '_'), 'robots.json');
      const cached = readJson(file);
      if (!this.refresh && cached && !cached.transient && Date.now() - Date.parse(cached.fetchedAt) < this.c.cacheDays * 86400000) return cached;
      const r = await this.enqueue(host, this.c.delayMs, () => this.rawWithRetry(origin + '/robots.txt', host));
      let rec;
      if (r.error) rec = { rules: [], delay: null, note: 'robots.txt unreachable', transient: true };
      else if (r.status >= 500) rec = { rules: [{ allow: false, path: '/' }], delay: null, note: 'robots.txt server error', transient: true };
      else if (r.status >= 400 || !r.body || r.type.includes('html')) rec = { rules: [], delay: null, note: 'no robots.txt' };
      else rec = parseRobots(this.decode(r.body, r.type), this.agentToken);
      rec.fetchedAt = new Date().toISOString();
      if (!rec.transient) writeJson(file, rec);
      return rec;
    })();
    this.robots.set(origin, p);
    return p;
  }

  /** Fetch one page. Always resolves to a record; never throws. */
  async get(url) {
    const base = { url, finalUrl: url, fetchedAt: new Date().toISOString(), parser: PARSER_VERSION, ok: false };
    let u;
    try { u = await assertPublicUrl(url, this.dnsLookup); } catch (e) {
      return { ...base, error: e.message };
    }
    const file = this.cacheFile(url);
    if (!this.refresh) {
      const cached = readJson(file);
      if (this.fresh(cached)) { this.cacheHits++; return { ...cached, fromCache: true }; }
    }
    const robots = await this.robotsFor(u.origin);
    if (!robotsAllows(robots.rules, u.pathname + u.search)) {
      const rec = { ...base, robots: true, error: 'disallowed by robots.txt' };
      writeJson(file, rec);
      return rec;
    }
    const delay = Math.min(10000, Math.max(this.c.delayMs, (robots.delay || 0) * 1000));
    const r = await this.enqueue(u.hostname, delay, () => this.rawWithRetry(url, u.hostname));
    let rec;
    if (r.error) rec = { ...base, error: r.error };
    else if (r.tooBig) rec = { ...base, finalUrl: r.finalUrl, status: r.status, error: 'file too large, skipped' };
    else if (r.isPdf && r.status === 200) {
      let timer;
      try {
        const pdfParse = require('pdf-parse/lib/pdf-parse.js');
        const data = await Promise.race([
          pdfParse(r.body, { max: 12 }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PDF took too long to read')), 45000); }),
        ]);
        clearTimeout(timer);
        rec = { ...base, finalUrl: r.finalUrl, status: 200, kind: 'pdf', ok: true, ...parsePdfText(data.text) };
        rec.title = (data.info && data.info.Title) || '';
      } catch (e) {
        clearTimeout(timer);
        rec = { ...base, finalUrl: r.finalUrl, status: 200, kind: 'pdf', error: 'could not read PDF: ' + e.message };
      }
    } else if (r.type && !/html|xml|text/.test(r.type) && r.status === 200) {
      rec = { ...base, finalUrl: r.finalUrl, status: r.status, error: 'not a web page (' + r.type.split(';')[0] + ')' };
    } else {
      const html = this.decode(r.body || Buffer.alloc(0), r.type || '');
      let parsed = r.status === 200 ? parseHtml(html, r.finalUrl) : null;
      const challenge = BLOCK_MARKERS.test(html.slice(0, 20000)) && (!parsed || parsed.mainChars < 1500);
      const blocked = [401, 403, 406, 429].includes(r.status) || (r.status >= 500 && challenge) || (r.status === 200 && challenge);
      let renderedHeadless = false;
      if (!blocked && r.status === 200 && this.headlessFallback && (!parsed || parsed.mainChars < 600) && JS_SHELL_MARKERS.test(html.slice(0, 50000))) {
        const renderedHtml = await this.renderHtml(r.finalUrl).catch(() => null);
        if (renderedHtml && !BLOCK_MARKERS.test(renderedHtml.slice(0, 20000))) {
          const rp = parseHtml(renderedHtml, r.finalUrl);
          if (rp && rp.mainChars > Math.max((parsed ? parsed.mainChars : 0) * 1.5, 400)) {
            parsed = rp;
            renderedHeadless = true;
          }
        }
      }
      if (blocked) rec = { ...base, finalUrl: r.finalUrl, status: r.status, blocked: true, error: 'site refused automated access (HTTP ' + r.status + ')' };
      else if (r.status !== 200) rec = { ...base, finalUrl: r.finalUrl, status: r.status, error: 'HTTP ' + r.status };
      else rec = { ...base, finalUrl: r.finalUrl, status: 200, kind: 'html', ok: true, ...(renderedHeadless ? { renderedHeadless: true } : {}), ...parsed };
    }
    writeJson(file, rec);
    return rec;
  }

  /** Raw text of a small file such as sitemap.xml (not cached). */
  async getText(url) {
    let u;
    try { u = await assertPublicUrl(url, this.dnsLookup); } catch { return null; }
    const robots = await this.robotsFor(u.origin);
    if (!robotsAllows(robots.rules, u.pathname + u.search)) return null;
    const r = await this.enqueue(u.hostname, this.c.delayMs, () => this.rawWithRetry(url, u.hostname));
    if (r.error || r.tooBig || r.status !== 200 || !r.body) return null;
    return this.decode(r.body, r.type || '');
  }
}

module.exports = { Fetcher, parseRobots, robotsAllows, isPrivateIp, assertPublicUrl };
