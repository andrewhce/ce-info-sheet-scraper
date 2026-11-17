'use strict';
// Turns a web page (or PDF text) into an ordered list of text blocks the rules can read:
//   { k: 'h' | 'p' | 'li' | 'row', z: 'main' | 'nav' | 'header' | 'footer', text, level? }
// Nothing here interprets meaning. It only keeps the page's own words and structure.
const cheerio = require('cheerio');
const { oneLine } = require('./util');

const PARSER_VERSION = 4;

const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'head', 'select', 'canvas',
  'video', 'audio', 'picture', 'map', 'object', 'embed', 'img', 'input', 'textarea']);
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'dd', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'hr', 'main', 'nav', 'ol', 'p', 'pre',
  'section', 'table', 'tbody', 'thead', 'tfoot', 'td', 'th', 'ul', 'summary', 'caption', 'label', 'button']);
const COUNTER_ATTRS = ['data-count', 'data-to', 'data-target', 'data-number', 'data-stop', 'data-value',
  'data-countup', 'data-end', 'data-count-to', 'data-counter', 'data-num'];

function zoneOf(el, tag, inContent) {
  const a = el.attribs || {};
  const role = (a.role || '').toLowerCase();
  if (tag === 'main' || role === 'main') return 'main';
  if (tag === 'nav' || role === 'navigation') return 'nav';
  if (role === 'contentinfo') return 'footer';
  if (role === 'banner') return 'header';
  // <header>/<footer> inside a section, article or main belong to that content block
  // (for example the title bar of a tab panel), not to the site chrome
  if (tag === 'footer') return inContent ? null : 'footer';
  if (tag === 'header') return inContent ? null : 'header';
  if (tag === 'body' || tag === 'html' || tag === 'article') return null;
  const idc = ((a.id || '') + ' ' + (a.class || ''));
  // Ignore outer wrapper state/animation target classes (e.g. Webflow ".menu-target", ".has-nav", ".nav-open")
  const cleanIdc = idc
    .split(/\s+/)
    .filter((t) => t && !/(?:^|[-_])(?:target|backdrop|open|opened|closed|trigger|toggle|push)(?:$|[-_])|^(?:has|no|with|is)[-_]/i.test(t))
    .join(' ');
  if (/\bfs(Navigation|Menu)\b|(^|[\s_-])(nav|navbar|navigation|menu|mega-?menu|breadcrumbs?)([\s_-]|$)/i.test(cleanIdc)) return 'nav';
  if (/\bfsFooter\b|(^|[\s_-])(footer|site-footer)([\s_-]|$)/i.test(cleanIdc)) return 'footer';
  if (/\bfsHeader\b|(^|[\s_-])(site-header|page-header-nav|masthead)([\s_-]|$)/i.test(cleanIdc)) return 'header';
  return null;
}

function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const title = oneLine($('title').first().text());
  const description = oneLine($('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '');
  const siteName = oneLine($('meta[property="og:site_name"]').attr('content') || '');

  const jsonld = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const push = (n) => { if (n && typeof n === 'object') jsonld.push(n); };
      (Array.isArray(data) ? data : [data]).forEach((n) => { push(n); if (n && Array.isArray(n['@graph'])) n['@graph'].forEach(push); });
    } catch { /* malformed JSON-LD is ignored */ }
  });

  const links = [];
  const seen = new Set();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href || href.startsWith('#') || /^(mailto|tel|javascript|sms|data):/i.test(href)) return;
    let u; try { u = new URL(href, baseUrl); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    const text = oneLine($(el).text()) || oneLine($(el).attr('aria-label') || $(el).attr('title') || $(el).find('img').attr('alt') || '');
    const key = u.href + '|' + text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ url: u.href, text: text.slice(0, 140) });
  });

  // animated counters render "0" until JavaScript runs; the real number sits in a data attribute
  $(COUNTER_ATTRS.map((a) => `[${a}]`).join(',')).each((_, el) => {
    const shown = oneLine($(el).text());
    if (shown && !/^[\d\s.,%$:+]*$/.test(shown)) return;
    for (const a of COUNTER_ATTRS) {
      const v = (el.attribs[a] || '').trim();
      if (/^[\d.,]+$/.test(v) && Number(v.replace(/,/g, '')) !== 0) {
        const prefix = (shown.match(/^[$]/) || [''])[0], suffix = (shown.match(/[%+]$/) || [''])[0];
        $(el).text(prefix + v + suffix);
        break;
      }
    }
  });

  const blocks = [];
  let buf = '';
  let boundary = false;
  const flush = (k, z, level) => {
    const text = buf.replace(/[ \t ​]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{2,}/g, '\n').trim();
    buf = ''; boundary = false;
    if (!text) return;
    const b = { k, z, text };
    if (level) b.level = level;
    blocks.push(b);
  };
  const append = (t) => {
    if (!t) return;
    if (boundary && /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(t)) buf += ' ';
    boundary = false;
    buf += t.replace(/\s+/g, ' ');
  };
  const simpleRow = (tr) => {
    if ($(tr).find('table,ul,ol,h1,h2,h3,h4,h5,h6').length) return null;
    const cells = $(tr).children('td,th').map((_, c) => oneLine($(c).text())).get().filter(Boolean);
    const joined = cells.join(' | ');
    return cells.length >= 2 && joined.length <= 700 ? joined : null;
  };
  const walk = (node, zone, kind, level, inContent) => {
    for (const child of node.children || []) {
      if (child.type === 'text') { append(child.data); continue; }
      if (child.type !== 'tag') continue;
      const tag = child.name.toLowerCase();
      if (SKIP.has(tag)) continue;
      if (tag === 'br') { buf += '\n'; continue; }
      const nextZone = zoneOf(child, tag, inContent);
      const z = nextZone === 'main' ? 'main' : (zone !== 'main' ? zone : (nextZone || zone));
      const ic = inContent || tag === 'main' || tag === 'article' || tag === 'section' || nextZone === 'main';
      if (tag === 'tr') {
        const row = simpleRow(child);
        flush(kind, zone, level);
        if (row) { blocks.push({ k: 'row', z, text: row }); continue; }
        walk(child, z, 'p', undefined, ic); flush('p', z);
        continue;
      }
      if (/^h[1-6]$/.test(tag)) {
        flush(kind, zone, level); walk(child, z, 'h', Number(tag[1]), ic); flush('h', z, Number(tag[1]));
        continue;
      }
      if (tag === 'li') {
        flush(kind, zone, level); walk(child, z, 'li', undefined, ic); flush('li', z);
        continue;
      }
      if (BLOCK.has(tag)) {
        flush(kind, zone, level);
        const inner = kind === 'li' || kind === 'h' ? kind : 'p';
        walk(child, z, inner, inner === 'h' ? level : undefined, ic); flush(inner, z, inner === 'h' ? level : undefined);
        continue;
      }
      boundary = true; walk(child, z, kind, level, ic); boundary = true; // inline element
    }
  };
  const body = $('body').get(0) || $.root().get(0);
  walk(body, 'main', 'p', undefined, false);
  flush('p', 'main');

  const mainChars = blocks.reduce((n, b) => n + (b.z === 'main' ? b.text.length : 0), 0);
  return { title, description, siteName, jsonld, links, blocks, mainChars };
}

/** PDF text arrives as loose lines. Short lines stay separate (labels, stats); wrapped prose is rejoined. */
function parsePdfText(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim());
  const blocks = [];
  let cur = '';
  const push = () => { if (cur) blocks.push({ k: 'p', z: 'main', text: cur }); cur = ''; };
  for (const line of lines) {
    if (!line) { push(); continue; }
    if (cur && cur.length >= 55 && !/[.!?:]$/.test(cur) ) { cur += ' ' + line; continue; }
    if (cur && /[,;]$/.test(cur)) { cur += ' ' + line; continue; }
    if (cur && /^[a-z(]/.test(line) && cur.length >= 30) { cur += ' ' + line; continue; }
    push(); cur = line;
  }
  push();
  return { title: '', description: '', siteName: '', jsonld: [], links: [], blocks, mainChars: blocks.reduce((n, b) => n + b.text.length, 0) };
}

module.exports = { parseHtml, parsePdfText, PARSER_VERSION };
