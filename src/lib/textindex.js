'use strict';
// Builds the three things the field rules search, from the pages of one website:
//   phrases    short "number + label" facts (stat tiles, table rows, one-line facts)
//   sentences  ordinary sentences
//   sections   the text sitting under a heading
// Every item keeps the page it came from, so each answer can show its source.
const { oneLine } = require('./util');

const CONNECT = /(?:\bof|\bfrom|\bto|\bfor|\bis|\bare|\bat|\bin|\bwith|\bthan|\bover|\bby|\bhave|\bhas|\bapproximately|\babout|\bnearly|\bonly|:|—|-)\s*$/i;

const isNumBlock = (t) => t.length <= 16 && /\d/.test(t) && (t.match(/[A-Za-z]/g) || []).length <= 4;
const isLabel = (t) => t.length <= 170 && (t.match(/[A-Za-z]/g) || []).length >= 3 && !isNumBlock(t);

// "Sept. 28" and "4 p.m. on" must not be read as the end of a sentence
const ABBR = /\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec|a\.m|p\.m|St|Dr|Mr|Mrs|Ms|No|vs|approx)\.(?=\s)/g;
function splitSentences(text, keepAll) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const guarded = line.replace(ABBR, '$1․');
    for (const s of guarded.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)) {
      const t = s.replace(/․/g, '.').trim();
      if (keepAll ? t.length > 0 : (t.length >= 20 && t.length <= 600)) out.push(t);
    }
  }
  return out;
}

function buildIndex(pages) {
  const phrases = [], sentences = [], sections = [];
  for (const page of pages) {
    const main = (page.blocks || []).filter((b) => b.z === 'main');
    const flat = main.map((b) => oneLine(b.text));
    const num = flat.map(isNumBlock);
    const lab = flat.map((t, i) => !num[i] && isLabel(t));
    const short = (i) => lab[i] && flat[i].length <= 80;

    // Stat tiles come in two layouts. Number first:  [416] [Students]   [14] [Average class size]
    // Label first:                                    [Enrollment] [416] [Class size] [14]
    // A run is label-first when it starts with a label and nothing label-like follows its last number.
    const labelFirst = new Set();
    for (let i = 0; i < main.length; i++) {
      if (!num[i] || labelFirst.has(i) || !short(i - 1) || num[i - 2]) continue;
      const run = [i];
      let j = i;
      while (short(j + 1) && num[j + 2]) { j += 2; run.push(j); }
      const tailIsLabel = short(j + 1) && main[j + 1].k !== 'h';
      if (run.length >= 2 && !tailIsLabel) run.forEach((x) => labelFirst.add(x));
    }

    const usedAfter = new Set();
    for (let i = 0; i < main.length; i++) {
      const b = main[i];
      // a short block that already holds a number and words is a fact on its own
      if (!num[i] && flat[i].length <= 220 && /\d/.test(flat[i]) && b.k !== 'h') {
        phrases.push({ text: flat[i], form: 'S', page, i });
      }
      if (num[i]) {
        const p = lab[i - 1] ? flat[i - 1] : null;
        const n = lab[i + 1] ? flat[i + 1] : null;
        if (labelFirst.has(i)) {
          phrases.push({ text: `${p} ${flat[i]}`, form: 'B', num: flat[i], before: p, page, i });
        } else if (p && n && CONNECT.test(p) && !usedAfter.has(i - 1)) {
          phrases.push({ text: `${p} ${flat[i]} ${n}`, form: 'C', num: flat[i], before: p, after: n, page, i });
          usedAfter.add(i + 1);
        } else {
          if (n) { phrases.push({ text: `${flat[i]} ${n}`, form: 'A', num: flat[i], after: n, page, i }); usedAfter.add(i + 1); }
          // the label above only belongs to this number if the previous number has not already claimed it
          if (p && !usedAfter.has(i - 1)) phrases.push({ text: `${p} ${flat[i]}`, form: 'B', num: flat[i], before: p, page, i });
        }
      }
      if (b.k !== 'h') for (const s of splitSentences(b.text)) sentences.push({ text: s, page, i, k: b.k });
    }

    // sections: a heading and everything under it, up to the next heading of the same or higher level
    for (let i = 0; i < main.length; i++) {
      const b = main[i];
      const pseudo = b.k === 'p' && flat[i].length <= 70 && !/[.!?]$/.test(flat[i]) && main[i + 1] && flat[i + 1].length > flat[i].length;
      if (b.k !== 'h' && !pseudo) continue;
      const level = b.k === 'h' ? (b.level || 3) : 7;
      const body = [];
      let chars = 0;
      for (let j = i + 1; j < main.length && chars < 2600; j++) {
        const c = main[j];
        if (c.k === 'h' && (c.level || 3) <= level) break;
        if (level === 7 && j > i + 1 && c.k === 'p' && flat[j].length <= 70 && !/[.!?]$/.test(flat[j])) break; // next pseudo-heading
        const t = c.text.trim();
        if (!t) continue;
        body.push(c.k === 'li' ? '• ' + oneLine(t) : c.k === 'h' ? oneLine(t) + ':' : t);
        chars += t.length;
      }
      if (body.length) sections.push({ heading: flat[i], level, text: body.join('\n'), page, i });
    }
  }
  return { phrases, sentences, sections };
}

module.exports = { buildIndex, splitSentences, isNumBlock };
