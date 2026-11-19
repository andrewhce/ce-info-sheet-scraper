'use strict';
// Reads a page a person saved from another site: Ravenna (the school's own application platform), Niche, Private School
// Review or Boarding School Review. Nothing here downloads anything: it only reads the saved file.
//
// The school's own website is always the first source. These pages only fill what the website did not answer, and every
// answer says which site it came from. Answers come from labelled facts ("Student-Teacher Ratio: 7:1") and never from loose
// sentences, because review pages also show figures for nearby schools, state averages and rankings.
//
// What a page's facts look like is learnt from real pages. Private School Review and Boarding School Review (one layout,
// checked against a real page) have a precise reader. Niche and Ravenna use a general reader that understands the common
// ways of laying out "label, value" pairs; it is tuned on real saved pages as people add them.
const cheerio = require('cheerio');
const { oneLine, clip } = require('./util');
const { parseHtml } = require('./html');
const { extractSchool, TYPE_WORDS } = require('./rules');

const clean = (s) => oneLine(String(s == null ? '' : s).replace(/[ ​]/g, ' '));
const numIn = (s) => { const m = /(\d[\d,]*(?:\.\d+)?)/.exec(String(s)); return m ? Number(m[1].replace(/,/g, '')) : null; };

// ------------------------------------------------------------------------------------------------- value readers ---
const GT = '(?:pre-?k(?:indergarten)?|pk|tk|jk|k(?:indergarten)?|\\d{1,2})';
const GRADES_RE = new RegExp(`\\b(${GT})(?:st|nd|rd|th)?\\s*(?:-|\\u2013|\\u2014|to|through|thru)\\s*(?:grade\\s*)?(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
const gradeLabel = (g) => (/^(pre-?k|pk|jk)/i.test(g) ? 'PK' : /^tk$/i.test(g) ? 'TK' : /^k/i.test(g) ? 'K' : String(parseInt(g, 10)));
const gradeNum = (g) => (/^(pre-?k|pk|jk)/i.test(g) ? -1 : /^(tk|k)/i.test(g) ? 0 : parseInt(g, 10));

const READ = {
  grades(v) {
    const m = GRADES_RE.exec(v);
    if (!m) return null;
    const a = gradeNum(m[1]), b = parseInt(m[2], 10);
    if (!(b >= 1 && b <= 12) || !(a < b) || a > 12) return null;
    return `${gradeLabel(m[1])}–${b}`;
  },
  enrollment(v) { const n = numIn(v); return n != null && n >= 5 && n <= 20000 ? n.toLocaleString('en-US') : null; },
  between(lo, hi) { return (v) => { const n = numIn(v); return n != null && n >= lo && n <= hi ? String(n) : null; }; },
  ratio(v) { const m = /(\d{1,2}(?:\.\d)?)\s*(?::|to|-|\/)\s*1\b/i.exec(v); return m ? `${m[1]}:1` : null; },
  percent(v) { const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(v); return m && Number(m[1]) <= 100 ? `${m[1]}%` : null; },
  money(v) { return /\$\s?\d/.test(v) && v.length <= 160 ? clip(v, 160) : null; },
  text(max) { return (v) => (v && v.length <= max ? v : null); },
};

// One row per template field that a labelled fact can answer: [field, label pattern, how to read the value]
const LABELS = [
  ['grades', /^(grades?( offered| served| taught| range| levels?)?|grade levels?)$/i, READ.grades],
  ['enrollment', /^((total|student|school) )?(student )?(enrollment|population)( size)?$|^total students$|^number of students$|^students( enrolled)?$/i, READ.enrollment],
  ['classSize', /^(average|avg\.?)( student)? class size( \(.*\))?$|^class size$|^students per class$/i, READ.between(3, 45)],
  ['ratio', /^student[- ]?(to[- ])?(teacher|faculty) ratio$/i, READ.ratio],
  ['facultyDegrees', /^(%|percent(age)?) (of )?(faculty|teachers) (w\/ ?|with )(an? )?advanced degrees?$|^% faculty w\/ ?advanced degrees?$|^(faculty|teachers) with advanced degrees?$/i, READ.percent],
  ['tuition', /^(yearly |annual |average |total )?tuition( cost| and fees| & fees| and fees \(.*\))?$/i, READ.money],
  ['counselors', /^(number of )?(college )?counselors?$|^college counselors?$/i, READ.between(0, 80)],
  ['advancedClasses', /^(number of )?(ap|advanced placement)( courses| classes| exams| subjects)?( offered)?$|^advanced (courses|classes) offered$/i, READ.between(1, 60)],
  ['collegeEnrollment', /^(college (enrollment|matriculation|attendance)|(graduates?|seniors?) (attending|going to|enrolled in) (a )?college|% (of )?(graduates?|seniors?) (attending|going to) college)( rate)?$/i, READ.percent],
  ['homework', /^(average )?(hours of )?homework( per night| hours)?$/i, READ.text(120)],
  ['applicationOpenDate', /^(application|applications) (opens?|open date|start date|available)$/i, READ.text(80)],
  ['decisionDate', /^(decision|notification)( release)?( date)?$|^decisions? (released|mailed)$/i, READ.text(80)],
];
// pieces that are put together from several labels
const TYPE_LABELS = [/^religious affiliation$|^affiliation$|^religion$/i, /^student body type$|^(student |school )?gender( mix)?$|^coed$|^co-?ed$/i, /^(school )?type$|^school category$|^(day|boarding)( school)?$|^boarding( status)?$/i];
const TEST_LABELS = /^(average |avg\.? )?(sat|act|ssat|isee|hspt)( average| avg\.?)?( score)?s?$|^average (sat|act|ssat|isee|hspt) score$/i;
const DEMO_LABELS = /^% students of color$|^students of color$|^minority( student)? (enrollment|population)$|^% (female|male|minority|white|asian|black|hispanic|latino)$|^(female|male) (students|enrollment)$|^diversity$/i;
const SPORTS_LABEL = /^(sports( offered)?|athletics|varsity sports)$/i;
const DEADLINE_LABELS = /^(application|admission|admissions|apply by|enrollment) deadline$|^deadline( to apply)?$/i;
const AID_DEADLINE = /^(financial aid|fa) deadline$/i;

// ---------------------------------------------------------------------------------------------- finding the pairs ---
/** The text of a value cell: notes such as "National avg.: 11:1" are dropped, a list of items becomes "a, b, c". */
function cellValue($, cell) {
  const c = $(cell).clone();
  c.find('.dt-vc-avg, em, script, style, sup').remove();
  const leaves = [];
  c.find('*').each((_, el) => {
    if ($(el).children().length) return;
    const t = clean($(el).text());
    if (t) leaves.push(t);
  });
  if (leaves.length > 1 && clean(c.text()).replace(/\s+/g, '') === leaves.join('').replace(/\s+/g, '')) return leaves.join(', ');
  return clean(c.text());
}

function structuredPairs($, review) {
  const out = [];
  const add = (label, value, how) => {
    label = clean(label).replace(/\s*:\s*$/, '');
    value = clean(value);
    if (label && value && label.length <= 70 && value.length <= 600) out.push({ label, value, how, text: `${label}: ${value}` });
  };
  // Private School Review and Boarding School Review: one row per fact, a name cell and a value cell
  $('.dt-row').each((_, el) => add($(el).find('.dt-name-cell').first().text(), cellValue($, $(el).find('.dt-value-cell').first()), 'facts table'));
  $('ul.quick-stats-ul').first().find('li').each((_, el) => {
    const li = $(el);
    const strong = li.find('strong').first();
    if (strong.length) add(clean(li.clone().children('strong').remove().end().text()), strong.text(), 'quick facts');
  });
  if (review && out.length) return out;       // that layout is understood: nothing else on the page is read
  // any other site: definition lists, two-cell table rows, and label/value pairs with matching class names
  $('dl').each((_, dl) => {
    let label = null;
    $(dl).children().each((__, c) => {
      const tag = c.tagName;
      if (tag === 'dt') label = $(c).text();
      else if (tag === 'dd' && label != null) { add(label, cellValue($, c), 'definition list'); label = null; }
    });
  });
  $('tr').each((_, tr) => {
    const cells = $(tr).children('th,td');
    if (cells.length === 2) add($(cells[0]).text(), cellValue($, cells[1]), 'table row');
  });
  const LABEL_CLASS = /(^|[-_\s])(label|name|key|title|term)([-_\s]|$)/i, VALUE_CLASS = /(^|[-_\s])(value|data|val|number|stat|figure|description)([-_\s]|$)/i;
  $('[class]').each((_, el) => {
    if (!LABEL_CLASS.test($(el).attr('class') || '')) return;
    const next = $(el).next();
    if (next.length && VALUE_CLASS.test(next.attr('class') || '')) add($(el).text(), cellValue($, next), 'label and value');
  });
  return out;
}

/** "Label: value" lines, and a label line followed by a short value line, taken from the page text in reading order. */
function lineText(blocks) {
  const out = [];
  const known = (t) => LABELS.some(([, re]) => re.test(t)) || TYPE_LABELS.some((re) => re.test(t)) || TEST_LABELS.test(t) || DEMO_LABELS.test(t) || SPORTS_LABEL.test(t) || DEADLINE_LABELS.test(t);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.z === 'nav' || b.z === 'footer') continue;
    const t = clean(b.text);
    if (t.length > 160) continue;
    const m = /^([A-Za-z%#.&/'’() -]{3,60}?):\s*(\S.{0,140})$/.exec(t);
    if (m) { out.push({ label: m[1].trim(), value: m[2].trim(), how: 'line', text: t }); continue; }
    const nxt = blocks[i + 1];
    if (nxt && t.length <= 60 && known(t.replace(/:$/, '')) && clean(nxt.text).length <= 120) out.push({ label: t.replace(/:$/, ''), value: clean(nxt.text), how: 'label then value', text: `${t.replace(/:$/, '')}: ${clean(nxt.text)}` });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the facts → fields ---
function address(rec) {
  for (const n of rec.jsonld || []) {
    const types = [].concat(n && n['@type'] || []).join(' ');
    const a = n && n.address;
    if (/School|EducationalOrganization|Organization|CollegeOrUniversity/i.test(types) && a && typeof a === 'object' && a.streetAddress && a.addressLocality) {
      const tail = [a.addressRegion, a.postalCode].filter(Boolean).join(' ');
      return { value: [a.streetAddress, a.addressLocality, tail].filter(Boolean).join(', '), text: `Structured data on the page: ${a.streetAddress}, ${a.addressLocality}, ${tail}`.replace(/,\s*$/, '') };
    }
  }
  return null;
}

/**
 * rec: the saved page after parseHtml, plus _html. Returns { fields, pairs } where fields only holds answers that were found:
 * { status: 'found', value, confidence, sources: [{ url, title }], snippet, how }.
 */
function readFacts(rec, source) {
  const $ = cheerio.load(rec._html || '');
  const review = source === 'psr' || source === 'bsr';
  const seenPair = new Set();
  const pairs = [...structuredPairs($, review), ...(review && $('.dt-row').length ? [] : lineText(rec.blocks || []))]
    .filter((p) => { const k = `${p.label}|${p.value}`.toLowerCase(); if (seenPair.has(k)) return false; seenPair.add(k); return true; });
  const url = rec.finalUrl || rec.url, title = rec.title || '';
  const fields = {};
  const set = (key, value, text, how) => {
    if (value == null || value === '' || fields[key]) return;
    fields[key] = { status: 'found', value: String(value), confidence: 'medium', sources: [{ url, title }], snippet: clip(text, 460), how };
  };

  for (const p of pairs) {
    for (const [key, re, read] of LABELS) {
      if (fields[key] || !re.test(p.label)) continue;
      const v = read(p.value);
      if (v) set(key, v, p.text, p.how);
    }
  }
  const mine = (re) => pairs.filter((p) => re.test(p.label));

  // school type: religious affiliation, student body (all-girls, co-ed), day or boarding
  const typeText = pairs.filter((p) => TYPE_LABELS.some((re) => re.test(p.label)) && !/^(none|n\/a|not applicable)$/i.test(p.value));
  if (typeText.length) {
    const words = TYPE_WORDS.filter(([, re]) => typeText.some((p) => re.test(p.value))).map(([w]) => w);
    if (words.length) set('schoolType', words.join(' | '), typeText.map((p) => p.text).join(' · '), typeText[0].how);
  }
  // test scores: one line per test
  const tests = [], seenTest = new Set();
  for (const p of mine(TEST_LABELS)) {
    const n = numIn(p.value);
    const name = (/\b(sat|act|ssat|isee|hspt)\b/i.exec(p.label) || [])[1];
    if (n == null || !name || seenTest.has(name.toUpperCase())) continue;
    seenTest.add(name.toUpperCase());
    tests.push({ line: `Average ${name.toUpperCase()} score: ${p.value.replace(/\s*\(.*$/, '')}`, text: p.text });
  }
  if (tests.length) set('testScores', tests.map((t) => t.line).join('\n'), tests.map((t) => t.text).join(' · '), 'facts');
  // sports: a list of names (a bare count such as "11 sports" is not a list)
  for (const p of mine(SPORTS_LABEL)) {
    if (/^\d+\s*(sports)?$/i.test(p.value) || p.value.length < 4) continue;
    set('sports', p.value.replace(/\s*[|;]\s*/g, ', '), p.text, p.how);
  }
  // student body figures
  const demo = mine(DEMO_LABELS).filter((p) => /\d/.test(p.value)).slice(0, 4);
  if (demo.length) set('demographics', demo.map((p) => `${p.label.replace(/^%\s*/, '')}: ${p.value}`).join('\n'), demo.map((p) => p.text).join(' · '), demo[0].how);
  // application dates
  const dl = mine(DEADLINE_LABELS).filter((p) => /\w/.test(p.value) && p.value.length <= 60)[0];
  const aid = mine(AID_DEADLINE).filter((p) => /\w/.test(p.value) && p.value.length <= 60)[0];
  if (dl) set('timeline', [`Application deadline: ${dl.value}`, aid ? `Financial aid deadline: ${aid.value}` : null].filter(Boolean).join('\n'), [dl.text, aid && aid.text].filter(Boolean).join(' · '), dl.how);
  // where the school is
  const addr = address(rec);
  if (addr) set('location', addr.value, addr.text, 'structured data');
  return { fields, pairs: pairs.length };
}

/** Fields the application platform can answer. Everything else is left to the school's website and the review sites. */
const RAVENNA_RULE_FIELDS = ['applicationOpenDate', 'timeline', 'application', 'recommendations', 'transcripts', 'testingPolicy', 'interviews', 'pws', 'essays', 'guideEvents', 'decisionDate', 'tuition', 'infoSessions', 'openHouse', 'tours'];

/** Application pages are written as sentences and sections, so the school-website rules are run on them too (only on the fields above). */
function readApplicationText(rec, school, now) {
  const page = { ...rec, topics: ['admissions', 'process', 'dates', 'faq', 'visit', 'tuition'] };
  const all = extractSchool(school, { pages: [page], portals: [], status: 'ok', start: school.website || rec.finalUrl }, now);
  const out = {};
  for (const k of RAVENNA_RULE_FIELDS) if (all[k] && all[k].status === 'found') out[k] = { ...all[k], how: 'text rules' };
  return out;
}

/**
 * One saved page → answers. `source` is 'ravenna' | 'niche' | 'psr' | 'bsr'. A labelled fact always beats a rule's guess for the same field.
 */
function readSavedPage(rec, source, school, now = new Date()) {
  const facts = readFacts(rec, source);
  const fields = { ...facts.fields };
  if (source === 'ravenna') {
    let rules = {};
    try { rules = readApplicationText(rec, school, now); } catch { /* the labelled facts are still used */ }
    for (const [k, v] of Object.entries(rules)) if (!fields[k]) fields[k] = v;
  }
  return { fields, pairs: facts.pairs };
}

module.exports = { readSavedPage, readFacts, RAVENNA_RULE_FIELDS, parseHtml };
