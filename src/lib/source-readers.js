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
const { extractSchool, TYPE_WORDS, divisionFit } = require('./rules');

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
// the share of students on aid and its average: kept as a note on the tuition answer, not as a question of its own
const AID_LABELS = /^(received|students receiving|% on) financial aid$|^average financial aid$/i;
// Niche words the application questions its own way ("Interview Required: Yes", "Required/Recommended Tests: None", "Application Fee: $50"):
// [template row, label, what a usable value looks like]. The answer keeps Niche's own words.
const GUIDE = [
  ['interviews', /^interviews?( required)?$|^interview requirements?$/i, (v) => v.length <= 60 && /^(yes|no|required|recommended|optional|not required|by invitation|sometimes|none)\b/i.test(v)],
  ['testingPolicy', /^required\/recommended tests?$|^(required|recommended) tests?$|^admissions? tests?( required)?$/i, (v) => v.length <= 80 && !/[.!?]$/.test(v)],
  ['application', /^application fee$/i, (v) => v.length <= 40 && /\$\s?\d|free|waived|none/i.test(v)],
];

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

const isKnownLabel = (t) => LABELS.some(([, re]) => re.test(t)) || TYPE_LABELS.some((re) => re.test(t)) || TEST_LABELS.test(t) || DEMO_LABELS.test(t) || SPORTS_LABEL.test(t)
  || DEADLINE_LABELS.test(t) || AID_DEADLINE.test(t) || AID_LABELS.test(t) || GUIDE.some(([, re]) => re.test(t));
// a line that explains a figure ("Average SAT composite score out of 1600, as reported by ... Please contact the school.") rather than being one
const looksLikeExplanation = (t) => t.length > 120 || (t.length > 25 && /[.!?]$/.test(t));

/**
 * "Label: value" lines, and a known label followed by its value, taken from the page text in reading order.
 * Many sites put a one-sentence explanation between a label and its value ("Student-Teacher Ratio", then a sentence about how it is
 * worked out, then "10:1"), so up to three following lines are offered as the value, stopping at the next label; the first one that
 * reads as that fact's kind of value wins. The page's own navigation and footer are skipped, but a page whose code marks its whole
 * content area as "navigation" (Niche) is still read.
 */
function lineText(blocks) {
  const out = [];
  const body = blocks.filter((b) => b.z !== 'footer' && b.z !== 'header');
  for (let i = 0; i < body.length; i++) {
    const t = clean(body[i].text);
    if (t.length > 160) continue;
    const m = /^([A-Za-z%#.&/'’() -]{3,60}?):\s*(\S.{0,140})$/.exec(t);
    if (m) { out.push({ label: m[1].trim(), value: m[2].trim(), how: 'line', text: t }); continue; }
    const label = t.replace(/:$/, '');
    if (t.length > 60 || !isKnownLabel(label)) continue;
    for (let j = 1; j <= 3 && body[i + j]; j++) {
      const v = clean(body[i + j].text);
      if (isKnownLabel(v.replace(/:$/, ''))) break;           // the next label starts: this one had no value
      if (!v || looksLikeExplanation(v)) continue;
      out.push({ label, value: v, how: 'label then value', text: `${label}: ${v}` });
    }
  }
  return out;
}

const STREET_END = /\b(street|st|avenue|ave|broadway|boulevard|blvd|road|rd|drive|dr|lane|ln|way|place|pl|court|ct|plaza|square|parkway|pkwy|highway|hwy|circle|terrace|row|alley|walk)\b\.?/i;
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, n, s) => n + s.toLowerCase());

/**
 * What a page shows in its own layout rather than as a label and value: the grades and city under the school's name, the tags
 * ("Private", "Online School", "NAIS Member"), the address block, and the text the school wrote about itself.
 */
function pageSections(blocks) {
  const body = blocks.filter((b) => b.z !== 'footer' && b.z !== 'header');
  const text = (b) => clean(b.text);
  const out = { pairs: [], about: null, academics: null, partners: [], address: null };
  const top = body.slice(0, 60);
  const gradesBlock = top.find((b) => text(b).length <= 8 && READ.grades(text(b)));
  if (gradesBlock) out.pairs.push({ label: 'Grades', value: text(gradesBlock), how: 'page header', text: `Grades: ${text(gradesBlock)}` });
  const cs = top.map((b) => /^([A-Z][A-Za-z .'-]{1,40}),\s*([A-Z]{2})$/.exec(text(b))).find(Boolean);
  // the tags under the "About" heading: Private, Online School, NAIS Member, ...
  const ai = body.findIndex((b) => b.k === 'h' && /^About\b/i.test(text(b)));
  if (ai >= 0) {
    const tags = [];
    for (let j = ai + 1; j < body.length && j < ai + 14; j++) {
      if (body[j].k === 'h') { if (tags.length) break; else continue; }
      if (body[j].k === 'li' && text(body[j]).length <= 40) tags.push(text(body[j]));
    }
    if (tags.length) out.pairs.push({ label: 'School type', value: tags.join(' '), how: 'tags', text: `School type: ${tags.join(', ')}` });
    for (const t of tags) { const mm = /^([A-Z]{3,8}) Member$/.exec(t); if (mm) out.partners.push(mm[1]); }
  }
  // the address block: "447 BROADWAY NEW YORK, NY 10013" (the city is known from the header, else the last street word ends the street)
  const ab = body.find((b) => /^\d{1,6}\s+[^,]{3,80},\s*[A-Z]{2}\s+\d{5}(-\d{4})?$/.test(text(b)));
  if (ab) {
    const m = /^(\d{1,6}\s+[^,]{3,80}),\s*([A-Z]{2})\s+(\d{5})/.exec(text(ab));
    let street = m[1], city = '';
    if (cs && street.toLowerCase().endsWith(cs[1].toLowerCase()) && street.length > cs[1].length + 3) { city = cs[1]; street = street.slice(0, street.length - cs[1].length); }
    else { const all = [...street.matchAll(new RegExp(STREET_END.source, 'gi'))]; const last = all[all.length - 1]; if (last && last.index + last[0].length < street.length) { city = street.slice(last.index + last[0].length); street = street.slice(0, last.index + last[0].length); } }
    street = street.replace(/[\s,]+$/, '');
    city = clean(city);
    if (street && city) out.address = { value: `${titleCase(street)}, ${titleCase(city)}, ${m[2]} ${m[3]}`, text: `Address on the page: ${text(ab)}` };
  }
  // text the school wrote about itself: "From Aeon School", "Academics at AEON"
  const paragraphAfter = (i) => { for (let j = i + 1; j < body.length && j <= i + 3; j++) { if (body[j].k === 'h') return null; const t = text(body[j]); if (body[j].k === 'p' && t.length >= 60) return t; } return null; };
  const fi = body.findIndex((b) => b.k === 'h' && /^From (?!the school$)[A-Z]/.test(text(b)));
  if (fi >= 0) { const t = paragraphAfter(fi); if (t) out.about = { value: clip(t, 900), text: `${text(body[fi])}: ${t}` }; }
  const ci = body.findIndex((b) => b.k === 'h' && /^Academics at\b/i.test(text(b)));
  if (ci >= 0) { const t = paragraphAfter(ci); if (t) out.academics = { value: clip(t, 900), text: `${text(body[ci])}: ${t}` }; }
  return out;
}

// ------------------------------------------------------------------------------------------------ the facts → fields ---
function address(rec) {
  for (const n of rec.jsonld || []) {
    const types = [].concat(n && n['@type'] || []).join(' ');
    const a = n && n.address;
    // only the school's own record: a page's "Organization" entry is the site's publisher (Niche's own office in Pittsburgh), not the school
    if (/\bSchool\b|EducationalOrganization/i.test(types) && a && typeof a === 'object' && a.streetAddress && a.addressLocality) {
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
function readFacts(rec, source, school) {
  const $ = cheerio.load(rec._html || '');
  const review = source === 'psr' || source === 'bsr';
  const tableLayout = review && $('.dt-row').length > 0;
  const sec = tableLayout ? { pairs: [], about: null, academics: null, partners: [], address: null } : pageSections(rec.blocks || []);
  const seenPair = new Set();
  const pairs = [...structuredPairs($, review), ...(tableLayout ? [] : lineText(rec.blocks || [])), ...sec.pairs]
    .filter((p) => { const k = `${p.label}|${p.value}`.toLowerCase(); if (seenPair.has(k)) return false; seenPair.add(k); return true; });
  const url = rec.finalUrl || rec.url, title = rec.title || '';
  const siteName = source === 'niche' ? 'Niche' : source === 'psr' ? 'Private School Review' : source === 'bsr' ? 'Boarding School Review' : 'this page';
  const fields = {};
  const set = (key, value, text, how, note) => {
    if (value == null || value === '' || fields[key]) return;
    fields[key] = { status: 'found', value: String(value), confidence: 'medium', sources: [{ url, title }], snippet: clip(text, 460), how, ...(note ? { note } : {}) };
  };

  for (const p of pairs) {
    for (const [key, re, read] of LABELS) {
      if (fields[key] || !re.test(p.label)) continue;
      const v = read(p.value);
      if (v) set(key, v, p.text, p.how);
    }
  }
  const mine = (re) => pairs.filter((p) => re.test(p.label));
  // the application questions the site answers in a word or two, in the site's own words
  for (const [key, re, ok] of GUIDE) {
    const p = pairs.find((x) => re.test(x.label) && ok(x.value));
    if (p) set(key, `${p.label}: ${p.value}`, p.text, p.how);
  }
  // text the school wrote about itself on the page, and the memberships it lists
  if (sec.about) set('about', sec.about.value, sec.about.text, 'school’s own text', `This is the school’s own description, as shown on ${siteName}.`);
  if (sec.academics) set('academics', sec.academics.value, sec.academics.text, 'school’s own text', `This is the school’s own text about its academics, as shown on ${siteName}.`);
  if (sec.partners.length) set('partners', sec.partners.join(' | '), `Listed as a member: ${sec.partners.join(', ')}`, 'tags');

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
    tests.push({ name: name.toUpperCase(), label: p.label, line: `Average ${name.toUpperCase()} score: ${p.value.replace(/\s*\(.*$/, '')}`, text: p.text });
  }
  if (tests.length) {
    // some sites (Niche) average what visitors typed in: say so, and how many did
    const counts = tests.map((t) => { const q = pairs.find((p) => p.label === t.label && /^\d+\s+responses?$/i.test(p.value)); return q ? `${t.name} from ${q.value}` : null; }).filter(Boolean);
    const userReported = source === 'niche';
    set('testScores', tests.map((t) => t.line).join('\n'), tests.map((t) => t.text).join(' · '), 'facts',
      userReported ? `Niche says these averages are reported by Niche users from this school, not by the school${counts.length ? ` (${counts.join(', ')})` : ''}.` : null);
  }
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
  const addr = address(rec) || (sec.address ? { ...sec.address, how: 'address block' } : null);
  if (addr) set('location', addr.value, addr.text, addr.how || 'structured data');

  // notes that go with the figures
  const aidShare = (pairs.find((p) => /^(received|students receiving|% on) financial aid$/i.test(p.label)) || {}).value;
  const aidAvg = (pairs.find((p) => /^average financial aid$/i.test(p.label)) || {}).value;
  if (fields.tuition) {
    const bits = [];
    if (source === 'niche') bits.push('Niche says this tuition is for the highest grade offered and may have changed for the current year.');
    if (aidShare || aidAvg) bits.push(`Financial aid: ${[aidShare && `${aidShare} of students receive it`, aidAvg && `average ${aidAvg}`].filter(Boolean).join(', ')}.`);
    if (bits.length) fields.tuition.note = bits.join(' ');
  }
  if (source === 'niche' && fields.ratio) fields.ratio.note = 'Niche works this out from the reported number of students and full-time teachers; it may not match class size.';
  // a page about the whole school (grades 5-12) is not about one division of it (the Upper School, grades 9-12)
  if (school && school.division && fields.grades) {
    const fit = divisionFit(`Grades ${fields.grades.value.replace('–', '-')}`, school.division);
    if (fit !== 1) {
      const msg = `This page covers grades ${fields.grades.value}, wider than the ${school.division} school alone, so check that the figure applies to it.`;
      for (const k of ['enrollment', 'classSize', 'ratio', 'facultyDegrees', 'testScores', 'demographics', 'tuition', 'counselors', 'advancedClasses']) {
        if (fields[k]) fields[k].note = [fields[k].note, msg].filter(Boolean).join(' ');
      }
    }
  }
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

// ----------------------------------------------------------------------------------- Ravenna application pages ---
// A saved Ravenna page is a family's application to one school: the school's name, the grade and year applied for, and the school's own
// steps in order (their names, descriptions, forms, events and due dates). It also holds the applicant's details and sign-in tokens, which
// are never needed and never kept (sanitizeRavenna). The steps are the school's "Admissions Portal" answers: in the sheet they go in the
// Guide to Applying rows' own column B ("Admissions Portal"), next to the website's answers in column C, not in place of them.

const clean1 = (s) => clean(s).replace(/\s*[|]\s*/g, ' ');
/** The first sentences of a text, up to about `max` characters. */
function sentences(text, max) {
  const parts = clean(text).split(/(?<=[.!?])\s+/);
  let out = '';
  for (const s of parts) { if (out && out.length + s.length + 1 > max) break; out += (out ? ' ' : '') + s; if (out.length >= max) break; }
  return clip(out, max + 40);
}
const dueText = (d) => clean(d).replace(/^Forms due by\s*/i, '').replace(/^Due:\s*/i, '');
const RAV_RE = {
  recommend: /recommend|evaluation form|teacher (form|eval)|reference/i,
  transcript: /transcript|school report|academic record|grade report/i,
  testing: /\b(?:ssat|isee|hspt|standardi[sz]ed|testing|tests?)\b/i,
  writing: /writing sample|timed writing|writing exercise|writing assessment/i,
  interview: /interview|shadow|play ?date|student visit|campus visit|classroom visit|observation|assessment/i,
  decision: /decision|notification/i,
};
const GRADE_BAND = (g) => { const x = String(g || '').toUpperCase(); if (/^(PK|PS|TK|K|JK)/.test(x)) return 'lower'; const n = parseInt(x, 10); if (!(n >= 1 && n <= 12)) return null; return n <= 5 ? 'lower' : n <= 8 ? 'middle' : 'upper'; };

/** The steps of a Ravenna application page, in order, without the page's hidden interface states. */
function parseRavenna($) {
  $('[hidden]').remove();
  const t = (el) => clean($(el).text());
  const card = t($('#application-card p').first());
  const meta = {
    school: t('#application-card-school-name'),
    grade: (/\bGrade\s+([A-Za-z0-9]{1,3})\b/.exec(card) || [])[1] || null,
    year: ((/\b(20\d{2}\s*-\s*20\d{2})\b/.exec(card) || [])[1] || '').replace(/\s+/g, '') || null,
  };
  const sections = [];
  let cur = null;
  $('#application-content').find('.application-step-divider, .application-step[id^="step-"]').each((_, el) => {
    const e = $(el);
    if (e.hasClass('application-step-divider')) { cur = { name: t(e.find('.heading')), due: t(e.find('small')), steps: [] }; sections.push(cur); return; }
    if (!cur) { cur = { name: '', due: '', steps: [] }; sections.push(cur); }
    const header = e.find('.application-step-header').first().clone();
    header.find('button, small').remove();
    const forms = [];
    e.find('application-form-item').each((__, fi) => {
      const a = $(fi).find('a').first();
      const nameEl = a.clone(); nameEl.find('span, small, i, br, .icon-container').remove();
      const bits = [];
      a.find('span, small').each((___, x) => { if ($(x).children().length === 0) { const tx = t(x); if (tx) bits.push(tx); } });
      forms.push({
        name: clean(nameEl.text()),
        delegates: ((bits.find((b) => /^Requires\b.*\bdelegates?$/i.test(b)) || '').replace(/^Requires\s*/i, '')) || '',
        due: dueText(bits.find((b) => /^Due:/i.test(b)) || ''),
      });
    });
    const event = e.find('.application-step-item-list a').not('application-form-item a').toArray().some((a) => /register for an event/i.test(t(a)));
    cur.steps.push({
      name: clean(header.text()), due: dueText(t(e.find('.application-step-header small'))),
      desc: e.find('.application-step-body > div > p').map((__, p) => t(p)).get().filter(Boolean).join(' '),
      forms, event,
    });
  });
  return { meta, sections: sections.filter((s) => s.steps.length || s.due) };
}

/** What a saved page says about itself (school name, grade, year), without reading any answers: used to check and place an uploaded page. */
function ravennaMeta(html) {
  try { const m = parseRavenna(cheerio.load(html || '')).meta; return m.school ? m : null; } catch { return null; }
}

function readRavenna(rec) {
  const $ = cheerio.load(rec._html || '');
  const parsed = parseRavenna($);
  const meta = parsed.meta;
  // a "Welcome" step is a greeting, not a step of the application (it may still carry a "Register for an event" link)
  const sections = parsed.sections.map((s) => ({ ...s, steps: s.steps.filter((st) => !(/^welcome/i.test(st.name) && !st.forms.length)) })).filter((s) => s.steps.length);
  const steps = sections.flatMap((s) => s.steps);
  if (!steps.length) return null;
  const url = rec.finalUrl || rec.url, title = rec.title || '';
  const fields = {};
  const put = (key, lines, evidence) => {
    const value = lines.filter(Boolean).join('\n');
    if (value) fields[key] = { status: 'found', value, confidence: 'high', sources: [{ url, title }], snippet: clip(evidence || value, 460), how: 'Ravenna steps' };
  };
  const formNames = (st) => st.forms.map((f) => f.name).join(' ');
  const formMeta = (f) => { const bits = [f.delegates && `requires ${f.delegates}`, f.due && `due ${f.due}`].filter(Boolean); return bits.length ? ` (${bits.join('; ')})` : ''; };
  const describe = (st, max, withForms) => [
    `${st.name}${st.desc ? ': ' + sentences(st.desc, max) : ''}`,
    ...(withForms ? st.forms.map((f) => `- ${f.name}${formMeta(f)}`) : []),
  ];
  const pick = (re) => steps.filter((st) => re.test(`${st.name} ${formNames(st)}`));

  // the steps in order, under the page's own section names ("Preliminary Application Steps", "Additional Steps"), and the application fee
  const lines = [];
  if (meta.year || meta.grade) lines.push(`Admission for ${[meta.year, meta.grade && `Grade ${meta.grade}`].filter(Boolean).join(', ')}`);
  let n = 0;
  for (const sec of sections) {
    const list = sec.steps;
    if (!list.length) continue;
    if (sec.name) lines.push(`${sec.name}${sec.due ? ` (${clean1(sec.due).replace(/^Forms due by/i, 'forms due')})` : ''}`);
    for (const st of list) lines.push(`${++n}. ${st.name}${st.due ? ` (due ${st.due})` : ''}`);
  }
  const fee = steps.filter((st) => /fee|application/i.test(st.name)).map((st) => /application fee[^$.]{0,60}(\$\s?\d[\d,]*(?:\.\d{2})?)|(\$\s?\d[\d,]*(?:\.\d{2})?)\s*(?:non-refundable\s*)?application fee/i.exec(st.desc)).find(Boolean);
  if (fee) lines.push(`Application fee: ${(fee[1] || fee[2]).replace(/\s+/g, '')}`);
  if (n) put('application', lines, steps.slice(0, 3).map((s) => s.name).join(' · '));

  // dates, in page order: the section's "forms due by", then each step and form with its own due date
  const seen = new Set(), dates = [];
  const add = (line) => { if (!seen.has(line)) { seen.add(line); dates.push(line); } };
  for (const sec of sections) {
    if (sec.due) add(`${sec.name || 'Steps'}: forms due ${dueText(sec.due)}`);
    for (const st of sec.steps) {
      if (st.due) add(`${st.name}: due ${st.due}`);
      for (const f of st.forms) if (f.due && f.due !== st.due) add(`${f.name}: due ${f.due}`);
    }
  }
  put('timeline', dates, dates.slice(0, 3).join(' · '));

  const rec1 = pick(RAV_RE.recommend); put('recommendations', rec1.flatMap((st) => describe(st, 260, true)), rec1.map((s) => s.name).join(' · '));
  const tr = pick(RAV_RE.transcript); put('transcripts', tr.flatMap((st) => describe(st, 520, true)), tr.map((s) => s.name).join(' · '));
  const te = pick(RAV_RE.testing); put('testingPolicy', te.flatMap((st) => describe(st, 520, false)), te.map((s) => s.name).join(' · '));
  const pw = pick(RAV_RE.writing); put('pws', pw.flatMap((st) => describe(st, 420, false)), pw.map((s) => s.name).join(' · '));
  const iv = pick(RAV_RE.interview).filter((st) => !RAV_RE.writing.test(st.name)); put('interviews', iv.flatMap((st) => describe(st, 420, false)), iv.map((s) => s.name).join(' · '));
  const ev = steps.filter((st) => st.event); put('guideEvents', ev.map((st) => `${st.name}${st.desc ? ': ' + sentences(st.desc, 220) : ''}`), ev.map((s) => s.name).join(' · '));
  const dc = pick(RAV_RE.decision);
  put('decisionDate', dc.map((st) => { const sent = clean(st.desc).split(/(?<=[.!?])\s+/).find((x) => /decision|notif/i.test(x)); return sent ? clip(sent, 240) : st.name + (st.due ? `: ${st.due}` : ''); }), dc.map((s) => s.name).join(' · '));
  return { fields, meta, pairs: steps.length };
}

/**
 * A saved Ravenna page without the family's details, ready to keep. Removes the scripts, tokens, the applicant's name, birthdate, photo and
 * email, the account holder's name, messages from the school, and how far the family has got with each form; keeps the school's name, the
 * grade and year applied for, and every step with its description, forms, events and due dates.
 */
function sanitizeRavenna(html) {
  const $ = cheerio.load(String(html || ''));
  const meta = parseRavenna(cheerio.load(String(html || ''))).meta;
  $('script, style, iframe, svg, img, link, meta, noscript, template, video, audio, canvas, input, textarea, select, button, form, hub-app, flash, grammarly-desktop-integration, #main-navbar, #footer, #contextHelp, #application-sidebar, .application-icons-legend, [hidden]').remove();
  // the line under the school's name holds the applicant's name ("Avery Placeholder • Grade K Admission for 2027-2028"): keep only the grade and year
  $('#application-card p').first().text([meta.grade && `Grade ${meta.grade}`, meta.year && `Admission for ${meta.year}`].filter(Boolean).join(' '));
  // how far the family has got ("Required questions unanswered or incomplete", "Submitted", "Sent to the 1 required delegate")
  $('application-form-item a span, application-form-item a small').each((_, x) => {
    if ($(x).children().length === 0 && /unanswered|incomplete|ready to submit|submitted|sent to|completed|answered|progress/i.test($(x).text())) $(x).remove();
  });
  $('.text-success').remove();
  // every attribute goes except the ones that give the page its structure
  $('*').each((_, el) => { for (const a of Object.keys(el.attribs || {})) if (a !== 'id' && a !== 'class') $(el).removeAttr(a); });
  const body = $('body').html() || '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Ravenna: ${meta.school ? meta.school.replace(/[<>&]/g, ' ') + ' application' : 'application'}</title></head><body>${body}</body></html>`;
}

/**
 * One saved page → answers. `source` is 'ravenna' | 'niche' | 'psr' | 'bsr'. A labelled fact always beats a rule's guess for the same field.
 */
function readSavedPage(rec, source, school, now = new Date()) {
  if (source === 'ravenna') {
    const rv = readRavenna(rec);
    if (rv) return { fields: rv.fields, pairs: rv.pairs, meta: rv.meta };
  }
  const facts = readFacts(rec, source, school);
  const fields = { ...facts.fields };
  if (source === 'ravenna') {          // a Ravenna page without application steps (another kind of page): read it like any application text
    let rules = {};
    try { rules = readApplicationText(rec, school, now); } catch { /* the labelled facts are still used */ }
    for (const [k, v] of Object.entries(rules)) if (!fields[k]) fields[k] = v;
  }
  return { fields, pairs: facts.pairs };
}

module.exports = { readSavedPage, readFacts, readRavenna, sanitizeRavenna, ravennaMeta, GRADE_BAND, RAVENNA_RULE_FIELDS, parseHtml };
