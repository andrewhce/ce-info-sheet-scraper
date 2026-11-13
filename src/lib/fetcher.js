'use strict';
// Polite page fetcher.
//   - identifies itself honestly (no browser disguise) and obeys robots.txt
//   - one request at a time per website, with a pause between requests
//   - keeps a local cache so re-runs and sibling divisions do not re-download pages
//   - when a site refuses automated access it is reported as "blocked", never worked around
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PATHS, readJson, writeJson } = require('./util');
const { parseHtml, parsePdfText, PARSER_VERSION } = require('./html');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BLOCK_MARKERS = /just a moment\.\.\.|cf-chl-|cf_chl_|attention required|access denied|request unsuccessful|incapsula|captcha|are you a (robot|human)|pardon our interruption|unusual traffic|security check|verify(ing)? you are human|enable javascript and cookies/i;

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
    this.agentToken = this.c.userAgent.split('/')[0].toLowerCase();
    this.chains = new Map();
    this.lastHit = new Map();
    this.robots = new Map();
    this.requests = 0;
    this.cacheHits = 0;
  }

  cacheFile(url) {
    const host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_');
    return path.join(PATHS.cacheDir, host, crypto.createHash('sha1').update(url).digest('hex').slice(0, 20) + '.json');
  }

  fresh(rec) {
    return rec && rec.parser === PARSER_VERSION &&
      Date.now() - Date.parse(rec.fetchedAt) < this.c.cacheDays * 86400000;
  }

  enqueue(host, delayMs, fn) {
    const prev = this.chains.get(host) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const wait = (this.lastHit.get(host) || 0) + delayMs - Date.now();
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
    try {
      const res = await fetch(url, {
        redirect: 'follow', signal: ctrl.signal,
        headers: {
          'User-Agent': this.c.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
          'Accept-Language': 'en-US,en;q=0.8',
        },
      });
      const type = (res.headers.get('content-type') || '').toLowerCase();
      const isPdf = type.includes('application/pdf') || (/\.pdf($|\?)/i.test(res.url) && !type.includes('html'));
      const cap = isPdf ? this.c.maxPdfBytes : this.c.maxHtmlBytes;
      const out = { status: res.status, finalUrl: res.url, type, isPdf };
      if (Number(res.headers.get('content-length') || 0) > cap) { ctrl.abort(); return { ...out, tooBig: true }; }
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
    } finally { clearTimeout(timer); }
  }

  async rawWithRetry(url) {
    try { return await this.raw(url); } catch (e) {
      await sleep(2000);
      try { return await this.raw(url); } catch (e2) {
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
      const file = path.join(PATHS.cacheDir, host.replace(/[^a-z0-9.-]/gi, '_'), 'robots.json');
      const cached = readJson(file);
      if (!this.refresh && cached && Date.now() - Date.parse(cached.fetchedAt) < this.c.cacheDays * 86400000) return cached;
      const r = await this.enqueue(host, this.c.delayMs, () => this.rawWithRetry(origin + '/robots.txt'));
      let rec;
      if (r.error) rec = { rules: [], delay: null, note: 'robots.txt unreachable' };
      else if (r.status >= 500) rec = { rules: [{ allow: false, path: '/' }], delay: null, note: 'robots.txt server error' };
      else if (r.status >= 400 || !r.body || r.type.includes('html')) rec = { rules: [], delay: null, note: 'no robots.txt' };
      else rec = parseRobots(this.decode(r.body, r.type), this.agentToken);
      rec.fetchedAt = new Date().toISOString();
      writeJson(file, rec);
      return rec;
    })();
    this.robots.set(origin, p);
    return p;
  }

  /** Fetch one page. Always resolves to a record; never throws. */
  async get(url) {
    const file = this.cacheFile(url);
    if (!this.refresh) {
      const cached = readJson(file);
      if (this.fresh(cached)) { this.cacheHits++; return { ...cached, fromCache: true }; }
    }
    const u = new URL(url);
    const base = { url, finalUrl: url, fetchedAt: new Date().toISOString(), parser: PARSER_VERSION, ok: false };
    const robots = await this.robotsFor(u.origin);
    if (!robotsAllows(robots.rules, u.pathname + u.search)) {
      const rec = { ...base, robots: true, error: 'disallowed by robots.txt' };
      writeJson(file, rec);
      return rec;
    }
    const delay = Math.min(10000, Math.max(this.c.delayMs, (robots.delay || 0) * 1000));
    const r = await this.enqueue(u.hostname, delay, () => this.rawWithRetry(url));
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
      const parsed = r.status === 200 ? parseHtml(html, r.finalUrl) : null;
      const challenge = BLOCK_MARKERS.test(html.slice(0, 20000)) && (!parsed || parsed.mainChars < 1500);
      const blocked = [401, 403, 406, 429].includes(r.status) || (r.status >= 500 && challenge) || (r.status === 200 && challenge);
      if (blocked) rec = { ...base, finalUrl: r.finalUrl, status: r.status, blocked: true, error: 'site refused automated access (HTTP ' + r.status + ')' };
      else if (r.status !== 200) rec = { ...base, finalUrl: r.finalUrl, status: r.status, error: 'HTTP ' + r.status };
      else rec = { ...base, finalUrl: r.finalUrl, status: 200, kind: 'html', ok: true, ...parsed };
    }
    writeJson(file, rec);
    return rec;
  }

  /** Raw text of a small file such as sitemap.xml (not cached). */
  async getText(url) {
    const u = new URL(url);
    const robots = await this.robotsFor(u.origin);
    if (!robotsAllows(robots.rules, u.pathname + u.search)) return null;
    const r = await this.enqueue(u.hostname, this.c.delayMs, () => this.rawWithRetry(url));
    if (r.error || r.tooBig || r.status !== 200 || !r.body) return null;
    return this.decode(r.body, r.type || '');
  }
}

module.exports = { Fetcher, parseRobots, robotsAllows };
