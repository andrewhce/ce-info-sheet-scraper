'use strict';
// Decides which pages of a school's website are worth reading, and reads them.
// Pages are chosen by the words in their link text and address (admissions, tuition,
// at a glance, visit ...), never by guessing addresses.
const { baseDomain, oneLine } = require('./util');

const TOPICS = [
  { key: 'facts', max: 3,
    text: /at a glance|fast facts|quick facts|by the numbers|facts (and|&) figures|school profile|key facts|fact sheet|^facts$/i,
    path: /at a glance|fast facts|quick facts|by the numbers|\bfacts\b|school profile|\bprofile\b/i },
  { key: 'about', max: 3,
    text: /^about( us)?$|^about [a-z .'&-]{2,40}$|who we are|our story|mission|our history|philosophy|^welcome/i,
    path: /\/about[^/]*\/?$|mission|who we are|our story|history|philosophy|welcome/i },
  { key: 'admissions', max: 5,
    text: /admissions?\b|^apply( now)?$|applying|enrollment\b|prospective (families|students|parents)/i,
    path: /admissions?[^/]*\/?$|\/apply[^/]*\/?$|enrollment\/?$/i },
  { key: 'process', max: 6, needsAdmissions: true,
    text: /how to apply|application (process|procedures?|requirements|checklist|steps|timeline|information)|admissions? (process|procedures?|requirements|timeline|checklist|steps)|steps to apply|apply(ing)? to|entrance exam|testing|interviews?\b|what we look for|grade[- ]level|entry (points|years)/i,
    path: /how to apply|application|process|procedure|requirements|checklist|\bsteps\b|testing|interview/i },
  { key: 'dates', max: 2, needsAdmissions: true,
    text: /important dates|key dates|deadlines?|admissions? (calendar|dates)|dates (and|&) deadlines/i,
    path: /important dates|key dates|deadline|timeline|dates/i },
  { key: 'tuition', max: 3,
    text: /tuition|affordab|financial (aid|assistance)|\bfees\b|cost of attendance/i,
    path: /tuition|afford|financial aid|financial assistance|\bfees\b/i },
  { key: 'visit', max: 4,
    text: /\bvisit(s|ing)?\b|open house|\btours?\b|admissions? events|information sessions?|info sessions?|shadow|preview day/i,
    path: /\bvisit|open house|\btours?\b|admissions? events|info session|information session|shadow/i },
  { key: 'academics', max: 3,
    text: /^academics?$|curriculum|course (catalog|of study|guide|offerings|descriptions)|program of studies|^(our )?(departments|disciplines|program)$/i,
    path: /\/academics?\/?$|curriculum|course|program of stud|departments|disciplines/i },
  { key: 'athletics', max: 2,
    text: /^athletics$|^sports$|teams|sports offered/i,
    path: /athletics\/?$|\bsports\b|\bteams\b/i },
  { key: 'college', max: 3,
    text: /college (counseling|guidance|matriculation|placement|acceptances?|list|destinations|advising)|matriculation|university (counseling|destinations|guidance)/i,
    path: /college|matriculation|university (counsel|guidance|destinations)/i },
  { key: 'transport', max: 2,
    text: /transportation|bus(es| service| routes)?\b|shuttle|getting (here|to)|commut/i,
    path: /transport|\bbus(es)?\b|shuttle|getting here|commut/i },
  { key: 'diversity', max: 1,
    text: /diversity|equity|inclusion|belonging|demographics/i,
    path: /diversity|equity|inclusion|\bdei\b|belonging/i },
  { key: 'faq', max: 2, needsAdmissions: true, text: /\bfaqs?\b|frequently asked/i, path: /\bfaqs?\b|frequently asked/i },
  { key: 'contact', max: 1, text: /^contact( us)?$|^directions$/i, path: /\/contact[^/]*\/?$/i },
];
const DEEP_TOPICS = new Set(['admissions', 'process', 'dates', 'tuition', 'visit', 'facts', 'faq', 'college']);

const NEGATIVE = /\bnews\b|\bblog\b|stories|\bstory\b|\bpress\b|alumn|giving|donate|annual fund|employment|careers|\bjobs\b|log ?in|sign ?in|\bstore\b|\bshop\b|summer|\bcamps?\b|after ?school|privacy|terms of|accessibility|sitemap|\bsearch\b|directory|magazine|podcast|gallery|\bphotos?\b|livestream|parents? (association|guild)|trustees|strategic plan|rental|covid|\/post\/|\/posts\/|\/event\/|\/calendar\/|\/tag\/|\/category\/|~board|pageid=|facebook|instagram|twitter|linkedin|youtube|vimeo/i;
const FILE_EXT = /\.(jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp[34]|mov|ics|css|js|xml|json|rss)($|\?)/i;
const PDF_WANTED = /profile|at[- _]a[- _]glance|fast[- _]?facts|quick[- _]?facts|fact[- _]?sheet|by[- _]the[- _]numbers|tuition|\bfees\b|admissions?[- _](guide|checklist|timeline|process)|important[- _]dates|bus[- _]routes|transportation|college[- _](list|matriculation)|matriculation/i;

const PORTALS = [
  ['Ravenna', /(^|\.)ravenna-hub\.com$/i],
  ['Gateway to Prep Schools', /gatewaytoprepschools\.com$/i],
  ['SSAT / Standard Application Online', /(^|\.)ssat\.org$/i],
  ['Blackbaud (myschoolapp)', /myschoolapp\.com$/i],
  ['Veracross', /veracross\.(com|eu)$/i],
  ['Finalsite Enrollment (SchoolAdmin)', /schooladmin\.com$|fsenrollment\.com$/i],
  ['OpenApply', /openapply\.(com|cn)$/i],
  ['TADS', /(^|\.)tads\.com$/i],
  ['FACTS', /factsmgt\.com$|renweb\.com$/i],
  ['Clarity', /clarityapp\.com$|claritytuition\.com$/i],
  ['PowerSchool', /powerschool\.com$/i],
  ['ISEE / ERB', /erblearn\.org$|iseetest\.org$/i],
  ['HSPT / STS', /ststesting\.com$/i],
  ['Kira Talent', /kiratalent\.com$/i],
];

function cleanStart(url) {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid)/i.test(k)) u.searchParams.delete(k);
  u.hash = '';
  return u.href;
}

function pathWords(u) {
  let p = u.pathname;
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  return p.toLowerCase().replace(/[-_+]/g, ' ');
}

function scoreLink(link, topic, ctx) {
  let u; try { u = new URL(link.url); } catch { return 0; }
  const text = link.text || '';
  const p = pathWords(u);
  let s = 0;
  if (text && topic.text.test(text)) s += 3;
  if (topic.path.test(p)) s += 2;
  if (!s) return 0;
  // "requirements", "dates", "FAQ" only count when they belong to admissions
  if (topic.needsAdmissions && !link.fromAdmissions && !/admission|apply|applying|applicant|enroll|prospective/i.test(text + ' ' + p)) return 0;
  if (NEGATIVE.test(p) || NEGATIVE.test(text)) s -= 4;
  const depth = p.split('/').filter(Boolean).length;
  s -= Math.max(0, depth - 3) * 0.5;
  if (u.search) s -= 1;
  if (text.length > 70) s -= 1;
  if (ctx.startPrefix && u.pathname.startsWith(ctx.startPrefix)) s += 2;
  if (link.fromAdmissions && DEEP_TOPICS.has(topic.key)) s += 1;
  return s;
}

function tagPage(page, picked) {
  const tags = new Set(picked || []);
  let u; try { u = new URL(page.finalUrl); } catch { return [...tags]; }
  const p = pathWords(u);
  const h1 = (page.blocks.find((b) => b.k === 'h' && b.z === 'main') || {}).text || '';
  const title = (page.title || '').split(/[|–—-]/)[0];
  for (const t of TOPICS) {
    if (t.path.test(p) || t.text.test(oneLine(h1)) || t.text.test(oneLine(title))) tags.add(t.key);
  }
  return [...tags];
}

/**
 * Crawl one website.
 * @returns {{status:string, detail:string|null, start:string, pages:object[], portals:object[], skipped:object[]}}
 */
async function crawlSite(startUrl, fetcher, cfg, emit = () => {}) {
  const maxPages = cfg.crawl.maxPagesPerSite, maxPdfs = cfg.crawl.maxPdfsPerSite;
  const start = cleanStart(startUrl);
  const pages = new Map();
  const tried = new Set();
  const skipped = [];
  const portals = new Map();
  const pool = new Map();           // url -> { url, text, fromAdmissions }
  const pdfPool = new Map();
  const out = (status, detail) => ({ status, detail: detail || null, start, pages: [...pages.values()], portals: [...portals.values()], skipped });

  const home = await fetcher.get(start);
  tried.add(start);
  if (!home.ok) {
    if (home.blocked) return out('blocked', home.error);
    if (home.robots) return out('robots', 'robots.txt does not allow reading this site');
    return out('error', home.error || 'could not load the website');
  }
  const homeUrl = new URL(home.finalUrl);
  const domain = baseDomain(homeUrl.hostname);
  const startPath = homeUrl.pathname.replace(/[^/]*$/, '');
  const ctx = { startPrefix: startPath.length > 1 ? startPath : null };
  const sameSite = (u) => baseDomain(u.hostname) === domain;

  const addPage = (page, picked) => {
    if (pages.has(page.finalUrl)) return false;
    page.topics = tagPage(page, picked);
    pages.set(page.finalUrl, page);
    tried.add(page.finalUrl);
    emit({ type: 'page', url: page.finalUrl, count: pages.size });
    const fromAdmissions = page.topics.some((t) => t === 'admissions' || t === 'process');
    for (const l of page.links || []) {
      let u; try { u = new URL(l.url); } catch { continue; }
      const portal = PORTALS.find(([, re]) => re.test(u.hostname));
      if (portal) {
        const key = u.hostname + u.pathname;
        if (!portals.has(key)) portals.set(key, { name: portal[0], url: l.url, linkText: l.text, foundOn: page.finalUrl });
        continue;
      }
      if (!sameSite(u)) {
        if (/^(apply|admissions?|portal|enroll)\./i.test(u.hostname) && !portals.has(u.hostname)) {
          portals.set(u.hostname, { name: 'Application site', url: l.url, linkText: l.text, foundOn: page.finalUrl });
        }
        continue;
      }
      if (/\.pdf($|\?)/i.test(u.pathname + u.search) || /\/(uploaded|fs\/resource-manager)\//i.test(u.pathname) && /pdf/i.test(u.href)) {
        if (!pdfPool.has(l.url)) pdfPool.set(l.url, { ...l, foundOn: page.finalUrl });
        continue;
      }
      if (FILE_EXT.test(u.pathname)) continue;
      const prev = pool.get(l.url);
      if (!prev) pool.set(l.url, { url: l.url, text: l.text, fromAdmissions });
      else { if (!prev.text && l.text) prev.text = l.text; prev.fromAdmissions = prev.fromAdmissions || fromAdmissions; }
    }
    return true;
  };

  addPage(home, ['home']);
  if (homeUrl.pathname !== '/' && pages.size < maxPages) {
    const root = await fetcher.get(homeUrl.origin + '/');
    tried.add(homeUrl.origin + '/');
    if (root.ok && sameSite(new URL(root.finalUrl))) addPage(root, ['home']);
  }

  const used = Object.fromEntries(TOPICS.map((t) => [t.key, 0]));
  const fetchPicks = async (bonus) => {
    const picks = [];
    for (const t of TOPICS) {
      const room = t.max + (bonus && DEEP_TOPICS.has(t.key) ? bonus : 0) - used[t.key];
      if (room <= 0) continue;
      const ranked = [...pool.values()]
        .filter((l) => !tried.has(l.url))
        .map((l) => ({ l, s: scoreLink(l, t, ctx) }))
        .filter((x) => x.s >= 2)
        .sort((a, b) => b.s - a.s || a.l.url.length - b.l.url.length || (a.l.url < b.l.url ? -1 : a.l.url > b.l.url ? 1 : 0))
        .slice(0, room);
      for (const { l } of ranked) {
        const hit = picks.find((p) => p.url === l.url);
        if (hit) hit.topics.push(t.key); else picks.push({ url: l.url, topics: [t.key] });
        used[t.key]++;
      }
    }
    let added = 0;
    // Pages are downloaded a few at a time, but they are always RECORDED in the order they were picked
    // (never in the order they happen to finish). Otherwise the same website could give a different page
    // order on every check, and a question answered on two pages would flip between them.
    while (picks.length && pages.size < maxPages) {
      const wave = picks.splice(0, maxPages - pages.size).filter((p) => !tried.has(p.url));
      for (const p of wave) tried.add(p.url);
      const got = new Array(wave.length);
      let next = 0;
      const runPick = async () => {
        for (;;) {
          const i = next++;
          if (i >= wave.length) return;
          got[i] = await fetcher.get(wave[i].url);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, wave.length) }, runPick));
      for (let i = 0; i < wave.length; i++) {
        const p = wave[i], page = got[i];
        if (!page.ok) { skipped.push({ url: p.url, reason: page.error || 'failed' }); continue; }
        let fu; try { fu = new URL(page.finalUrl); } catch { continue; }
        // a PDF linked from the school's site may be stored on its file host; that is still the school's document
        if (page.kind === 'pdf') { page.topics = ['pdf', ...p.topics]; if (!pages.has(page.finalUrl)) pages.set(page.finalUrl, page); continue; }
        if (!sameSite(fu)) { skipped.push({ url: p.url, reason: 'redirects to another site' }); continue; }
        if (addPage(page, p.topics)) added++;
      }
    }
    return added;
  };

  await fetchPicks(0);

  // menus drawn by JavaScript leave few links in the page: fall back to the sitemap
  if (pages.size < 6) {
    const sm = await fetcher.getText(homeUrl.origin + '/sitemap.xml');
    if (sm) {
      let locs = [...sm.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
      const children = locs.filter((l) => /\.xml($|\?)/i.test(l)).slice(0, 3);
      if (children.length) {
        locs = locs.filter((l) => !/\.xml($|\?)/i.test(l));
        const childTexts = await Promise.all(children.map((c) => fetcher.getText(c)));
        for (const t of childTexts) {
          if (t) locs.push(...[...t.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&')));
        }
      }
      for (const loc of locs.slice(0, 3000)) {
        let u; try { u = new URL(loc); } catch { continue; }
        if (!sameSite(u) || FILE_EXT.test(u.pathname) || pool.has(u.href)) continue;
        pool.set(u.href, { url: u.href, text: '', fromAdmissions: false });
      }
      await fetchPicks(0);
    }
  }

  // second pass: pages linked from the admissions pages (how to apply, dates, visits ...)
  if (pages.size < maxPages) await fetchPicks(2);

  // fact sheets and profiles are often PDFs
  const pdfs = [...pdfPool.values()]
    .map((l) => {
      let name = l.url; try { name = decodeURIComponent(new URL(l.url).pathname); } catch { /* keep */ }
      const hay = (l.text + ' ' + name).replace(/[-_]/g, ' ');
      let s = 0;
      if (PDF_WANTED.test(l.text)) s += 3;
      if (PDF_WANTED.test(name)) s += 2;
      if (/20(2[5-9])/.test(hay)) s += 1;
      if (/20(1\d|2[0-3])\b/.test(hay)) s -= 3;   // old school years
      if (NEGATIVE.test(hay)) s -= 3;
      return { l, s };
    })
    .filter((x) => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, maxPdfs);
  const pdfGot = await Promise.all(pdfs.map(async ({ l }) => {
    if (tried.has(l.url)) return null;
    tried.add(l.url);
    return { l, page: await fetcher.get(l.url) };
  }));
  for (const g of pdfGot) {                       // recorded in the order picked, not the order downloaded
    if (!g) continue;
    const { l, page } = g;
    if (!page.ok) { skipped.push({ url: l.url, reason: page.error || 'failed' }); continue; }
    page.topics = ['pdf', ...TOPICS.filter((t) => t.text.test(l.text) || t.path.test(l.url.replace(/[-_]/g, ' '))).map((t) => t.key)];
    page.linkText = l.text;
    if (!page.title) page.title = l.text || 'PDF';
    if (!pages.has(page.finalUrl)) { pages.set(page.finalUrl, page); emit({ type: 'page', url: page.finalUrl, count: pages.size }); }
  }

  const textChars = [...pages.values()].reduce((n, p) => n + (p.mainChars || 0), 0);
  if (pages.size <= 2 && textChars < 1500) {
    return out('thin', 'the site shows almost no text without JavaScript, so there was nothing to read');
  }
  return out('ok', null);
}

module.exports = { crawlSite, TOPICS, PORTALS, cleanStart };
