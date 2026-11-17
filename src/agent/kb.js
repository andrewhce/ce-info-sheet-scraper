'use strict';
// Autonomous Q&A Knowledge Base persisted in data/agent-kb.json.
// Automatically keeps earlier Ask answers (only ones backed by at least one lookup) and the person's own corrections, so a later
// question can see what was asked before. They are HINTS, never evidence: the assistant is told to confirm every fact with the
// data tools, the newest answer to a question replaces older ones, and an entry is flagged when a newer scrape exists or it is old.
const crypto = require('crypto');
const { readJson, writeJson, redactSecrets, clip } = require('../lib/util');
const { normalizeForGuard } = require('./prompt');

const MAX_KB_ENTRIES = 300;
const KB_FRESH_DAYS = 14;        // an older learned answer is flagged as possibly out of date even if the school was not scraped again

/**
 * Two stored answers to the same question can contradict each other (a later answer fixes an earlier one, or the two used different
 * school sets). Only the newest is kept, so a wrong earlier answer cannot keep coming back next to the right one.
 */
function collapseSameQuestion(entries) {
  const key = (e) => `${e.owner}|${e.kind}|${String(e.question).toLowerCase().replace(/\s+/g, ' ').trim()}`;
  const byKey = new Map();
  for (const e of entries) {
    const k = key(e);
    const cur = byKey.get(k);
    if (!cur) { byKey.set(k, e); continue; }
    const newer = (Date.parse(e.updatedAt) || 0) >= (Date.parse(cur.updatedAt) || 0);
    const keep = newer ? e : cur, drop = newer ? cur : e;
    keep.hits = (keep.hits || 1) + (drop.hits || 1);
    byKey.set(k, keep);
  }
  return [...byKey.values()];
}
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'which', 'when', 'where', 'how',
  'does', 'did', 'are', 'was', 'were', 'can', 'could', 'would', 'should', 'about', 'into',
  'have', 'has', 'had', 'not', 'but', 'all', 'any', 'our', 'your', 'their', 'school', 'schools',
]);

function tokenize(text) {
  return [...new Set(
    normalizeForGuard(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  )];
}

function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  let inter = 0;
  for (const x of b) if (sa.has(x)) inter++;
  return inter / (sa.size + b.length - inter);
}

/** Extracts a concise summary from a markdown answer without leaking control chars or secrets. */
function distillSummary(answerText) {
  const safe = redactSecrets(String(answerText || '')).trim();
  const lines = safe
    .replace(/\[([^\]]+)\]\((#[^)]+)\)/g, '$1')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\|[-:\s|]+\|$/.test(l));
  return clip(lines.join(' ').replace(/\s+/g, ' '), 750);
}

function createKnowledgeBase({ kbFile = null, getOverview = () => null } = {}) {
  let state = null;

  const load = () => {
    if (state) return state;
    const raw = kbFile ? readJson(kbFile) : null;
    const loaded = Array.isArray(raw && raw.entries)
      ? raw.entries.filter((x) => x && typeof x.id === 'string' && typeof x.question === 'string' && typeof x.summary === 'string')
      : [];
    state = collapseSameQuestion(loaded);
    if (state.length !== loaded.length) persist();   // contradictory duplicates are merged once, newest answer kept
    return state;
  };

  const persist = () => {
    if (!kbFile) return;
    writeJson(kbFile, { version: 1, entries: load() }, { mode: 0o600 });
  };

  function latestScrapeFor(schoolIds) {
    if (!Array.isArray(schoolIds) || !schoolIds.length) return null;
    try {
      const ov = getOverview();
      if (!ov || !Array.isArray(ov.schools)) return null;
      const set = new Set(schoolIds);
      let newest = '';
      for (const s of ov.schools) {
        if (set.has(s.id) && s.scrapedAt && s.scrapedAt > newest) newest = s.scrapedAt;
      }
      return newest || null;
    } catch { return null; }
  }

  /** Automatically stores or refreshes a verified Ask Q&A pair after a turn finishes cleanly. */
  function learnTurn({ owner = 'local', question, answer, schoolIds = [], fieldKeys = [], sources = [], usedWebSearch = false, kind = 'qa' } = {}) {
    const cleanQ = clip(redactSecrets(normalizeForGuard(question)), 400);
    const summary = distillSummary(answer);
    if (!cleanQ || cleanQ.length < 10 || !summary || summary.length < 15) return null;

    const all = load();
    const qTokens = tokenize(cleanQ);
    const ids = [...new Set((schoolIds || []).filter((x) => typeof x === 'string' && x))];
    const fields = [...new Set((fieldKeys || []).filter((x) => typeof x === 'string' && x))];
    const cleanSources = (Array.isArray(sources) ? sources : [])
      .filter((s) => s && typeof s.url === 'string' && /^https?:\/\//i.test(s.url))
      .slice(0, 6)
      .map((s) => ({ url: s.url, title: clip(String(s.title || ''), 100) }));
    const now = new Date().toISOString();
    const scrapedAtSnapshot = latestScrapeFor(ids);

    // The same question asked again replaces the earlier answer (the newest answer wins), even if the school set differs this time:
    // keeping both would leave two possibly contradictory answers to one question.
    const existing = all.find((e) => {
      if (e.owner !== owner || e.kind !== kind) return false;
      return e.question.toLowerCase() === cleanQ.toLowerCase() || jaccard(qTokens, e.tokens || tokenize(e.question)) >= 0.78;
    });

    if (existing) {
      existing.question = cleanQ;
      existing.schoolIds = ids;
      existing.summary = summary;
      existing.fullAnswer = clip(redactSecrets(String(answer || '')).trim(), 3000);
      existing.fieldKeys = fields;
      existing.tokens = qTokens;
      existing.sources = cleanSources;
      existing.usedWebSearch = !!usedWebSearch;
      existing.scrapedAtSnapshot = scrapedAtSnapshot;
      existing.hits = (existing.hits || 1) + 1;
      existing.updatedAt = now;
      persist();
      return existing;
    }

    const entry = {
      id: crypto.randomBytes(6).toString('hex'),
      owner,
      kind,
      question: cleanQ,
      summary,
      fullAnswer: clip(redactSecrets(String(answer || '')).trim(), 3000),
      schoolIds: ids,
      fieldKeys: fields,
      tokens: qTokens,
      sources: cleanSources,
      usedWebSearch: !!usedWebSearch,
      scrapedAtSnapshot,
      hits: 1,
      createdAt: now,
      updatedAt: now,
    };
    all.push(entry);

    // Prune oldest least-used entries for this owner beyond MAX_KB_ENTRIES
    const mine = all.filter((e) => e.owner === owner);
    if (mine.length > MAX_KB_ENTRIES) {
      mine.sort((a, b) => (b.hits - a.hits) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const dropIds = new Set(mine.slice(MAX_KB_ENTRIES).map((x) => x.id));
      state = all.filter((e) => !(e.owner === owner && dropIds.has(e.id)));
    }
    persist();
    return entry;
  }

  function schoolMatchIds(qLower) {
    try {
      const ov = getOverview();
      if (!ov || !Array.isArray(ov.schools)) return [];
      const hits = [];
      for (const s of ov.schools) {
        if (!s || !s.name) continue;
        const full = s.name.toLowerCase();
        if (qLower.includes(full)) { hits.push(s.id); continue; }
        const base = full.replace(/\([^)]*\)/g, ' ').replace(/\b(the|school|academy|upper|lower|middle|high)\b/g, ' ').replace(/\s+/g, ' ').trim();
        if (base.length >= 5 && qLower.includes(base)) hits.push(s.id);
      }
      return hits;
    } catch { return []; }
  }

  /** Retrieves top relevant learned Q&As for prompt context or tool search, annotating scrape freshness. */
  function findRelevant(owner, query, { schoolIds = [], limit = 3, minScore = 2 } = {}) {
    const mine = load().filter((e) => e.owner === owner);
    if (!mine.length) return [];
    const qLower = normalizeForGuard(query).toLowerCase();
    const qTokens = tokenize(qLower);
    const mentionedSchools = new Set([...(schoolIds || []), ...schoolMatchIds(qLower)]);
    const ov = (() => { try { return getOverview(); } catch { return null; } })();
    const scrapeMap = new Map(((ov && ov.schools) || []).map((s) => [s.id, s.scrapedAt || null]));

    const scored = [];
    for (const e of mine) {
      let score = 0;
      const eSchools = e.schoolIds || [];
      for (const id of eSchools) if (mentionedSchools.has(id)) score += 12;
      const eTokens = e.tokens || tokenize(e.question + ' ' + e.summary);
      let wordHits = 0;
      for (const t of qTokens) if (eTokens.includes(t)) wordHits++;
      score += wordHits * 2;
      if (e.kind === 'correction' && score > 0) score += 6;
      if (score < minScore) continue;

      let stale = false, staleReason;
      if (e.scrapedAtSnapshot && eSchools.length) {
        for (const id of eSchools) {
          const cur = scrapeMap.get(id);
          if (cur && cur > e.scrapedAtSnapshot) { stale = true; staleReason = 'a newer scrape exists'; break; }
        }
      }
      if (!stale && e.updatedAt && Date.now() - Date.parse(e.updatedAt) > KB_FRESH_DAYS * 86400e3) { stale = true; staleReason = `older than ${KB_FRESH_DAYS} days`; }
      scored.push({
        score,
        id: e.id,
        kind: e.kind,
        question: e.question,
        summary: e.summary,
        schoolIds: eSchools,
        sources: e.sources || [],
        usedWebSearch: !!e.usedWebSearch,
        stale,
        staleReason,
        updatedAt: e.updatedAt,
        hits: e.hits || 1,
      });
    }
    scored.sort((a, b) => b.score - a.score || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return scored.slice(0, limit).map(({ score, ...rest }) => rest);
  }

  function list(owner) {
    return load()
      .filter((e) => e.owner === owner)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map(({ id, kind, question, summary, schoolIds, usedWebSearch, hits, createdAt, updatedAt }) => ({
        id, kind, question, summary, schoolIds, usedWebSearch: !!usedWebSearch, hits: hits || 1, createdAt, updatedAt,
      }));
  }

  function stats(owner) {
    const mine = load().filter((e) => e.owner === owner);
    const newest = mine.reduce((m, e) => (!m || e.updatedAt > m ? e.updatedAt : m), null);
    return { count: mine.length, updatedAt: newest };
  }

  function clear(owner) {
    const all = load();
    const kept = all.filter((e) => e.owner !== owner);
    const removed = all.length - kept.length;
    state = kept;
    if (removed > 0) persist();
    return removed;
  }

  /** Exports redacted chat-format JSONL pairs suitable for evaluations or dataset curation. */
  function exportJsonl(owner) {
    return load()
      .filter((e) => e.owner === owner)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map((e) => JSON.stringify({
        messages: [
          { role: 'user', content: e.question },
          { role: 'assistant', content: e.fullAnswer || e.summary },
        ],
        meta: {
          id: e.id,
          kind: e.kind,
          schoolIds: e.schoolIds,
          fieldKeys: e.fieldKeys,
          usedWebSearch: !!e.usedWebSearch,
          hits: e.hits || 1,
          updatedAt: e.updatedAt,
        },
      }))
      .join('\n') + (load().some((e) => e.owner === owner) ? '\n' : '');
  }

  return { learnTurn, findRelevant, list, stats, clear, exportJsonl };
}

module.exports = { createKnowledgeBase, MAX_KB_ENTRIES, distillSummary };
