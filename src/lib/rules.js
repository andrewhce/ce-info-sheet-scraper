'use strict';
// The field rules: one small rule per row of the Master Template.
// Rules only match patterns in the school's own words. Nothing is inferred or written by AI,
// and every answer carries the page link and the exact text it was taken from.
const { oneLine, clip } = require('./util');
const { buildIndex, splitSentences } = require('./textindex');

// ----------------------------------------------------------------- helpers ---

const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const WORDNUM_RE = Object.keys(WORDNUM).join('|');
const toNum = (s) => (WORDNUM[String(s).toLowerCase()] != null ? WORDNUM[String(s).toLowerCase()] : Number(String(s).replace(/[^\d.]/g, '')));

const DIV_WORDS = {
  lower: /lower school|lower division|elementary|primary school|junior school|early childhood/i,
  middle: /middle school|middle division|junior high/i,
  upper: /upper school|upper division|high school|secondary school/i,
};
const BANDS = { lower: [-1, 5], middle: [6, 8], upper: [9, 12] };
const GT = '(?:pre-?k(?:indergarten)?|pk|tk|jk|k(?:indergarten)?|\\d{1,2}(?:st|nd|rd|th)?)';
const SEP = '\\s*(?:-|\\u2013|\\u2014|to|through|thru)\\s*';
const GRADE_RES = [
  new RegExp(`\\bgrades?\\s*(${GT})${SEP}(${GT})\\b`, 'gi'),
  new RegExp(`\\b(pre-?k(?:indergarten)?|pk|tk|jk|k(?:indergarten)?)${SEP}(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?${SEP}(\\d{1,2})(?:st|nd|rd|th)?\\s+grades?\\b`, 'gi'),
];
function gradeNum(g) {
  g = String(g).toLowerCase();
  if (/^(pk|pre-?k|pre-?kindergarten|jk)$/.test(g)) return -1;
  if (/^(tk|k|kindergarten)$/.test(g)) return 0;
  const n = parseInt(g, 10);
  return isNaN(n) || n > 12 || n < 1 ? null : n;
}
function gradeSpans(text) {
  const out = [];
  for (const re of GRADE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const a = gradeNum(m[1]), b = gradeNum(m[2]);
      if (a == null || b == null || b <= a) continue;
      out.push({ min: a, max: b, raw: m[0] });
    }
  }
  return out;
}
const fmtGrade = (n) => (n === -1 ? 'PK' : n === 0 ? 'K' : String(n));

/** +1 when the text is about this school's division, -1 when it is clearly about another one. */
function divisionFit(text, division) {
  if (!division) return 0;
  if (DIV_WORDS[division].test(text)) return 1;
  const spans = gradeSpans(text);
  if (spans.length) {
    const [lo, hi] = BANDS[division];
    if (spans.some((s) => s.min >= lo && s.max <= hi)) return 1;
    if (!spans.some((s) => s.min <= hi && s.max >= lo)) return -1;
    return 0;
  }
  return Object.keys(DIV_WORDS).some((d) => d !== division && DIV_WORDS[d].test(text)) ? -1 : 0;
}

function weightOf(page, weights) {
  let w = weights._ != null ? weights._ : 0;
  for (const t of page.topics || []) if (weights[t] != null && weights[t] > w) w = weights[t];
  return w;
}

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_RE = new RegExp(`\\b(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-\\u2013]\\s*\\d{1,2}(?:st|nd|rd|th)?)?(?:,?\\s+(20\\d{2}))?\\b`, 'g');
const MONTH_IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function findDates(text) {
  const out = [];
  DATE_RE.lastIndex = 0;
  let m;
  while ((m = DATE_RE.exec(text))) {
    const day = Number(m[2]);
    if (day < 1 || day > 31) continue;
    const mi = MONTH_IDX[m[1].slice(0, 3).toLowerCase()];
    const year = m[3] ? Number(m[3]) : null;
    out.push({ raw: m[0], year, date: year ? new Date(Date.UTC(year, mi, day)) : null, index: m.index });
  }
  return out;
}
/** Admission cycles turn over on July 1. A dated line from before that is last year's. */
function cycleStart(now) {
  const y = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return new Date(Date.UTC(y, 6, 1));
}
function isStale(dates, now) {
  const dated = dates.filter((d) => d.date);
  return dated.length > 0 && dated.every((d) => d.date < cycleStart(now));
}

function mk(value, item, score, confidence, extra) {
  return {
    value: String(value), score, confidence,
    snippet: clip(oneLine(item.text), 460), url: item.page.finalUrl, title: item.page.title || item.page.linkText || '',
    ...(extra || {}),
  };
}

/** Best candidate wins; the next few distinct ones are kept as "other matches". */
function best(cands, opts) {
  if (!cands.length) return { status: 'none' };
  cands.sort((a, b) => b.score - a.score);
  const uniq = [];
  for (const c of cands) {
    const k = (c.key || c.value).toLowerCase().replace(/[\s,]+/g, ' ').trim();
    const hit = uniq.find((u) => u.k === k);
    if (hit) { hit.count++; continue; }
    uniq.push({ ...c, k, count: 1 });
  }
  const b = uniq[0];
  const r = { status: 'found', value: b.value, confidence: b.confidence || 'medium', sources: [{ url: b.url, title: b.title }], snippet: b.snippet };
  if (b.note) r.note = b.note;
  if (b.num != null) r.num = b.num;
  if (b.count > 1) r.seen = b.count;
  const alts = uniq.slice(1, 4).map((a) => ({ value: a.value, url: a.url, snippet: a.snippet }));
  if (alts.length) r.alts = alts;
  // two different answers with nearly the same weight: the school's own pages disagree, so a person should look
  if (opts && opts.conflict && uniq[1] && uniq[1].score >= b.score - 1.5) {
    r.confidence = 'medium';
    r.note = (r.note ? r.note + ' ' : '') + `The site also says ${uniq[1].value} (see other matches), so its own pages do not agree. Check which is current.`;
  }
  return r;
}

/** "More than 80%", "Over 2,200", "nearly 6,000": the school's own hedge word just before a number, kept with the value. */
function qualifierBefore(text, at) {
  const m = /\b(more than|over|nearly|almost|approximately|about|around|roughly|at least|up to|under|fewer than|just over|just under)\s*$|(~)\s*$/i.exec(text.slice(Math.max(0, at - 22), at));
  if (!m) return '';
  const q = m[1] || '~';
  return q === '~' ? '~' : q[0].toUpperCase() + q.slice(1).toLowerCase();
}

/** Several short lines make up the answer (tuition table rows, dated lines ...). */
function lines(cands, max, confidence, note) {
  if (!cands.length) return { status: 'none' };
  cands.sort((a, b) => b.score - a.score);
  const seen = new Set(), keep = [];
  for (const c of cands) {
    const k = (c.key || c.value).toLowerCase().replace(/[^a-z0-9$%]+/g, ' ').trim();
    if (seen.has(k) || [...seen].some((s) => s.includes(k) || k.includes(s))) continue;
    seen.add(k); keep.push(c);
    if (keep.length >= max) break;
  }
  if (keep.some((c) => c.order != null)) keep.sort((a, b) => (a.order || 0) - (b.order || 0));
  const sources = [];
  for (const c of keep) if (!sources.some((s) => s.url === c.url)) sources.push({ url: c.url, title: c.title });
  const r = { status: 'found', value: keep.map((c) => c.value).join('\n'), confidence: confidence || 'medium', sources: sources.slice(0, 4), snippet: keep.map((c) => c.snippet).slice(0, 3).join(' … ') };
  const n = note || (keep.find((c) => c.note) || {}).note;
  if (n) r.note = n;
  return r;
}

function scan(items, re, weights, fn) {
  const out = [];
  for (const it of items) {
    const w = weightOf(it.page, weights);
    if (!w) continue;
    re.lastIndex = 0;
    const m = re.exec(it.text);
    if (!m) continue;
    const c = fn(m, it, w);
    if (c) out.push(c);
  }
  return out;
}

const yearish = (n, text, idx) => n >= 1990 && n <= 2040 && /^\s*[-–/]\s*\d{2,4}/.test(text.slice(idx)) ;

// ------------------------------------------------------------------- rules ---

const TYPE_WORDS = [
  ['Independent', /\bindependent\b/i], ['Private', /\bprivate\b/i],
  ['Co-ed', /\bco-?ed\b|\bco-?educational\b/i],
  ['All Girls', /\ball[- ]girls?\b|\bgirls['’]? school\b|\bschool for girls\b|\bfor girls\b/i],
  ['All Boys', /\ball[- ]boys?\b|\bboys['’]? school\b|\bschool for boys\b|\bfor boys\b/i],
  ['Day School', /\bday school\b/i], ['Boarding', /\bboarding\b/i],
  ['College Preparatory', /\bcollege[- ]prep(aratory)?\b/i],
  ['Catholic', /\bcatholic\b/i], ['Jesuit', /\bjesuit\b/i], ['Episcopal', /\bepiscopal\b/i],
  ['Christian', /\bchristian\b/i], ['Jewish', /\bjewish\b/i], ['Quaker', /\bquaker\b|\bfriends school\b/i],
  ['Lutheran', /\blutheran\b/i], ['Montessori', /\bmontessori\b/i], ['Waldorf', /\bwaldorf\b/i],
  ['Charter', /\bcharter school\b|\bpublic charter\b/i],
  ['International Baccalaureate', /\binternational baccalaureate\b|\bIB (World School|Diploma)\b/],
  ['International', /\binternational school\b/i], ['Online', /\bonline (school|high school|independent school)\b/i],
  ['Nonsectarian', /\bnon-?sectarian\b|\bnon-?denominational\b/i],
];
const SPORTS = [
  ['Badminton', /\bbadminton\b/i], ['Baseball', /\bbaseball\b/i], ['Basketball', /\bbasketball\b/i],
  ['Cheer', /\bcheer(leading)?\b/i], ['Crew / Rowing', /\bcrew\b|\browing\b/i], ['Cross Country', /\bcross[- ]country\b/i],
  ['Dance', /\bdance team\b|\bdance\b/i], ['Diving', /\bdiving\b/i], ['Equestrian', /\bequestrian\b/i],
  ['Fencing', /\bfencing\b/i], ['Field Hockey', /\bfield hockey\b/i], ['Flag Football', /\bflag football\b/i],
  ['Football', /(?<!flag )\bfootball\b/i], ['Golf', /\bgolf\b/i], ['Gymnastics', /\bgymnastics\b/i],
  ['Ice Hockey', /\bice hockey\b|(?<!field )\bhockey\b/i], ['Lacrosse', /\blacrosse\b/i], ['Sailing', /\bsailing\b/i],
  ['Skiing', /\bskiing\b|\bski team\b/i], ['Soccer', /\bsoccer\b/i], ['Softball', /\bsoftball\b/i],
  ['Squash', /\bsquash\b/i], ['Swimming', /\bswim(ming)?\b/i], ['Tennis', /\btennis\b/i],
  ['Track and Field', /\btrack\s*(and|&)\s*field\b|\btrack\b/i], ['Ultimate', /\bultimate( frisbee)?\b/i],
  ['Volleyball', /\bvolleyball\b/i], ['Water Polo', /\bwater polo\b/i], ['Wrestling', /\bwrestling\b/i],
  ['Rugby', /\brugby\b/i], ['Mountain Biking', /\bmountain biking\b/i], ['Climbing', /\bclimbing\b/i],
  ['Archery', /\barchery\b/i], ['Bowling', /\bbowling\b/i], ['Surfing', /\bsurf(ing)?\b/i],
  ['Esports', /\be-?sports\b/i], ['Cricket', /\bcricket\b/i], ['Netball', /\bnetball\b/i],
];
const DEPT_RE = /^(the )?(english|history|math(ematics)?|science|sciences|world languages?|modern languages?|classical languages?|languages|classics|computer science|engineering|computer science (and|&) engineering|visual arts?|performing arts?|visual (and|&) performing arts|fine arts|arts|music|theat(er|re)|drama|dance|physical education|health|wellness|health (and|&) wellness|fitness (and|&) wellness|religio(n|us studies)|theology|social studies|social sciences?|history (and|&) social sciences?|humanities|economics|philosophy|psychology|interdisciplinary studies|stem|library)( department)?$/i;
const ORGS = [
  ['NAIS', /\bNAIS\b|National Association of Independent Schools/], ['CAIS', /\bCAIS\b|California Association of Independent Schools/],
  ['WASC', /\bWASC\b|Western Association of Schools and Colleges/], ['NEASC', /\bNEASC\b|New England Association of Schools/],
  ['TABS', /\bTABS\b|The Association of Boarding Schools/], ['NWAIS', /\bNWAIS\b|Northwest Association of Independent Schools/],
  ['ISAS', /\bISAS\b|Independent Schools Association of the Southwest/], ['NYSAIS', /\bNYSAIS\b|New York State Association of Independent Schools/],
  ['AISNE', /\bAISNE\b|Association of Independent Schools in New England/], ['Middle States Association', /Middle States Association/],
  ['Council of International Schools', /Council of International Schools/], ['International Baccalaureate', /International Baccalaureate/],
  ['Cum Laude Society', /Cum Laude Society/], ['One Schoolhouse', /One Schoolhouse/],
  ['International Coalition of Girls’ Schools', /International Coalition of Girls.? Schools|\bICGS\b|National Coalition of Girls.? Schools/],
  ['International Boys’ Schools Coalition', /International Boys.? Schools Coalition|\bIBSC\b/], ['Round Square', /Round Square/],
  ['Global Online Academy', /Global Online Academy/], ['Jesuit Schools Network', /Jesuit Schools Network/],
  ['WCEA', /\bWCEA\b|Western Catholic Educational Association/], ['NCEA', /\bNCEA\b|National Catholic Educational Association/],
  ['Enrollment Management Association', /Enrollment Management Association/], ['ERB', /Educational Records Bureau/],
  ['A Better Chance', /A Better Chance/], ['HAIS', /Hawaii Association of Independent Schools/],
  ['AIMS', /Association of Independent Maryland|Association of Independent Schools of Greater Washington|\bAISGW\b/],
  ['NJAIS', /\bNJAIS\b|New Jersey Association of Independent Schools/], ['CAIS (Connecticut)', /Connecticut Association of Independent Schools/],
  ['Cognia', /\bCognia\b/], ['ACSI', /Association of Christian Schools International/], ['AMS', /American Montessori Society/],
  ['AWSNA', /Association of Waldorf Schools of North America|\bAWSNA\b/],
];

const W = {
  facts: { facts: 3, pdf: 2.5, about: 2, home: 2, admissions: 1.5, _: 0.4 },
  admissions: { process: 3, admissions: 2.5, dates: 2.5, faq: 2, visit: 1.5, home: 0.5 },
};

function rSchoolType(c) {
  const items = [...c.metas, ...c.idx.sentences];
  const out = [];
  for (const it of items) {
    const w = weightOf(it.page, { home: 2.5, about: 3, facts: 3, admissions: 1.5, pdf: 1.5, _: 0.4 });
    if (!w || it.text.length > 420) continue;
    if (!/\b(school|academy)\b/i.test(it.text)) continue;
    if (!/\bis (a|an|the)\b|\bas (a|an)\b|, (a|an) |\bwe are (a|an)\b|^(a|an) /i.test(it.text)) continue;
    const hits = TYPE_WORDS.filter(([, re]) => re.test(it.text)).map(([n]) => n);
    if (hits.length < 2) continue;
    out.push(mk(hits.join(' | '), it, hits.length * 1.5 + w + (it.meta ? 0.5 : 0), hits.length >= 3 ? 'medium' : 'low'));
  }
  return best(out);
}

const ADDR_RE = /\b(\d{1,5}(?:-\d{1,5})?\s+(?:[A-Za-z0-9.'’#-]+\s){0,5}?(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Place|Pl|Court|Ct|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Terrace|Square|Trail|Real|Broadway|Alameda|Row|Path|Pike|Turnpike)\b\.?(?:\s+(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)\b\.?)?(?:,?\s*(?:Suite|Ste\.?|Unit|#)\s*[\w-]+)?)\s*[,|•·]?\s*([A-Z][A-Za-z.'’-]+(?:\s[A-Z][A-Za-z.'’-]+){0,3}),?\s+(A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY]|California|New York|Washington|Texas|Massachusetts|Connecticut|New Jersey|Hawaii|Florida|New Hampshire|Virginia|Maryland)\.?,?\s+(\d{5})(?:-\d{4})?\b/g;

function rLocation(c) {
  const tally = new Map();
  const add = (value, key, item, pts, conf) => {
    const t = tally.get(key) || { value, item, pts: 0, n: 0, conf };
    t.pts += pts; t.n++; tally.set(key, t);
  };
  for (const page of c.pages) {
    for (const node of page.jsonld || []) {
      const a = node && node.address;
      if (/hotel|lodging|restaurant|foodestablishment|cafe|store/i.test(JSON.stringify(node && node['@type'] || ''))) continue;
      if (a && typeof a === 'object' && a.streetAddress) {
        const value = [a.streetAddress, a.addressLocality, [a.addressRegion, a.postalCode].filter(Boolean).join(' '), a.addressCountry && typeof a.addressCountry === 'string' && !/^(US|USA|United States)$/i.test(a.addressCountry) ? a.addressCountry : null].filter(Boolean).map(oneLine).join(', ');
        add(value, 'ld:' + oneLine(a.streetAddress).toLowerCase(), { text: value, page }, 6, 'high');
      }
    }
    for (const b of page.blocks || []) {
      if (!/\d{5}/.test(b.text)) continue;
      const flat = b.text.replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ');
      ADDR_RE.lastIndex = 0;
      let m;
      while ((m = ADDR_RE.exec(flat))) {
        const value = `${m[1].trim().replace(/,$/, '')}, ${m[2].trim()}, ${m[3]} ${m[4]}`;
        const around = flat.slice(Math.max(0, m.index - 90), m.index + m[0].length + 30);
        // visitor pages list hotels and restaurants near the campus: those addresses are not the school's
        if (/\b(?:hotel|inn|motel|lodging|resort|marriott|hilton|hyatt|holiday inn|best western|airbnb|bed (?:and|&) breakfast|restaurants?|caf[eé]|pizza|diner|parking|shuttle|\d+(?:\.\d+)? (?:mi|miles?|km) (?:from|away))(?![a-z])|\(\d+(?:\.\d+)? mi\.?\)/i.test(around)) continue;
        const key = m[1].replace(/\D+/g, ' ').trim().split(' ')[0] + ':' + m[4];
        add(value, key, { text: around, page }, b.z === 'footer' ? 1 : 0.7, 'medium');
        // a school with several campuses: the address labelled with this division wins
        const fit = divisionFit(around, c.school.division);
        const t = tally.get(key);
        if (fit > 0 && !t.fit) { t.fit = 1; t.item = { text: around, page }; }
        else if (fit < 0 && t.fit == null) t.fit = -1;
      }
    }
  }
  const region = (c.school.region || '').toLowerCase();
  const many = [...tally.values()].filter((t) => t.n >= 3 || t.conf === 'high').length > 1; // several real campus addresses
  const out = [...tally.values()].map((t) => {
    const city = (t.value.split(',')[1] || '').trim().toLowerCase();
    const bonus = (city && region.includes(city) ? 3 : 0) + (t.fit > 0 ? 6 : 0);
    const notes = [];
    if (t.n > 1) notes.push(`seen on ${t.n} pages`);
    if (many && c.school.division && !(t.fit > 0)) notes.push('the site lists more than one address; check which campus this division uses');
    return mk(t.value, t.item, Math.min(t.pts, 8) + bonus, t.conf === 'high' || t.n >= 3 ? 'high' : 'medium', notes.length ? { note: notes.join('; ') } : null);
  });
  return best(out);
}

function rGrades(c) {
  const tally = new Map();
  const items = [...c.metas, ...c.idx.phrases, ...c.idx.sentences];
  for (const it of items) {
    // course catalogs, tuition and aid pages mention grade ranges for other reasons, so they are left out
    let w = weightOf(it.page, { home: 2, about: 2, facts: 3, admissions: 1.5, process: 1, pdf: 1.5 });
    if (!w) continue;
    const t = it.text;
    // grade ranges also turn up in admissions steps ("transcripts for grades 7-8", "applicants to grades 9-11"),
    // which say nothing about the grades the school teaches
    if (/applicants?|applying|appl(y|ication)|open to|prerequisite|incidents|eligible|transfer|siblings|schools in|tuition|\baid\b|transcripts?|records?|report cards?|decisions?|visit|shadow|open house|events?|sessions?|tours?|entering|rising|prospective|test(ing|s)?\b|recommendation/i.test(t)) continue;
    if (it.meta || t.length <= 40 || /\b(serv(es|ing)|educat(es|ing)|enroll(s|ing)|school for|students in|is an?|are an?|offers?)\b/i.test(t)) w *= 1.5;
    else w *= 0.5;
    for (const s of gradeSpans(t)) {
      const key = s.min + ':' + s.max;
      const e = tally.get(key) || { s, item: it, pts: 0, n: 0, top: 0, named: false };
      e.pts += w; e.n++;
      const named = !!c.school.division && DIV_WORDS[c.school.division].test(t);
      if (named && !e.named) { e.named = true; e.item = it; e.top = Infinity; }
      if (w > e.top) { e.top = w; e.item = it; }
      tally.set(key, e);
    }
  }
  const div = c.school.division;
  const out = [];
  for (const t of tally.values()) {
    if (t.pts < 1) continue; // one passing mention is not enough
    let score = Math.min(t.pts, 9);
    let note = `written as “${t.s.raw}”` + (t.n > 1 ? `, seen ${t.n} times` : '');
    let conf = t.n >= 3 ? 'high' : 'medium';
    if (div) {
      const [lo, hi] = BANDS[div];
      if (t.s.min > hi || t.s.max < lo) continue;               // another division's range
      if (t.named) score += 6;                                    // "Upper School ... grades 9-12"
      else if (t.s.min >= lo && t.s.max <= hi) { score += 1 + (t.s.max - t.s.min) * 0.5; conf = 'low'; note += '. The page does not name this division next to the range, so check it.'; }
      else { conf = 'low'; note += '. This is wider than one division, so it is probably the whole school’s range.'; }
    } else score += (t.s.max - t.s.min) * 0.15;
    out.push(mk(`${fmtGrade(t.s.min)}–${fmtGrade(t.s.max)}`, t.item, score, conf, { note }));
  }
  return best(out);
}

function rEnrollment(c) {
  const div = c.school.division;
  const out = [];
  const push = (numStr, it, base, w, text, idx) => {
    const n = toNum(numStr);
    if (!(n >= 40 && n <= 6000) || yearish(n, text, idx)) return;
    const at = text.lastIndexOf(numStr, idx);
    // "Enrollment Deposit $3,000.00", "Enrollment Fee of $100", "per enrollment level 46%": money and percentages are not headcounts
    if (at >= 0) {
      const gap = text.slice(Math.max(0, at - 40), at);
      const after = text.slice(at + numStr.length, at + numStr.length + 12);
      if (/\$\s*$|\b(?:USD|CHF|EUR|GBP)\s*$/i.test(gap) || /^\.\d{2}\b|^\s*%|^\s*percent/i.test(after)) return;
      // "62 Class of 2026 students recognized as National Merit Finalists": a graduating year, not a headcount
      if (!numStr.includes(',') && n >= 1990 && n <= 2040 && /(?:class(?:es)? of|\bof|\bin|\bsince|\bby|\bfor|\bfall|\bspring)\s*$/i.test(gap)) return;
      if (/\b(?:deposit|fees?|tuition|cost|costs|due|deadline|dates?|level|levels|options?|agreement|contract|forms?|process|period|policy|capacity|limit|re-?)\b[^\d]{0,25}$/i.test(gap) && /enroll/i.test(gap)) return;
    }
    const fit = divisionFit(it.text, div);
    if (fit < 0) return; // a number stated for another division is not this school's number
    let score = base + w + fit * 2;
    if (!div && /\btotal\b|\bK-12\b|school-?wide|\ball\b/i.test(it.text)) score += 1.5;
    if (!div && Object.values(DIV_WORDS).some((re) => re.test(it.text))) score -= 1.5;
    const q = at >= 0 ? qualifierBefore(text, at) : '';
    out.push(mk(q ? `${q} ${numStr}` : numStr, it, score, base >= 4 ? 'high' : 'medium', {
      num: n, key: numStr, note: div && fit === 0 ? 'The page does not say which division this number covers. It may be the whole school.' : undefined,
    }));
  };
  // "108 students" on its own proves nothing (it could be a class, a club, a test sitting).
  // A bare count only counts as enrollment when it is the number of a stat tile, or a short stand-alone fact.
  const NOT_ENROLL = '(?!\\s+(?:of color|per|receive|participat|play|take|who|in each|from|identify|have|are|speak|on financial|to|attend|enroll in|earn|scored|tested|took|passed|graduat|applied|accepted|admitted|qualif))';
  const KIND = '(?:total\\s+|enrolled\\s+)?(?:(?:lower|middle|upper|high) school\\s+|day\\s+|boarding\\s+|K-12\\s+)?students\\b';
  const E1 = /(?<!\bre-?)\b(?:total\s+|student\s+|current\s+|school\s+|overall\s+)*enrollment\b[^\d]{0,25}?([\d,]{2,6})\b/i;
  const E2 = new RegExp(`(?:^|[^\\d$,.:\\u2013-])([\\d,]{2,6})\\+?\\s+${KIND}${NOT_ENROLL}`, 'i');
  const E2_TILE = new RegExp(`^([\\d,]{2,6})\\+?\\s+${KIND}${NOT_ENROLL}`, 'i');
  const E3 = /\b(?:enroll(?:s|ing|ment of)?|educat(?:es|ing)|serv(?:es|ing)|home to|community of|student body of|student population of)\s+(?:approximately |about |nearly |over |more than |roughly |some )?([\d,]{2,6})\s+(?:[a-z-]+\s){0,3}students\b/i;
  for (const it of c.idx.phrases) {
    const w = weightOf(it.page, W.facts);
    if (!w) continue;
    let m;
    if ((m = E1.exec(it.text))) push(m[1], it, 5, w, it.text, m.index + m[0].length);
    else if ((it.form === 'A' || it.form === 'C') && (m = E2_TILE.exec(`${it.num} ${it.after}`))) push(m[1], it, 4, w, it.text, 0);
    else if (it.form === 'S' && ((it.page.kind !== 'pdf' && it.text.length <= 70) || /enroll|student body|total/i.test(it.text)) && (m = E2.exec(it.text))) push(m[1], it, 4, w, it.text, m.index + m[0].length);
  }
  for (const it of c.idx.sentences) {
    const w = weightOf(it.page, W.facts);
    if (!w) continue;
    let m;
    if ((m = E3.exec(it.text))) push(m[1], it, 4, w, it.text, m.index + m[0].length);
    else if ((m = E1.exec(it.text))) push(m[1], it, 3, w, it.text, m.index + m[0].length);
  }
  return best(out);
}

function rClassSize(c) {
  // (?<![\d.,:$]) and (?!\s*:\s*\d) keep the rule from reading part of "416" or the "6" of a "6:1" ratio
  const N = '(?<![\\d.,:$])(\\d{1,2})(?![\\d%]|\\s*:\\s*\\d)';
  const R1 = new RegExp(`\\b(?:average|typical|median|mean)\\s+class sizes?\\b[^\\d]{0,25}?${N}(?:\\s*(?:-|\\u2013|to)\\s*(\\d{1,2}))?`, 'i');
  const R2 = new RegExp(`${N}(?:\\s*(?:-|\\u2013|to)\\s*(\\d{1,2}))?\\s*(?:students?\\s*)?(?:\\(?(?:on )?average\\)?\\s*)?(?:is (?:the|our) )?(?:average |typical |median )class sizes?`, 'i');
  const R3 = new RegExp(`\\bclass sizes?\\b[^\\d.]{0,30}?${N}`, 'i');
  // "average class sizes are: K-5: 15-22; grades 6-8: 16-18; grades 9-12: 14-15"
  const SEG = new RegExp(`(?:grades?\\s*)?(${GT})\\s*[-\\u2013]\\s*(\\d{1,2})\\s*:\\s*(\\d{1,2})(?:\\s*[-\\u2013]\\s*(\\d{1,2}))?`, 'gi');
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { ...W.facts, academics: 1.5, faq: 1.5 });
    if (!w) continue;
    if (/class sizes?/i.test(it.text)) {
      const segs = [...it.text.matchAll(SEG)].map((s) => ({ min: gradeNum(s[1]), max: gradeNum(s[2]), a: s[3], b: s[4], raw: s[0] })).filter((s) => s.min != null && s.max != null && s.max > s.min);
      if (segs.length >= 2) {
        const div = c.school.division;
        const mine = div ? segs.filter((s) => s.min >= BANDS[div][0] && s.max <= BANDS[div][1]) : [];
        if (mine.length === 1) out.push(mk(mine[0].b ? `${mine[0].a}–${mine[0].b}` : mine[0].a, it, 6 + w, 'high', { num: Number(mine[0].a), note: `The page lists class size by grade band; this is the band “${mine[0].raw}”.` }));
        else out.push(mk(segs.map((s) => s.raw).join('; '), it, 5 + w, 'medium'));
        continue;
      }
    }
    let m, base = 0;
    if ((m = R1.exec(it.text))) base = 5; else if ((m = R2.exec(it.text))) base = 4; else if ((m = R3.exec(it.text))) base = 2;
    if (!m) continue;
    const n = Number(m[1]);
    if (!(n >= 4 && n <= 40)) continue;
    const fit = divisionFit(it.text, c.school.division);
    if (fit < 0) continue;
    out.push(mk(m[2] ? `${m[1]}–${m[2]}` : m[1], it, base + w + fit * 2, base >= 4 ? 'high' : 'medium', { num: n }));
  }
  return best(out);
}

function rRatio(c) {
  const R = /(\d{1,2})\s*(?::|\bto\b|-to-)\s*(\d{1,2})\b/i;
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { ...W.facts, academics: 1.5 });
    if (!w || !/ratio/i.test(it.text) || !/student|teacher|faculty/i.test(it.text) || /counsel/i.test(it.text)) continue;
    // a ratio for a paid or add-on service ("Guided Study Hall | $5,300 | 4:1 student to faculty ratio of academic support") is not the school's
    if (/\$\s*\d|\b(?:fees?|costs?|tuition|price|study hall|tutor(?:ing)?|academic support|summer|camps?|after-?school|add-on|private lessons?|clinic)\b/i.test(it.text)) continue;
    const m = R.exec(it.text);
    if (!m) continue;
    const a = Number(m[1]), b = Number(m[2]);
    if (Math.min(a, b) !== 1 && !(Math.max(a, b) <= 25)) continue;
    if (Math.max(a, b) > 30 || Math.max(a, b) < 2) continue;
    const fit = divisionFit(it.text, c.school.division);
    if (fit < 0) continue;
    out.push(mk(`${m[1]}:${m[2]}`, it, 4 + w + fit * 2, 'high', { num: Math.max(a, b) / Math.min(a, b), key: `${Math.max(a, b)}:${Math.min(a, b)}` }));
  }
  return best(out, { conflict: true });
}

function rCounselors(c) {
  const R = new RegExp(`\\b(\\d{1,2}|${WORDNUM_RE})\\s+(?:full[- ]time\\s+|dedicated\\s+|experienced\\s+)?college (?:counselors|advisors)\\b`, 'i');
  const out = scan([...c.idx.phrases, ...c.idx.sentences], R, { college: 3, facts: 2.5, pdf: 2.5, academics: 1, _: 0.4 }, (m, it, w) => {
    const n = toNum(m[1]);
    if (!(n >= 1 && n <= 25)) return null;
    return mk(String(n), it, 5 + w, 'high', { num: n });
  });
  if (out.length) return best(out);
  // fallback: job titles on the college counseling pages
  const titles = [];
  for (const page of c.pages) {
    if (!(page.topics || []).includes('college')) continue;
    for (const b of page.blocks || []) {
      if (b.z !== 'main') continue;
      const t = oneLine(b.text);
      // a line that IS a job title ("Jane Doe, Associate Director of College Counseling"), not a sentence about one
      if (t.length > 95 || /[.!?]$/.test(t) || /^(message|meet|contact|about|welcome|from|by|our|the|learn|college counseling)\b/i.test(t)) continue;
      if (!/^(?:[A-Z][\w.'’-]+(?: [A-Z][\w.'’-]+){0,3}\s*[,:–—|-]\s*)?(?:(?:senior |associate |assistant |co-)*(?:director|dean|counselor|advisor)\b[^.]{0,50}\bcollege (?:counseling|guidance|advising)\b|college (?:counselor|advisor)\b)/i.test(t)) continue;
      const key = t.toLowerCase().replace(/\S+@\S+/g, '').replace(/[^a-z]+/g, ' ').trim();
      if (!titles.some((x) => x.key === key)) titles.push({ t, key, page });
    }
  }
  if (titles.length < 1) return { status: 'none' };
  return {
    status: 'found', confidence: 'low',
    value: `${titles.length} job-title line${titles.length === 1 ? '' : 's'} on the college counseling pages:\n` + titles.slice(0, 10).map((x) => x.t).join('\n'),
    sources: [{ url: titles[0].page.finalUrl, title: titles[0].page.title }],
    snippet: titles.slice(0, 4).map((x) => x.t).join(' … '),
    note: 'Counted from job titles, not a stated number. Check the page for names.',
  };
}

function rAdvanced(c) {
  const KIND = '(?:AP|Advanced Placement|honors|advanced|post-AP|IB|accelerated|Advanced Topics?|college-level)';
  const R1 = new RegExp(`(?<![\\d.,:$])(\\d{1,3})\\+?\\s+(${KIND})(?:\\s*\\([A-Z]+\\))?(?:[ ,/&]+(?:and\\s+)?${KIND})*\\s+(?:level\\s+)?(?:courses|classes|subjects|offerings|electives)\\b`, 'i');
  // "23 AP and 14 Honors courses": two counts sharing one noun
  const R0 = new RegExp(`(?<![\\d.,:$])(\\d{1,3})\\+?\\s+(${KIND})s?\\s*(?:,|and|&)\\s*(\\d{1,3})\\+?\\s+${KIND}\\s+(?:courses|classes)\\b`, 'i');
  const R2 = new RegExp(`\\b(${KIND})\\s+(?:courses|classes)(?:\\s+offered)?\\s*:?\\s*(\\d{1,3})\\b(?!\\s*%)`, 'i');
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { facts: 3, pdf: 2.5, academics: 2.5, college: 1.5, about: 1.5, home: 1, _: 0.3 });
    if (!w) continue;
    const fit = divisionFit(it.text, c.school.division);
    if (fit < 0) continue;
    let m, any = false;
    if ((m = R0.exec(it.text))) {
      out.push(mk(oneLine(m[0]), it, 5 + w + fit, 'high', { num: Number(m[1]), key: `${Number(m[1])} ${m[2].toLowerCase().replace(/advanced placement/, 'ap')}` }));
      continue;
    }
    // one sentence can state several counts: "29 AP courses, 23 post-AP courses"
    const g = new RegExp(R1.source, 'gi');
    while ((m = g.exec(it.text))) {
      const n = Number(m[1]);
      if (!(n >= 1 && n <= 300)) continue;
      any = true;
      out.push(mk(oneLine(m[0]), it, 4 + w + fit, 'high', { num: n, key: `${n} ${m[2].toLowerCase().replace(/advanced placement/, 'ap')}` }));
    }
    if (!any && (m = R2.exec(it.text))) {
      const n = Number(m[2]);
      if (n >= 1 && n <= 300) out.push(mk(oneLine(m[0]), it, 3.5 + w + fit, 'high', { num: n, key: `${n} ${m[1].toLowerCase().replace(/advanced placement/, 'ap')}` }));
    }
  }
  return lines(out, 4, 'high');
}

function rTestScores(c) {
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { pdf: 3, facts: 3, college: 2, academics: 1, _: 0.3 });
    if (!w || it.text.length > 260) continue;
    const t = it.text;
    if (/prep|register|registration|test dates?|optional|require|submit|waive|deadline|sitting/i.test(t)) continue;
    const sat = /\bSAT\b/.test(t) && /\b(1[0-5]\d0|1600|[4-7]\d0|800)\b/.test(t);
    const act = /\bACT\b/.test(t) && /\b(1\d|2\d|3[0-6])(\.\d)?\b/.test(t);
    const other = /\b(SSAT|ISEE|HSPT)\b/.test(t) && /\b(average|median|mean|typical)\b/i.test(t) && /\d/.test(t);
    if (!sat && !act && !other) continue;
    if (!/mean|median|average|avg|middle 50|mid[- ]?50|composite|EBRW|evidence|math|reading|score|percentile/i.test(t)) continue;
    out.push(mk(clip(t, 200), it, 3 + w + (sat ? 1 : 0), 'medium'));
  }
  return lines(out, 4, 'medium');
}

function rHomework(c) {
  const R1 = new RegExp(`(\\d+(?:\\.\\d+)?(?:\\s*(?:-|\\u2013|to)\\s*\\d+(?:\\.\\d+)?)?|${WORDNUM_RE})\\s*(?:and a half\\s*)?(hours?|minutes?)\\s+(?:of\\s+)?(?:nightly\\s+|daily\\s+)?homework`, 'i');
  const R2 = /homework[^.]{0,70}?(\d+(?:\.\d+)?(?:\s*(?:-|–|to)\s*\d+(?:\.\d+)?)?)\s*(hours?|minutes?)/i;
  const out = [];
  for (const it of c.idx.sentences) {
    const m = R1.exec(it.text) || R2.exec(it.text);
    if (!m) continue;
    out.push(mk(`${m[1]} ${m[2]}`, it, 3 + weightOf(it.page, { academics: 2, faq: 2, facts: 2, _: 1 }) + divisionFit(it.text, c.school.division) * 2, 'medium'));
  }
  const r = best(out);
  if (r.status === 'none') r.note = 'Not stated on the school’s own site. The template says this usually comes from a third-party site, which this script does not read.';
  return r;
}

function rFacultyDegrees(c) {
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { ...W.facts, academics: 1.5 });
    if (!w || it.text.length > 300) continue;
    if (!/faculty|teachers/i.test(it.text) || !/advanced degrees?|master|graduate degrees?|doctora|ph\.?d/i.test(it.text)) continue;
    // "76% Upper School faculty who hold advanced degrees" is no answer for a Middle School row
    const fit = divisionFit(it.text, c.school.division);
    if (fit < 0) continue;
    // several percentages can share one chunk ("100% of graduates ... 57% Faculty holding advanced degrees"): take the one next to the degree words
    const deg = /advanced degrees?|master|graduate degrees?|doctora|ph\.?d/i.exec(it.text);
    let m = null, gap = Infinity;
    for (const x of it.text.matchAll(/(\d{1,3})\s*%/g)) {
      const d = Math.abs(x.index - deg.index);
      if (d < gap) { gap = d; m = x; }
    }
    if (!m || gap > 90 || Number(m[1]) > 100 || Number(m[1]) < 10) continue;
    const q = qualifierBefore(it.text, m.index);
    out.push(mk((q ? q + ' ' : '') + m[1] + '%', it, 4 + w + fit, 'high', { num: Number(m[1]), key: m[1] + '%' }));
  }
  return best(out, { conflict: true });
}

function rSports(c) {
  const found = new Map();
  let src = null;
  for (const page of c.pages) {
    if (!(page.topics || []).includes('athletics')) continue;
    const texts = [...(page.blocks || []).filter((b) => b.z === 'main').map((b) => b.text),
      ...(page.links || []).filter((l) => /athletic|sport|team/i.test(l.url)).map((l) => l.text)];
    let n = 0;
    for (const t of texts) for (const [name, re] of SPORTS) if (re.test(t) && !found.has(name)) { found.set(name, page); n++; }
    if (n && (!src || n > src.n)) src = { page, n };
  }
  if (found.size < 3) return { status: 'none' };
  const R = /(\d{1,3})\+?\s+(?:varsity |interscholastic |athletic |competitive |different |upper school |middle school )*(?:sports\b|teams\b)(?! (?:camps|medicine))/i;
  const counts = scan([...c.idx.phrases, ...c.idx.sentences], R, { athletics: 3, facts: 2.5, pdf: 1.5, _: 0 }, (m, it, w) => {
    const n = Number(m[1]);
    const fit = divisionFit(it.text, c.school.division);
    return n >= 3 && n <= 150 && fit >= 0 ? mk(oneLine(m[0]), it, w + fit * 2, 'medium') : null;
  }).sort((a, b) => b.score - a.score);
  const names = [...found.keys()].sort();
  const sources = [{ url: src.page.finalUrl, title: src.page.title }];
  if (counts[0] && counts[0].url !== sources[0].url) sources.push({ url: counts[0].url, title: counts[0].title });
  return {
    status: 'found', confidence: 'medium',
    value: (counts[0] ? counts[0].value + '\n' : '') + names.join(' | '),
    sources, snippet: counts[0] ? counts[0].snippet : `Sport names found on the athletics pages: ${names.length}`,
    note: `${names.length} sport names matched on the athletics pages. A sport only mentioned in passing would also be listed.`,
  };
}

function rCollegeEnrollment(c) {
  const R1 = /(\d{2,3})\s*%[^.%]{0,90}?(?:four[- ]year|4[- ]year)\s+(?:colleges?|universit)/i;
  const R2 = /(\d{2,3})\s*%\s+(?:of\s+)?(?:our\s+|the\s+)?(?:graduates|seniors|graduating|class of)[^.%]{0,80}?(?:college|universit)/i;
  const R3 = /(?:four|4)[- ]year (?:colleges?|universit)[^.\d%]{0,40}(\d{2,3})\s*%/i;
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { college: 3, facts: 3, pdf: 3, about: 1.5, home: 1, academics: 1, _: 0.4 });
    if (!w) continue;
    const m = R1.exec(it.text) || R3.exec(it.text) || R2.exec(it.text);
    if (!m || Number(m[1]) > 100 || Number(m[1]) < 40) continue;
    out.push(mk(m[1] + '%', it, 4 + w, 'high', { num: Number(m[1]) }));
  }
  return best(out);
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,6})(?:\.\d{2})?/g;
function rTuition(c) {
  const now = c.now;
  const ayStart = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { tuition: 3, facts: 2, pdf: 1, admissions: 1, faq: 1 });
    if (!w || it.text.length > 320) continue;
    const t = it.text;
    MONEY.lastIndex = 0;
    const amounts = [...t.matchAll(MONEY)].map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => n >= 3000 && n <= 150000);
    if (!amounts.length || amounts.length > 3) continue;                      // long rows are payment-plan tables
    if (it.form && it.form !== 'S' && !/tuition|comprehensive fee/i.test(t)) continue; // a bare "$60,036 Boarding Student" tile could be an aid figure
    if (!/tuition|\bgrades?\b|kindergarten|lower school|middle school|upper school|high school|day student|boarding|boarder|7-day|5-day|comprehensive fee|\bK\b|\bPK\b/i.test(t)) continue;
    // "Tuition for 2026-2027 is $33,575 ..." is a direct statement and is kept even if the sentence goes on to mention a deposit
    const direct = /\btuition\b[^$.]{0,70}\$\s?\d/i.test(t) && !/award|assistance|\baid\b|grant|income|net worth|average tuition|recipient|scholarship|parent payment|balance/i.test(t);
    if (!direct && /award|assistance|\baid\b|grant|income|net worth|budget|recipient|raise|endow|million|deposit|payment plan|insurance|waiver|application fee|scholarship|\bcase\b|average tuition|parent payment|new student fee|laptop|books|balance|payment \d/i.test(t)) continue;
    if (/one child|two children|sibling|family (of|with)|for example|sample|scenario/i.test(t)) continue;
    // the sliding-scale table of what a FAMILY pays after aid ("Family’s Tuition Payment, Per Child | $0 | $7,900 | $32,000") is not the tuition
    if (/family.?s tuition payment/i.test(t) || /\|\s*\$0\s*\|/.test(t)) continue;
    const main = it.i != null ? (it.page.blocks || []).filter((b) => b.z === 'main') : [];
    // a figure sitting right under "Average Annual Grants" or "Financial Aid" is not tuition
    if (!direct && main.slice(Math.max(0, it.i - 2), it.i).some((b) => b.text.length < 120 && /grants?\b|financial aid|\bawards?\b|assistance/i.test(b.text))) continue;
    // which school year? look in the line itself, then a few blocks above it
    let yearText = (t.match(/20\d{2}\s*[-–/]\s*(?:20)?\d{2}/) || [])[0];
    for (let j = it.i - 1; j >= Math.max(0, it.i - 4) && !yearText && main.length; j--) yearText = (main[j].text.match(/20\d{2}\s*[-–/]\s*(?:20)?\d{2}/) || [])[0];
    const startYear = yearText ? Number(yearText.slice(0, 4)) : null;
    const stale = startYear != null && startYear < ayStart;
    const fit = divisionFit(t, c.school.division);
    let score = 3 + w + fit * 2 + (/tuition/i.test(t) ? 1.5 : 0) + (direct ? 2 : 0) + (startYear != null && !stale ? 1.5 : 0) - (stale ? 4 : 0);
    out.push(mk(clip(t, 170), it, score, 'medium', {
      fit, num: Math.max(...amounts),
      note: stale ? `Labelled ${yearText} on the page, which looks like an earlier school year.` : (yearText ? `School year on the page: ${yearText}` : 'No school year shown next to the figure.'),
    }));
  }
  let keep = out;
  if (c.school.division && out.some((o) => o.fit >= 0)) keep = out.filter((o) => o.fit >= 0);
  const r = lines(keep, 6, 'medium');
  if (r.status === 'found') {
    const top = keep.slice().sort((a, b) => b.score - a.score)[0];
    r.num = top.num; r.note = top.note;
  }
  return r;
}

function rNewSpots(c) {
  const R1 = new RegExp(`(?:\\b\\d{1,3}\\b|\\b(?:${WORDNUM_RE})\\b)[^.]{0,70}\\b(?:new students|openings|spaces|spots|seats|places)\\b`, 'i');
  const R2 = /\b(?:entry (?:points?|years?|grades?)|main entry|typically (?:admit|enroll|accept|welcome)s?|we (?:admit|enroll|welcome|accept|have) (?:approximately|about|around|roughly))\b/i;
  const out = [];
  for (const it of c.idx.sentences) {
    const w = weightOf(it.page, { process: 3, admissions: 3, faq: 2.5, facts: 1.5, dates: 1 });
    if (!w || it.text.length > 380) continue;
    const a = R1.test(it.text), b = R2.test(it.text) && /\d/.test(it.text);
    if (!a && !b) continue;
    if (/financial aid|tuition|parking|bus|waitlist fee/i.test(it.text)) continue;
    out.push(mk(it.text, it, (a ? 3 : 0) + (b ? 2 : 0) + w + divisionFit(it.text, c.school.division) * 2, a && b ? 'medium' : 'low'));
  }
  return lines(out, 2, 'low');
}

function rAbout(c) {
  const out = [];
  for (const m of c.metas) {
    if (m.text.length < 90) continue;
    const w = weightOf(m.page, { home: 3, about: 2.5 });
    if (w) out.push(mk(m.text, m, w + 1, 'medium', { note: 'The site’s own page description.' }));
  }
  for (const page of c.pages) {
    if (!(page.topics || []).includes('about')) continue;
    const p = (page.blocks || []).find((b) => b.z === 'main' && b.k === 'p' && b.text.length >= 160 && /[.!?]$/.test(b.text.trim()));
    if (p) out.push(mk(clip(oneLine(p.text), 800), { text: p.text, page }, 2.5 + Math.min(p.text.length / 400, 1.5), 'medium', { note: 'First full paragraph of the About page.' }));
  }
  return best(out);
}

function rDemographics(c) {
  const KEY = /students? of color|people of color|self-identif|identify as|international students|countr(y|ies)|zip codes|languages|states\b|boarding students|day students|boarders|first[- ]generation|multiracial|asian|latin|hispanic|\bblack\b|african american|\bwhite\b|diverse|ethnic|races?\b/i;
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { facts: 3, diversity: 3, pdf: 2, about: 1.5, home: 1, admissions: 1 });
    if (!w || it.text.length > 340 || !/\d/.test(it.text) || !KEY.test(it.text)) continue;
    if (/\$|faculty|teachers|staff|alumn|founded|since \d{4}/i.test(it.text)) continue;
    out.push(mk(it.text, it, w + (/%/.test(it.text) ? 1.5 : 0) + (it.form ? 0.5 : 0), 'medium', { order: (it.page.finalUrl.length * 1000) + (it.i || 0) }));
  }
  return lines(out, 8, 'medium');
}

function rAcademics(c) {
  let bestPage = null;
  for (const page of c.pages) {
    if (!(page.topics || []).includes('academics')) continue;
    const names = [];
    const texts = [...(page.blocks || []).map((b) => oneLine(b.text)), ...(page.links || []).map((l) => l.text)];
    for (const t of texts) {
      if (t.length > 45 || !DEPT_RE.test(t)) continue;
      const clean = t.replace(/ department$/i, '');
      if (!names.some((n) => n.toLowerCase() === clean.toLowerCase())) names.push(clean);
    }
    const fit = divisionFit(page.finalUrl + ' ' + page.title, c.school.division);
    const score = names.length + fit * 3;
    if (names.length >= 4 && (!bestPage || score > bestPage.score)) bestPage = { page, names, score };
  }
  if (!bestPage) return { status: 'none' };
  return {
    status: 'found', confidence: 'medium', value: bestPage.names.join(' | '),
    sources: [{ url: bestPage.page.finalUrl, title: bestPage.page.title }],
    snippet: `Department and subject names listed on this page: ${bestPage.names.join(', ')}`,
    note: 'Subject names as they appear in the page’s menus and headings.',
  };
}

function rPartners(c) {
  const found = new Map();
  let top = null;
  for (const page of c.pages) {
    const text = (page.blocks || []).map((b) => b.text).join('\n');
    let n = 0;
    for (const [name, re] of ORGS) if (re.test(text)) { n++; if (!found.has(name)) found.set(name, page); }
    if (n && (!top || n > top.n)) top = { page, n };
  }
  if (!found.size) return { status: 'none' };
  const sent = c.idx.sentences.find((s) => /accredited by|is a member of|members? of the|membership in|affiliated with/i.test(s.text) && ORGS.some(([, re]) => re.test(s.text)));
  const src = sent ? sent.page : top.page;
  return {
    status: 'found', confidence: sent ? 'medium' : 'low', value: [...found.keys()].join(' | '),
    sources: [{ url: src.finalUrl, title: src.title }],
    snippet: sent ? clip(sent.text, 460) : `Organization names found in the site text: ${[...found.keys()].join(', ')}`,
    note: sent ? undefined : 'Names matched anywhere on the site (often footer logos). Membership is not stated in a sentence.',
  };
}

function rTransit(c) {
  const KEY = /\b(bus(es)?|shuttles?|caltrain|bart|light rail|public transit|public transportation|carpool(ing)?|train|ferry|metro|subway|muni|vta|samtrans|metrolink|transportation)\b/gi;
  const out = [];
  for (const it of c.idx.sentences) {
    const w = weightOf(it.page, { transport: 3, faq: 1, admissions: 0.8, about: 0.5 });
    if (!w || it.text.length > 400) continue;
    const n = (it.text.match(KEY) || []).length;
    if (!n || (w < 3 && n < 2)) continue;
    out.push(mk(it.text, it, w * 2 + Math.min(n, 3), 'medium', { order: (w >= 3 ? 0 : 1e6) + (it.i || 0) }));
  }
  return lines(out, 3, 'medium');
}

function rMission(c) {
  const out = [];
  for (const s of c.idx.sections) {
    if (!/mission/i.test(s.heading) || s.heading.length > 60) continue;
    const w = weightOf(s.page, { about: 3, home: 2, _: 1 });
    const para = s.text.split('\n').map((x) => x.trim()).find((x) => x.length >= 60 && !/^•/.test(x));
    if (!para) continue;
    out.push(mk(clip(para, 700), { text: s.heading + ': ' + para, page: s.page }, 4 + w, 'high'));
  }
  for (const it of c.idx.sentences) {
    if (!/\b(our|the|its) mission (is|of)\b|\bmission is to\b|['’]s mission\b/i.test(it.text)) continue;
    out.push(mk(it.text, it, 2 + weightOf(it.page, { about: 3, home: 2, _: 1 }), 'medium'));
  }
  return best(out);
}

function portalRole(p) {
  const s = (p.linkText + ' ' + p.url).toLowerCase();
  if (/\.pdf|ftpimages|\/download\//.test(s)) return null;
  const name = p.name.toLowerCase();
  if (/isee|hspt|kira/.test(name)) return 'testing';
  if (/ssat/.test(name)) return /sao|standard application/.test(s) ? 'apply' : 'testing';
  if (/clarity|facts|tads/.test(name)) return 'aid';
  if (/ravenna|gateway|openapply|schooladmin|application site/.test(name)) return 'apply';
  return /apply|admission|inquir|applicant|application/.test(s) ? 'apply' : 'family';
}

function rPortal(c) {
  const byName = new Map();
  for (const p of c.crawl.portals || []) {
    const role = portalRole(p);
    if (role !== 'apply' && role !== 'aid') continue;
    const key = role + ':' + p.name;
    const prev = byName.get(key);
    const rank = (x) => {
      let pathname = '/'; try { pathname = new URL(x.url).pathname; } catch { /* keep */ }
      if (/\/schools\//i.test(x.url)) return 4;                 // the school's own page on the portal
      if (/login|sign[-_]?in|sign[-_]?up|register/i.test(x.url)) return 1;
      if (pathname === '/' || pathname === '') return 3;        // the portal's front door
      return 2;
    };
    if (!prev || rank(p) > rank(prev)) byName.set(key, { ...p, role });
  }
  // application portals first, and among those the one whose link actually says "apply"
  const order = (p) => (p.role === 'apply' ? 0 : 2) + (/apply|application/i.test(p.linkText || '') ? 0 : 1);
  const list = [...byName.values()].sort((a, b) => order(a) - order(b));
  if (!list.some((p) => p.role === 'apply')) {
    if (!list.length) return { status: 'none' };
  }
  return {
    status: 'found', confidence: list.some((p) => p.role === 'apply') ? 'high' : 'low',
    value: list.map((p) => `${p.role === 'aid' ? 'Financial aid: ' : ''}${p.name} — ${p.url}`).join('\n'),
    sources: list.slice(0, 3).map((p) => ({ url: p.foundOn, title: 'page linking to ' + p.name })),
    snippet: list.map((p) => `Link “${clip(p.linkText || p.url, 80)}” → ${p.url}`).slice(0, 3).join(' … '),
    note: 'Portals are recognised from the links on the admissions pages. Anything behind the portal login is not read.',
  };
}

const ADM_KEY = /application|apply|deadline|\bdue\b|decision|notif|financial aid|tuition assistance|open house|tour|interview|testing|\bISEE\b|\bSSAT\b|\bHSPT\b|shadow|visit|enrollment|contract|deposit|reply|session|opens|begins|admission|assessment|recommendation|transcript/i;

function datedLines(c) {
  if (c._dated) return c._dated;
  const out = [];
  for (const page of c.pages) {
    const w = weightOf(page, { dates: 3, process: 3, admissions: 2.5, visit: 2, faq: 1.5, tuition: 0.8 });
    if (!w) continue;
    const main = (page.blocks || []).filter((b) => b.z === 'main');
    main.forEach((b, i) => {
      let text = oneLine(b.text);
      if (text.length > 300) return;
      let dates = findDates(text);
      if (!dates.length) return;
      // a block that is only a date borrows its label from the neighbouring block
      if (text.length <= dates[0].raw.length + 22) {
        const next = main[i + 1], prev = main[i - 1];
        const nb = next && oneLine(next.text).length <= 200 && !findDates(next.text).length ? next : (prev && oneLine(prev.text).length <= 200 && !findDates(prev.text).length ? prev : null);
        if (nb) text = nb === next ? `${text} — ${oneLine(nb.text)}` : `${oneLine(nb.text)} — ${text}`;
      }
      if (!ADM_KEY.test(text)) return;
      out.push({ text, page, i, w, dates, stale: isStale(dates, c.now), fit: divisionFit(text, c.school.division) });
    });
  }
  c._dated = out;
  return out;
}

function rTimeline(c) {
  let rows = datedLines(c).filter((d) => !d.stale);
  if (!rows.length) {
    const old = datedLines(c);
    if (!old.length) return { status: 'none' };
    rows = old;
  }
  if (c.school.division && rows.some((r) => r.fit >= 0)) rows = rows.filter((r) => r.fit >= 0);
  const cands = rows.map((d) => mk(clip(d.text, 220), d, d.w + (d.dates.some((x) => x.year) ? 1 : 0) + (/deadline|\bdue\b|decision|notif|opens/i.test(d.text) ? 1.5 : 0), 'medium', {
    order: d.dates[0].date ? d.dates[0].date.getTime() : 9e15,
  }));
  const r = lines(cands, 14, 'medium');
  if (rows.every((d) => d.stale)) { r.confidence = 'low'; r.note = 'Every dated line found is from before this admission cycle. The site may not be updated yet.'; }
  return r;
}

const AID_PAGE = /tuition|financial|afford|\baid\b|assistance/i;
const AID_TEXT = /financial aid|tuition assistance|\bFACTS\b|clarity|\bSSS\b|\baid\b|scholarship|re-?enrollment|contracts?/i;

/**
 * Finds the date that goes with a phrase ("application opens", "decisions released").
 * Works sentence by sentence, so a date is never borrowed from the neighbouring sentence.
 */
function datedPick(c, re, antiRe, notBetween) {
  const out = [];
  for (const d of datedLines(c)) {
    // aid pages and the transfer / international tracks have their own calendars
    if (AID_PAGE.test(d.page.finalUrl + ' ' + (d.page.title || '')) || /transfer|international/i.test(d.page.finalUrl)) continue;
    for (const s of splitSentences(d.text, true)) {
      const m = re.exec(s);
      if (!m || (antiRe && antiRe.test(s)) || /\btransfer\b/i.test(s)) continue;
      let dates = findDates(s);
      // "March 12, 2027" on its own line above the sentence that explains it
      if (!dates.length && d.dates[0].index <= 2) dates = [d.dates[0]];
      if (!dates.length) continue;
      const after = dates.filter((x) => x.index >= m.index);
      const pick = after[0] || dates[dates.length - 1];
      // "opens in February and stays open until April 9": April 9 is the closing date, not the opening date
      if (notBetween && after[0] && notBetween.test(s.slice(m.index + m[0].length, pick.index))) continue;
      const stale = pick.date ? pick.date < cycleStart(c.now) : false;
      out.push(mk(pick.raw, d, d.w + (pick.year ? 2 : 0) - (stale ? 5 : 0) + d.fit * 2, pick.year && !stale ? 'medium' : 'low', {
        note: stale ? 'This date is from before the current admission cycle.' : (pick.year ? undefined : 'The page gives no year for this date.'),
      }));
    }
  }
  return out;
}

function rOpenDate(c) {
  const RE = /\bapplications?\b(?:\s+(?:for|to)\s+[^.;,]{0,50})?\s+(?:will\s+|is\s+|are\s+|has\s+|have\s+)?(?:be\s+|now\s+|go(?:es)?\s+)?(?:open(?:s|ed)?|available|live|launch(?:es|ed)?|begins?)\b|\bapplications?\b[^.;,]{0,45}\bopen(?:s|ed)?\b|\b(?:open(?:s|ed)?|available|begins?|launch(?:es)?)\b[^.;,]{0,30}\bapplications?\b|\bbegin accepting applications\b/i;
  const out = datedPick(c, RE, AID_TEXT, /\b(until|through|thru|clos(?:e|es|ed|ing)|ends?|ending|deadline|due)\b/i);
  if (!out.length) {
    for (const it of c.idx.sentences) {
      const w = weightOf(it.page, W.admissions);
      if (!w || AID_PAGE.test(it.page.finalUrl) || /transfer|international/i.test(it.page.finalUrl) || !RE.test(it.text) || AID_TEXT.test(it.text) || /this part|section|portion|transfer/i.test(it.text)) continue;
      const m = new RegExp(`\\b(?:in|on|by|early|mid|late)[- ]?\\s*(${MONTH}(?:\\s+20\\d{2})?)`).exec(it.text);
      // "...the lottery window closing on December 1": a closing month is not the opening month
      if (m && /\b(until|through|thru|clos(?:e|es|ed|ing)|ends?|ending|deadline|due)\b/i.test(it.text.slice(Math.max(0, m.index - 50), m.index + 6))) continue;
      if (m) out.push(mk(m[1], it, w, 'low', { note: 'Only a month is given on the page.' }));
    }
  }
  return best(out);
}

function rDecisionDate(c) {
  const RE = /\b(decisions?|notifications?)\b[^.;]{0,60}?\b(released|sent|posted|available|emailed|mailed|communicated|shared|announced|published|delivered|go out)\b|\b(release|send|post|notify|notified)\b[^.;]{0,40}\bdecisions?\b|\bdecision notifications?\b|\bnotification (date|day)\b|\bdecision (date|day)\b/i;
  return best(datedPick(c, RE, /financial aid|tuition assistance|reply|respond|deposit|contract|enrollment agreement|early decision/i));
}

function rClassesPerGrade(c) {
  const R = new RegExp(`\\b(\\d{1,2}|${WORDNUM_RE})\\s+(?:sections|classes|homerooms|classrooms)\\s+(?:per|in each|at each|for each)\\s+grade\\b`, 'i');
  return best(scan([...c.idx.phrases, ...c.idx.sentences], R, { facts: 3, faq: 2.5, admissions: 2, process: 2, academics: 2, about: 1.5, pdf: 1.5, _: 0.4 }, (m, it, w) => {
    const n = toNum(m[1]), fit = divisionFit(it.text, c.school.division);
    return n >= 1 && n <= 12 && fit >= 0 ? mk(oneLine(m[0]), it, 4 + w + fit * 2, 'medium', { num: n }) : null;
  }));
}

function rStudentsPerGrade(c) {
  const R1 = /(?<![\d.,:$])(\d{2,3})\s+students\s+(?:per|in each|at each|in every)\s+(?:grade|class year|grade level)\b/i;
  const R2 = /\beach (?:grade|grade level|class)\b[^.\d]{0,40}?(?<![\d.,:$])(\d{2,3})\s+students\b/i;
  const out = [];
  for (const it of [...c.idx.phrases, ...c.idx.sentences]) {
    const w = weightOf(it.page, { facts: 3, faq: 2.5, admissions: 2, process: 2, academics: 1.5, about: 1.5, pdf: 1.5, _: 0.4 });
    if (!w) continue;
    const m = R1.exec(it.text) || R2.exec(it.text);
    const fit = divisionFit(it.text, c.school.division);
    if (!m || fit < 0 || Number(m[1]) < 10 || Number(m[1]) > 600) continue;
    out.push(mk(m[1], it, 4 + w + fit * 2, 'medium', { num: Number(m[1]) }));
  }
  return best(out);
}

/** Text under a matching heading, else the best matching sentences. */
function sectionOrSentences(c, def) {
  const div = c.school.division;
  const secs = [];
  for (const s of c.idx.sections) {
    const w = weightOf(s.page, def.weights);
    if (!w || !def.heading.test(s.heading) || s.heading.length > 90) continue;
    if (def.notHeading && def.notHeading.test(s.heading)) continue;
    if (s.text.length < 40) continue;
    const fit = divisionFit(s.heading + ' ' + s.page.finalUrl + ' ' + (s.page.title || ''), div);
    let score = w + fit * 2 + (s.level <= 4 ? 1 : 0) + Math.min(s.text.length / 500, 2);
    if (def.body && !def.body.test(s.text) && !def.body.test(s.heading)) score -= 2;
    secs.push({ s, score });
  }
  if (secs.length) {
    secs.sort((a, b) => b.score - a.score);
    // some rows hold more than one section (Essays: the parent part and the student part)
    const take = [secs[0].s];
    for (const { s } of secs.slice(1)) {
      if (take.length >= (def.multi || 1)) break;
      if (take.some((t) => t.heading.toLowerCase() === s.heading.toLowerCase() || t.text.includes(s.text.slice(0, 80)) || s.text.includes(t.text.slice(0, 80)))) continue;
      take.push(s);
    }
    const per = Math.floor(1500 / take.length);
    const sources = [];
    for (const s of take) if (!sources.some((x) => x.url === s.page.finalUrl)) sources.push({ url: s.page.finalUrl, title: s.page.title });
    const r = {
      status: 'found', confidence: 'medium',
      value: take.map((s) => (take.length > 1 ? `${s.heading}\n` : '') + clip(s.text, per)).join('\n\n'),
      sources,
      snippet: clip(take.map((s) => `Under the heading “${s.heading}”: ${oneLine(s.text)}`).join(' … '), 460),
    };
    if (take.some((s) => s.text.length > per)) r.note = 'Long section, shortened here. Open the page for the full text.';
    const rest = secs.map((x) => x.s).filter((s) => !take.includes(s)).slice(0, 2);
    const alts = rest.map((a) => ({ value: clip(oneLine(a.text), 300), url: a.page.finalUrl, snippet: `Heading: “${a.heading}”` }));
    if (alts.length) r.alts = alts;
    return r;
  }
  const out = [];
  for (const it of c.idx.sentences) {
    const w = weightOf(it.page, def.weights);
    if (!w || !def.sentence.test(it.text) || it.text.length > 420) continue;
    out.push(mk(it.text, it, w + divisionFit(it.text, div) * 2 + (it.text.match(def.sentence) || []).length * 0.2, 'low', { order: it.page.finalUrl.length * 1e4 + it.i }));
  }
  return lines(out, 3, 'low', 'No section heading for this on the site. These are the sentences that mention it.');
}

function eventLines(c, keyRe) {
  const rows = datedLines(c).filter((d) => keyRe.test(d.text) && !d.stale);
  return rows.map((d) => mk(clip(d.text, 240), d, d.w + 2 + d.fit * 2, 'medium', { order: d.dates[0].date ? d.dates[0].date.getTime() : 9e15 }));
}

function eventField(c, keyRe, def) {
  const dated = eventLines(c, keyRe);
  if (dated.length) return lines(dated, 6, 'medium');
  return sectionOrSentences(c, def);
}

const ADM_W = { process: 3, admissions: 2.5, faq: 2, dates: 1.5, visit: 1 };
const VISIT_W = { visit: 3, admissions: 2.5, process: 1.5, dates: 2, faq: 1.5 };

const SECTION_DEFS = {
  application: { weights: ADM_W, heading: /how to apply|application (process|steps|checklist|requirements|procedures?|components|materials)|steps to apply|admissions? (process|steps|checklist|requirements)|applying to|^to apply|^apply$|what (is|are) required/i, notHeading: /financial|tuition|aid/i, sentence: /\b(application (fee|form|process)|submit (an|the|your) application|to apply|preliminary application|online application)\b/i },
  recommendations: { weights: ADM_W, heading: /recommendation|teacher evaluation|evaluations?\b|references?\b/i, body: /teacher|recommend|evaluat/i, sentence: /\b(recommendations?|teacher evaluations?|evaluation forms?)\b/i },
  transcripts: { weights: ADM_W, heading: /transcript|school records?|report cards?|academic records?|school reports?/i, sentence: /\b(transcripts?|report cards?|school records?)\b/i },
  testingPolicy: { weights: ADM_W, heading: /\btest(ing)?\b|standardized|entrance exam|\bISEE\b|\bSSAT\b|\bHSPT\b|assessment/i, notHeading: /covid|placement|protest|contest/i, body: /ISEE|SSAT|HSPT|test|exam|assessment/i, sentence: /\b(ISEE|SSAT|HSPT|standardized test(ing|s)?|test[- ]optional|entrance exam)\b/i },
  interviews: { weights: ADM_W, heading: /interview/i, sentence: /\binterviews?\b/i },
  pws: { weights: ADM_W, heading: /writing (sample|exercise|assessment)|proctored|timed writing/i, sentence: /\b(writing sample|proctored writing|timed writing|writing exercise|writing assessment)\b/i },
  essays: { weights: ADM_W, multi: 3, heading: /essay|questionnaire|statement|student (questions|responses|reflection|portion)|parent(\/guardian)? (questions|responses|portion)|short answers?/i, notHeading: /mission|diversity|non-?discrimination|privacy|financial/i, sentence: /\b(essays?|questionnaires?|parent statement|student statement|short[- ]answer)\b/i },
  guideEvents: { weights: VISIT_W, heading: /admissions? events|upcoming events|events for|^events$|ways to (visit|connect)|get to know/i, sentence: /\b(admissions? events?|open house|information session|campus tour|shadow)\b/i },
  infoSessions: { weights: VISIT_W, heading: /information(al)? sessions?|info sessions?|webinars?|virtual (sessions?|events?|visits?)|admissions? coffees?/i, sentence: /\b(information(al)? sessions?|info sessions?|webinars?)\b/i },
  openHouse: { weights: VISIT_W, heading: /open house|preview (day|night|event)/i, sentence: /\b(open house|preview (day|night|event))\b/i },
  tours: { weights: VISIT_W, heading: /\btours?\b|campus visits?|shadow|visit (us|campus|our)/i, notHeading: /virtual tour$/i, sentence: /\b(campus tours?|guided tours?|tours? of|shadow (day|visit)s?)\b/i },
};

function rFactsSheet(c) {
  const out = [];
  for (const page of c.pages) {
    const t = page.topics || [];
    const label = page.title || page.linkText || '';
    if (page.kind === 'pdf' && /profile|glance|fact|numbers/i.test(label + ' ' + page.finalUrl)) {
      out.push(mk(`${label || 'PDF'} — ${page.finalUrl}`, { text: `PDF linked as “${page.linkText || label}”`, page }, 3 + (/profile/i.test(label + page.finalUrl) ? 0.5 : 0), 'high'));
    } else if (page.kind === 'html' && t.includes('facts')) {
      const h1 = (page.blocks.find((b) => b.k === 'h' && b.z === 'main') || {}).text || label;
      out.push(mk(`${oneLine(h1)} — ${page.finalUrl}`, { text: `Page titled “${label}”`, page }, 4, 'high'));
    }
  }
  if (!out.length) return { status: 'none' };
  out.sort((a, b) => b.score - a.score);
  const r = lines(out, 3, 'high');
  return r;
}

const MANUAL = {
  notes: 'A free-form notes row. Nothing to look up.',
  peerSchools: 'Schools do not publish their peer schools, so there is nothing on the website to read.',
};

/** Run every rule for one school against the pages crawled from its website. */
function extractSchool(school, crawl, now = new Date()) {
  const pages = (crawl.pages || []).filter((p) => p.ok);
  const idx = buildIndex(pages);
  const metas = pages.filter((p) => p.description && p.description.length >= 50).map((p) => ({ text: p.description, page: p, meta: true }));
  const c = { school, crawl, pages, idx, metas, now };
  const run = {
    applicationOpenDate: rOpenDate, factsSheet: rFactsSheet, schoolType: rSchoolType, location: rLocation, grades: rGrades,
    enrollment: rEnrollment, classesPerGrade: rClassesPerGrade, studentsPerGrade: rStudentsPerGrade,
    classSize: rClassSize, ratio: rRatio, counselors: rCounselors, advancedClasses: rAdvanced,
    testScores: rTestScores, homework: rHomework, facultyDegrees: rFacultyDegrees, sports: rSports,
    collegeEnrollment: rCollegeEnrollment, tuition: rTuition, newSpots: rNewSpots, about: rAbout,
    demographics: rDemographics, academics: rAcademics, partners: rPartners, transit: rTransit, mission: rMission,
    portal: rPortal, timeline: rTimeline, decisionDate: rDecisionDate,
    infoSessions: (x) => eventField(x, /information(al)? sessions?|info sessions?|webinar/i, SECTION_DEFS.infoSessions),
    openHouse: (x) => eventField(x, /open house|preview (day|night)/i, SECTION_DEFS.openHouse),
    tours: (x) => eventField(x, /\btours?\b|shadow/i, SECTION_DEFS.tours),
  };
  for (const k of ['application', 'recommendations', 'transcripts', 'testingPolicy', 'interviews', 'pws', 'essays', 'guideEvents']) {
    run[k] = (x) => sectionOrSentences(x, SECTION_DEFS[k]);
  }
  const fields = {};
  for (const [key, fn] of Object.entries(run)) {
    try { fields[key] = fn(c); } catch (e) { fields[key] = { status: 'error', note: 'Rule failed: ' + e.message }; }
  }
  for (const [key, note] of Object.entries(MANUAL)) fields[key] = { status: 'manual', note };
  return fields;
}

module.exports = { extractSchool, divisionFit, gradeSpans, findDates };
