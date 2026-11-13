'use strict';
// Does the website in the list belong to this school? Every other rule trusts the website, so a wrong link in the
// list (another school's address, a district site) quietly produces a full set of confident but wrong answers.
// The check is deliberately mild: it only complains when NONE of the school's distinctive name words appear
// anywhere in the site's page titles, descriptions, opening text, structured data or web address.
const GENERIC = new Set(['the', 'and', 'for', 'of', 'at', 'in', 'school', 'schools', 'academy', 'day', 'high', 'middle', 'upper', 'lower', 'elementary',
  'junior', 'senior', 'prep', 'preparatory', 'college', 'institute', 'international', 'independent', 'private', 'boarding', 'campus', 'formerly',
  'charter', 'catholic', 'country', 'online', 'learning', 'center', 'centre', 'education', 'educational', 'saint', 'division', 'program', 'programs']);

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter((t) => t.length >= 3 && !GENERIC.has(t));

/** { main, alt }: distinctive words of the name, and of an old name given as "(formerly ...)". */
function nameWords(name) {
  const alt = (String(name).match(/\((?:formerly|f\/k\/a|also known as|aka)\s+([^)]+)\)/i) || [])[1] || '';
  const main = String(name).replace(/\([^)]*\)/g, ' ').replace(/\|.*$/, ' ');   // "Name (Upper) School | Fremont": keep the name, drop the division and campus tail
  const tail = (String(name).split('|')[1] || '');
  return { main: [...new Set(words(main))], alt: [...new Set(words(alt))], tail: [...new Set(words(tail))] };
}

/**
 * pages: crawled pages (title, description, blocks, jsonld, finalUrl). Returns
 * { ok, checked: [words], matched: [words], host } where ok is false only when no word was found.
 * A name with no distinctive words (for example "The School") cannot be checked and is reported ok.
 */
function siteIdentity(school, pages) {
  const w = nameWords(school.name);
  const checked = [...new Set([...w.main, ...w.alt, ...w.tail])];
  let host = '';
  try { host = new URL(school.website || (pages[0] && pages[0].finalUrl) || '').hostname.replace(/^www\./, ''); } catch { /* no usable address */ }
  if (!checked.length) return { ok: true, checked, matched: [], host, note: 'The name has no distinctive words to look for.' };
  const hay = [host.replace(/[^a-z0-9]/gi, '')];
  for (const p of (pages || []).slice(0, 25)) {
    hay.push(p.title, p.description, p.siteName);
    for (const b of (p.blocks || []).slice(0, 12)) hay.push(String(b.text || '').slice(0, 300));
    for (const n of p.jsonld || []) if (n && n.name) hay.push(String(n.name));
  }
  const text = hay.filter(Boolean).join(' \n ').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const squashed = text.replace(/[^a-z0-9]/g, '');
  const matched = checked.filter((t) => new RegExp(`\\b${t}`).test(text) || squashed.includes(t));
  return { ok: matched.length > 0, checked, matched, host };
}

module.exports = { siteIdentity, nameWords };
