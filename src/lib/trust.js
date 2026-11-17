'use strict';
// An automatic "how likely is this value right?" score for the key FACTS the scraper finds (tuition, enrollment, ratio, class size,
// faculty degrees, location, grades, the two dates, college %, counselors), so researchers can skip the values that are very likely
// fine and spend their time on the doubtful ones. Copied sections of text (mission statement, application steps ...) are not scored:
// they are quotes, and a researcher reads them anyway.
//
// THE SCORE DOES NOT LOOK AT YOUR SHEET. The sheet can be old or wrong, so agreeing with it proves little and disagreeing with it proves
// nothing. A value is trusted for where it came from and how plainly the page states it:
//   - the SOURCE: the school's own fact sheet or profile is the most reliable; its own page about that exact topic (the tuition page for
//     tuition, the college counseling page for counselors) is next; a general page is weaker; a news or blog post is weaker still,
//   - the same value stated on several pages of the school's site, or other pages giving a different value,
//   - the quote shown really contains the number,
//   - the page says which school year (or which admission cycle) the figure is for, and whether that is the current one,
//   - the page says which division the number covers,
//   - whether the value is impossible or unusual for that field, or was counted by the scraper instead of stated by the school,
//   - whether the website in your list looks like a different school.
// The result is a probability-style score (1 to 99) and a plain-words reason for every move.
//
// WHERE THE NUMBERS COME FROM. Nothing here was measured against real accuracy yet: the starting number for each field is a judgement of how
// plainly the rule can read it (a labelled grade range is easy, a headcount that may cover one division or the whole school is not), and the
// size of each move is a judgement of how much that evidence matters. Your Right / Wrong spot-checks are the only real yardstick: once a
// field has enough checks its own measured accuracy replaces the starting number, and the Accuracy tab shows whether each level really holds up.
// What the score cannot catch is a rule reading the wrong number from a good source, so Ready to use means "the evidence is strong",
// not "certain".

// Starting chance that a value for this field is right before looking at where it came from. `primary` are the page topics that are
// about exactly this subject; `topics` also includes pages that merely touch on it.
const FIELDS = {
  grades: { baseline: 0.85, altsAreNormal: true, primary: ['facts'], topics: ['facts', 'about', 'admissions', 'home'] },
  location: { baseline: 0.85, address: true, altsAreNormal: true, primary: ['contact'], topics: ['contact', 'about', 'home', 'visit'] },
  classSize: { baseline: 0.75, hard: [2, 45], typical: [6, 26], primary: ['facts'], topics: ['facts', 'about', 'academics', 'pdf'] },
  collegeEnrollment: { baseline: 0.75, hard: [1, 100], typical: [30, 100], primary: ['college', 'facts'], topics: ['college', 'facts', 'academics', 'pdf'] },
  applicationOpenDate: { baseline: 0.70, yearly: true, date: true, months: [7, 8, 9, 10, 11, 0], primary: ['dates', 'process', 'admissions'], topics: ['admissions', 'process', 'dates', 'visit'] },
  tuition: { baseline: 0.72, yearly: true, hard: [2000, 150000], typical: [8000, 90000], primary: ['tuition'], topics: ['tuition', 'admissions', 'facts', 'pdf'] },
  decisionDate: { baseline: 0.68, yearly: true, date: true, months: [0, 1, 2, 3], primary: ['dates', 'process', 'admissions'], topics: ['admissions', 'process', 'dates', 'visit'] },
  facultyDegrees: { baseline: 0.78, hard: [1, 100], typical: [25, 100], primary: ['facts'], topics: ['facts', 'about', 'academics', 'pdf'] },
  ratio: { baseline: 0.62, hard: [1, 40], typical: [3, 20], primary: ['facts'], topics: ['facts', 'about', 'academics', 'pdf'] },
  enrollment: { baseline: 0.55, hard: [5, 15000], typical: [40, 3500], primary: ['facts'], topics: ['facts', 'about', 'pdf', 'admissions'] },
  counselors: { baseline: 0.40, hard: [0, 80], typical: [1, 18], primary: ['college'], topics: ['college', 'about', 'contact'] },
};
const NUMERIC_COMPARE = new Set(['tuition', 'enrollment', 'ratio', 'classSize', 'facultyDegrees', 'collegeEnrollment', 'counselors']);
const LEVELS = { high: 88, medium: 65 };              // score at or above -> level
const LABEL = { high: 'Safe to use', medium: 'Quick look', low: 'Check this' };
const MIN_PRIOR_CHECKS = 10;                           // fewer spot-checks than this do not replace a field's starting number
const PRIOR_WEIGHT = 10;                               // how many "virtual checks" the starting number is worth when blending with real ones

// Size of each move, in log-odds (about 0.5 is roughly +10 points from a 70% start).
const W = {
  // where it came from
  official: 1.5, dedicated: 0.8, related: 0.3, general: -0.3, newsy: -0.8,
  // other pages
  pages2: 0.3, pages3: 0.6, pages5: 0.9, conflictEach: -0.3, conflictMax: -0.6, ownPagesDisagree: -0.6,
  // how plainly the page states it
  quoteShows: 0.3, quoteMissing: -1.5, counted: -1.3, divisionUnclear: -1.2, partialCount: -1.0, ruleConfidence: 0.15,
  // years and dates
  yearCurrent: 0.5, yearOld1: -0.7, yearOld2: -1.4, noYear: -1.2, noYearDate: -0.4, monthOnly: -0.8, otherAddresses: -1.0, campusLabelled: 0.8, campusGuess: -1.0, dateYearOk: 0.6, dateYearOld: -1.2, dateOdd: -0.7, earlyRound: -1.5,
  // plausibility
  hard: -2.5, unusual: -0.8, address: 0.3, noAddress: -0.6,
};
const WORD_FOR = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NEWSY = /\/(news|blog|stories|story|article|articles|press|events?|calendar|archive|magazine|podcast)(\/|-|$)/i;
const FACTSY = /(profile|fact[-_ ]?sheet|facts|at[-_]?a[-_]?glance|quick[-_]?facts|fast[-_]?facts)/i;

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const firstNumber = (s) => { const m = String(s == null ? '' : s).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
const squeeze = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isFact = (key) => Object.prototype.hasOwnProperty.call(FIELDS, key);
const cap = (m) => MONTHS[m].replace(/^./, (c) => c.toUpperCase());

/** The academic year the person is working on: in July or later it is the year that just began, before that the one under way. */
function currentYearStart(now = new Date()) { return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1; }

function numberOf(key, field) {
  if (field.num != null && Number.isFinite(Number(field.num))) return Number(field.num);
  if (key === 'ratio') { const m = /(\d{1,2})\s*(?::|to)\s*(\d{1,2})/i.exec(String(field.value || '')); if (m) return Math.max(Number(m[1]), Number(m[2])); }
  return null;
}
function monthOf(value) {
  const t = String(value || '');
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) return Number(iso[2]) - 1;
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(t);
  return m ? MONTHS.indexOf(m[1].toLowerCase()) : null;
}

/**
 * How reliable the page(s) a value came from are, for this field. Returns { tier, text, effect } or null when nothing is known.
 *   official   the school's own fact sheet, profile or "at a glance" page
 *   dedicated  the school's own page about exactly this subject
 *   related    a page that touches on it
 *   general    some other page of the site
 *   news       a news, blog or events post (only when no better source is listed)
 */
function sourceTier(rule, urls, pages) {
  if (!urls.length) return null;
  const pageOf = (u) => (pages || []).find((p) => p && p.url && (p.url === u || p.url.replace(/\/$/, '') === String(u).replace(/\/$/, '')));
  let best = null; const rank = { official: 4, dedicated: 3, related: 2, general: 1 };
  for (const u of urls) {
    if (NEWSY.test(u)) continue;
    const p = pageOf(u), topics = (p && p.topics) || [];
    let tier = 'general';
    if (topics.includes('facts') || FACTSY.test(u) && (!p || p.kind === 'pdf' || topics.includes('pdf'))) tier = 'official';
    else if (topics.some((t) => rule.primary.includes(t))) tier = 'dedicated';
    else if (topics.some((t) => rule.topics.includes(t))) tier = 'related';
    if (!best || rank[tier] > rank[best]) best = tier;
  }
  if (!best) return { tier: 'news', text: 'From a news, blog or events page', effect: W.newsy };
  return {
    official: { tier: 'official', text: 'From the school’s own fact sheet or profile (a very reliable source)', effect: W.official },
    dedicated: { tier: 'dedicated', text: 'From the school’s own page about this topic (a reliable source)', effect: W.dedicated },
    related: { tier: 'related', text: 'From a page that touches on this topic', effect: W.related },
    general: { tier: 'general', text: 'From a general page, not one about this topic', effect: W.general },
  }[best];
}

/** Per-field accuracy measured by the person's spot-checks: { field -> { n, p } }, only where there are enough checks to mean something. */
function priorsFromChecks(checks) {
  const by = new Map();
  for (const c of Object.values(checks || {})) {
    if (!c || (c.verdict !== 'correct' && c.verdict !== 'wrong')) continue;
    const t = by.get(c.field) || by.set(c.field, { n: 0, ok: 0 }).get(c.field);
    t.n++; if (c.verdict === 'correct') t.ok++;
  }
  const out = new Map();
  for (const [f, t] of by) if (t.n >= MIN_PRIOR_CHECKS) out.set(f, { n: t.n, p: t.ok / t.n });
  return out;
}

/**
 * One value's trust, or null for a field that is not scored (copied text sections). The sheet is deliberately not an input.
 *   key, field   the template row key and the scraper's answer ({ value, confidence, sources, snippet, num, seen, alts, note })
 *   pages        the school's pages ({ url, topics, kind }), to learn what kind of page each source was
 *   identityBad  the website in the list looks like a different school
 *   prior        { n, p } from the person's spot-checks on this field, if there are enough
 * Returns { score 1-99, level, triage ('ready' | 'check' | 'doubtful'), needsReview, reasons: [{ text, effect }] } where effect is the
 * move in points that signal caused (0 for plain information).
 */
function scoreValue({ key, field, pages, identityBad, prior, now = new Date() }) {
  if (!isFact(key) || !field || field.status !== 'found') return null;
  const rule = FIELDS[key];
  const reasons = [];
  const value = String(field.value == null ? '' : field.value);
  const note = String(field.note || '');
  let needsReview = false;

  // the starting point: the person's own measured accuracy blended in once there are enough checks, else the rule's own clarity
  let p0 = rule.baseline;
  let startText = `Starting point for this field: ${Math.round(rule.baseline * 100)}% (how plainly the rule can read it)`;
  if (prior && prior.n >= MIN_PRIOR_CHECKS) {
    p0 = (prior.n * prior.p + PRIOR_WEIGHT * rule.baseline) / (prior.n + PRIOR_WEIGHT);
    startText = `Your spot-checks found this field right ${Math.round(prior.p * 100)}% of the time (${prior.n} checks)`;
  }
  let z = logit(clampN(p0, 0.02, 0.985));
  reasons.push({ text: startText, effect: 0 });
  const move = (w, text) => {
    const before = sigmoid(z);
    z += w;
    reasons.push({ text, effect: Math.round((sigmoid(z) - before) * 100) });
  };

  // the rule's own mark counts for very little
  if (field.confidence === 'high') z += W.ruleConfidence; else if (field.confidence === 'low') z -= W.ruleConfidence;

  // where it came from
  const sourceUrls = [...new Set((field.sources || []).map((s) => s && s.url).filter(Boolean))];
  const src = sourceTier(rule, sourceUrls, pages);
  if (src) move(src.effect, src.text);

  // how plainly the page states it
  const counted = /counted from/i.test(note);
  if (counted) move(W.counted, 'Counted from job titles, not a number the school states');
  // (a counted number is never printed in the quote, so a missing number is only a warning for stated ones)
  if (field.num != null && rule.hard && field.snippet && !counted) {
    const shown = String(field.snippet).replace(/(\d),(?=\d{3}\b)/g, '$1');
    // "Our five counselors": a small number written as a word is still shown
    const word = WORD_FOR[field.num] && new RegExp('\\b' + WORD_FOR[field.num] + '\\b', 'i').test(shown);
    if (word || new RegExp('(^|[^\\d.])' + String(field.num).replace('.', '\\.') + '([^\\d]|$)').test(shown)) move(W.quoteShows, 'The quote shows the number');
    else move(W.quoteMissing, 'The quote does not show the number');
  }
  if (rule.yearly) {
    const cur = currentYearStart(now);
    const yn = /School year on the page:\s*(\d{4})\D{1,3}(\d{2,4})/i.exec(note);
    if (yn) {
      const gap = cur - Number(yn[1]);
      const label = `${yn[1]}–${yn[2].slice(-2)}`;
      if (gap <= 0) move(W.yearCurrent, `The page says this is for ${label}, the current school year`);
      else if (gap === 1) move(W.yearOld1, `The page's figure is for ${label}, a year old`);
      else move(W.yearOld2, `The page's figure is for ${label}, ${gap} years old`);
    } else if (/no school year|gives no year/i.test(note)) move(rule.date ? W.noYearDate : W.noYear, rule.date ? 'The page gives no year for this date' : 'The page does not say which school year this is for');
  }
  if (/early-round or late-applicant/i.test(note)) move(W.earlyRound, 'This looks like an early-round or late-applicant date, not the main one');
  if (/only the day or only the boarding/i.test(note)) move(W.partialCount, 'This counts only the day or only the boarding students');
  if (/only a month is given/i.test(note)) move(W.monthOnly, 'Only a month is given on the page, not a date');
  if (/does not say which division|whole school/i.test(note)) move(W.divisionUnclear, 'The page does not say which division this covers (it may be the whole school)');

  // other pages of the school's site
  const pagesAgree = Math.max(Number(field.seen) || 1, sourceUrls.length);
  if (pagesAgree >= 5) move(W.pages5, `The same value was found on ${pagesAgree} pages`);
  else if (pagesAgree >= 3) move(W.pages3, `The same value was found on ${pagesAgree} pages`);
  else if (pagesAgree >= 2) move(W.pages2, `The same value was found on ${pagesAgree} pages`);
  if (Array.isArray(field.alts) && field.alts.length && !rule.altsAreNormal) {   // a school lists a grade range for every division and may have several campuses: those are not conflicts
    const numeric = NUMERIC_COMPARE.has(key);
    const norm = (v) => (numeric ? firstNumber(v) : squeeze(v));
    const mine = norm(value);
    // text is "the same" when one wording contains the other (an address with a stray prefix is still the address)
    const sameText = (a, b) => a === b || (a && b && (a.includes(b) || b.includes(a)));
    const others = field.alts.filter((a) => { const v = norm(a.value); return v != null && v !== '' && (numeric ? v !== mine : !sameText(v, mine)); });
    const distinct = [...new Set(others.map((a) => norm(a.value)))];
    if (distinct.length) move(Math.max(W.conflictMax, W.conflictEach * distinct.length), `Another page says ${others.slice(0, 2).map((a) => `“${String(a.value).slice(0, 40)}”`).join(' and ')}`);
  }
  // a school with several campuses lists several addresses: the rule's answer is solid when the site labels the campus for this division
  // ("Short Hills Campus: Grades K-5"), and a guess when it does not
  if (key === 'location') {
    if (/labels this campus for this division/i.test(note)) move(W.campusLabelled, 'The school’s own pages label this campus for this division');
    else if (/more than one address; check which campus/i.test(note)) move(W.campusGuess, 'The school lists several campuses and nothing says which one this division uses');
    else if (Array.isArray(field.alts)) {
      const zip = (t) => (/\b(\d{5})(?:-\d{4})?\b|\b([A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})\b/.exec(String(t || '')) || []).slice(1).find(Boolean) || null;
      const mine = zip(value);
      if (mine && field.alts.some((a) => { const z = zip(a.value); return z && z !== mine && /\b\d{1,5}\b/.test(String(a.value)); })) move(W.otherAddresses, 'The school lists an address in another town or postal code too (it may have more than one campus)');
    }
  }
  // the rule itself found two answers of nearly equal weight on the school's own pages
  if (/own pages do not agree/i.test(note)) { move(W.ownPagesDisagree, 'The school’s own pages give different answers'); needsReview = true; }

  // is it plausible
  const n = numberOf(key, field);
  if (n != null && rule.hard) {
    if (n < rule.hard[0] || n > rule.hard[1]) { move(W.hard, `${value.slice(0, 24)} looks impossible for this field`); needsReview = true; }
    else if (rule.typical && (n < rule.typical[0] || n > rule.typical[1])) move(W.unusual, `${value.slice(0, 24)} is unusual for this field`);
  }
  if (rule.date) {
    const yr = /\b(20\d{2})\b/.exec(value);
    const m = monthOf(value);
    if (yr) {
      // admission cycles turn over on July 1, so March 2026 is already last cycle's date even though the year is "this" one
      const year = Number(yr[1]), cur = currentYearStart(now);
      const before = year < cur || (year === cur && m != null && m < 6);
      if (before) move(W.dateYearOld, `The date is from ${m != null ? cap(m) + ' ' : ''}${year}, before this admission cycle`);
      else if (year <= cur + 1) move(W.dateYearOk, `The date includes the year (${year}), which fits this admission cycle`);
    }
    if (m != null && rule.months && !rule.months.includes(m)) move(W.dateOdd, `A ${cap(m)} date is unusual for this`);
  }
  if (rule.address) {
    const hasNumber = /\b\d{1,5}\b/.test(value), hasPost = /\b\d{5}(?:-\d{4})?\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/.test(value);
    if (hasNumber && hasPost) move(W.address, 'Has a street number and a postal code');
    else move(W.noAddress, 'No street number or postal code');
  }

  let score = clampN(Math.round(sigmoid(z) * 100), 1, 99);
  if (identityBad) { score = Math.min(score, 5); reasons.unshift({ text: 'The website in your list looks like a different school, so none of its values can be trusted', effect: 0 }); needsReview = true; }
  const level = score >= LEVELS.high ? 'high' : score >= LEVELS.medium ? 'medium' : 'low';
  const triage = identityBad || level === 'low' ? 'doubtful' : level === 'high' && !needsReview ? 'ready' : 'check';
  return { score, level, triage, needsReview, reasons };
}

/** The reasons worth showing first: what lowered the score, then what raised it, then plain information. */
const topReasons = (t, n = 3) => [...t.reasons.filter((r) => r.effect < 0), ...t.reasons.filter((r) => r.effect > 0), ...t.reasons.filter((r) => r.effect === 0)].slice(0, n).map((r) => r.text);

// W and FIELDS are exported so that tools/monte-carlo.js can vary them to test how sensitive the ratings are; nothing else changes them.
module.exports = { scoreValue, priorsFromChecks, topReasons, isFact, currentYearStart, sourceTier, FIELDS, W, LEVELS, LABEL, MIN_PRIOR_CHECKS };
