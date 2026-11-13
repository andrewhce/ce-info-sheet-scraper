'use strict';
// What the AI costs: a price table, a ledger of every call, and the monthly spending cap.
// The figures are estimates for the spend meter (list prices, checked 2026-11-03), not an invoice.
const fs = require('fs');
const path = require('path');

// US dollars per million tokens. A prompt write to the cache costs 1.25x the input price, a read from it 0.1x.
const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longAfter: 100000, longIn: 0.5, longOut: 2.5 },
};
const SEARCH_FEE = 0.01;   // dollars per web search ($10 per 1,000), checked 2026-11
const FALLBACK_PRICE = PRICES['claude-opus-5-5'];   // a model this table does not know is priced as the dearest one, so the cap errs safe

const priceOf = (model) => PRICES[model] || FALLBACK_PRICE;
const round = (n, places = 6) => Math.round(n * 10 ** places) / 10 ** places;

/** Estimated dollars for one call. usage is the API's usage object. */
function costOf(model, usage) {
  const u = usage || {};
  const p = priceOf(model);
  const fresh = Number(u.input_tokens) || 0, read = Number(u.cache_read_input_tokens) || 0, wrote = Number(u.cache_creation_input_tokens) || 0;
  const out = Number(u.output_tokens) || 0;
  const long = p.longAfter && fresh + read + wrote > p.longAfter;
  const inRate = long ? p.longIn : p.in, outRate = long ? p.longOut : p.out;
  const searches = Number(u.server_tool_use && u.server_tool_use.web_search_requests) || 0;   // the web search tool bills per search on top of the tokens
  return round((fresh * inRate + read * p.cacheRead * (long ? p.longIn / p.in : 1) + wrote * p.cacheWrite * (long ? p.longIn / p.in : 1) + out * outRate) / 1e6 + searches * SEARCH_FEE);
}

/** An append-only file with one line per call. */
function createLedger(file) {
  const read = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of text.split('\n')) { if (!line) continue; try { rows.push(JSON.parse(line)); } catch { /* a damaged line is skipped */ } }
    return rows;
  };
  return {
    file,
    record(entry) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    },
    /** Dollars spent in the calendar month (UTC) of `when`. */
    monthSpend(when = new Date()) {
      const key = when.toISOString().slice(0, 7);
      let sum = 0;
      for (const r of read()) if (typeof r.at === 'string' && r.at.startsWith(key)) sum += Number(r.cost) || 0;
      return round(sum, 4);
    },
    rows: read,
  };
}

module.exports = { PRICES, SEARCH_FEE, priceOf, costOf, createLedger };
