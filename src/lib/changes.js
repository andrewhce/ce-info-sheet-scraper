'use strict';
// Compares newly extracted fields against a school's previous saved result
// so automated or manual re-scrapes highlight what actually changed on a website.
const { oneLine, clip } = require('./util');

const MAX_VALUE = 4000;   // characters kept of one old or new value

function foundValue(field) {
  if (!field || field.status !== 'found' || field.value == null) return '';
  return oneLine(String(field.value));
}

/**
 * Returns a list of field changes between `prevResult` and `nextFields`.
 * First-ever scrapes (or previous failed scrapes) return [] so initial runs are not flagged as updates.
 */
function diffFields(prevResult, nextFields) {
  if (!prevResult || prevResult.status !== 'ok' || !prevResult.fields || !nextFields) return [];
  const keys = new Set([...Object.keys(prevResult.fields), ...Object.keys(nextFields)]);
  const out = [];
  for (const key of keys) {
    const before = foundValue(prevResult.fields[key]);
    const after = foundValue(nextFields[key]);
    if (before === after) continue;
    // kept in full (up to a safety cap): the Slack alert and the school page show the complete old and new value
    if (!before && after) out.push({ key, kind: 'added', after: clip(after, MAX_VALUE) });
    else if (before && !after) out.push({ key, kind: 'removed', before: clip(before, MAX_VALUE) });
    else out.push({ key, kind: 'changed', before: clip(before, MAX_VALUE), after: clip(after, MAX_VALUE) });
  }
  return out;
}

module.exports = { diffFields };
