'use strict';
// The researcher's work list: only the key facts that need a human look, most doubtful first. Everything the trust score calls
// "ready to use" is left out, and so is anything a person has already spot-checked (they have decided it).
const { clip } = require('./util');
const { topReasons, LABEL } = require('./trust');

const LIMIT = 500;

/**
 * data: the dashboard-data module. resolved: a Set of "schoolId|field" a person has already checked (may be empty).
 * opts: { tier, field, level ('check' | 'doubtful') }
 */
function buildQueue(data, resolved, opts = {}) {
  const ov = data.overview();
  if (!ov || !ov.ready) return { ready: false, items: [] };
  const tier = Number(opts.tier) || null;
  const items = [];
  const byField = new Map();
  let facts = 0, ready = 0, resolvedCount = 0, skippedWrongSite = 0;
  for (const s of ov.schools) {
    if (s.status !== 'ok') continue;
    if (s.wrongSite) { skippedWrongSite++; continue; }
    if (tier && s.tier !== tier) continue;
    for (const row of data.compareSchool(s.id, 0).rows) {
      if (row.kind !== 'field' || !row.trust) continue;
      facts++;
      if (resolved && resolved.has(`${s.id}|${row.key}`)) { resolvedCount++; continue; }
      if (row.trust.triage === 'ready') { ready++; continue; }
      if (opts.field && row.key !== opts.field) continue;
      if (opts.level && row.trust.triage !== opts.level) continue;
      const source = ((row.scraped.sources || []).find((x) => x && /^https?:\/\//i.test(x.url || '')) || {}).url || null;
      items.push({
        schoolId: s.id, school: s.name, tier: s.tier == null ? null : s.tier, field: row.key, label: String(row.label).replace(/:$/, ''),
        value: clip(String(row.scraped.value), 200), source,
        score: row.trust.score, level: row.trust.level, triage: row.trust.triage, why: topReasons(row.trust, 3),
      });
      byField.set(row.key, { label: String(row.label).replace(/:$/, ''), n: (byField.has(row.key) ? byField.get(row.key).n : 0) + 1 });
    }
  }
  // most doubtful first (the sheet plays no part in the order)
  items.sort((a, b) => a.score - b.score || a.school.localeCompare(b.school) || a.label.localeCompare(b.label));
  return {
    ready: true, labels: LABEL, facts, readyToUse: ready, checked: resolvedCount, needLook: items.length, skippedWrongSite,
    byField: [...byField].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.n - a.n),
    items: items.slice(0, LIMIT), truncated: items.length > LIMIT,
  };
}

module.exports = { buildQueue };
