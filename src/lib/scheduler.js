'use strict';
// Built-in recurring scrape scheduler, persisted in data/schedule.json and ticked by src/server.js.
const path = require('path');
const { PATHS, readJson, writeJson } = require('./util');

const FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'];
const MISSED_POLICIES = ['ask', 'run', 'skip'];
const OVERDUE_GRACE_MS = 2 * 3600e3;
const SCOPES = {
  tier1: { args: ['--tier', '1'], label: 'Tier 1 schools' },
  tier2: { args: ['--tier', '2'], label: 'Tier 2 schools' },
  tier3: { args: ['--tier', '3'], label: 'Tier 3 schools' },
  pending: { args: ['--pending'], label: 'Schools not checked yet' },
  all: { args: ['--all'], label: 'All schools' },
};

const DEFAULTS = {
  enabled: false,
  frequency: 'weekly',
  dayOfWeek: 0,       // 0 = Sunday
  dayOfMonth: 1,      // 1..28
  hour: 2,            // 2:00 AM local time
  minute: 0,
  scope: 'tier1',
  refresh: true,
  missedPolicy: 'ask',
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastSummary: null,
  skippedMissedAt: null,
};

class ScheduleError extends Error {}

function computeNextRun(cfg, fromMs = Date.now(), { afterRun = false } = {}) {
  const hour = Math.max(0, Math.min(23, Number(cfg.hour) || 0));
  const minute = Math.max(0, Math.min(59, Number(cfg.minute) || 0));
  const d = new Date(fromMs);
  d.setSeconds(0, 0);
  d.setHours(hour, minute, 0, 0);

  const freq = FREQUENCIES.includes(cfg.frequency) ? cfg.frequency : 'weekly';
  if (freq === 'daily') {
    if (d.getTime() <= fromMs || afterRun) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  if (freq === 'weekly' || freq === 'biweekly') {
    const targetDay = Math.max(0, Math.min(6, Number(cfg.dayOfWeek) || 0));
    const diff = (targetDay - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff);
    if (afterRun && freq === 'biweekly') {
      while (d.getTime() <= fromMs) d.setDate(d.getDate() + 7);
      d.setDate(d.getDate() + 7);
    } else if (d.getTime() <= fromMs || afterRun) {
      d.setDate(d.getDate() + (freq === 'biweekly' ? 14 : 7));
    }
    return d.toISOString();
  }
  // monthly (days 1..28 work safely in every calendar month)
  const dom = Math.max(1, Math.min(28, Number(cfg.dayOfMonth) || 1));
  d.setDate(dom);
  if (d.getTime() <= fromMs || afterRun) {
    d.setMonth(d.getMonth() + 1, dom);
  }
  return d.toISOString();
}

function isDue(state, now = Date.now()) {
  if (!state || !state.enabled || !state.nextRunAt) return false;
  const t = Date.parse(state.nextRunAt);
  return Number.isFinite(t) && now >= t;
}

function isOverdue(state, now = Date.now(), graceMs = OVERDUE_GRACE_MS) {
  if (!isDue(state, now)) return false;
  return now - Date.parse(state.nextRunAt) > graceMs;
}

function scopeCommand(scope, refresh = true) {
  const entry = SCOPES[scope] || SCOPES.tier1;
  const args = [...entry.args];
  let label = entry.label;
  if (refresh) {
    args.push('--refresh');
    label += ' (fresh check)';
  }
  return { args, label };
}

function createScheduler(file = path.join(PATHS.data, 'schedule.json')) {
  function load() {
    const saved = readJson(file, null) || {};
    const state = {
      ...DEFAULTS,
      ...saved,
      enabled: !!saved.enabled,
      refresh: saved.refresh !== false,
    };
    if (!FREQUENCIES.includes(state.frequency)) state.frequency = DEFAULTS.frequency;
    if (!MISSED_POLICIES.includes(state.missedPolicy)) state.missedPolicy = DEFAULTS.missedPolicy;
    if (!SCOPES[state.scope]) state.scope = DEFAULTS.scope;
    state.dayOfWeek = Math.max(0, Math.min(6, Math.trunc(Number(state.dayOfWeek ?? DEFAULTS.dayOfWeek))));
    state.dayOfMonth = Math.max(1, Math.min(28, Math.trunc(Number(state.dayOfMonth ?? DEFAULTS.dayOfMonth))));
    state.hour = Math.max(0, Math.min(23, Math.trunc(Number(state.hour ?? DEFAULTS.hour))));
    state.minute = Math.max(0, Math.min(59, Math.trunc(Number(state.minute ?? DEFAULTS.minute))));
    if (state.enabled && !state.nextRunAt) {
      state.nextRunAt = computeNextRun(state);
    }
    return state;
  }

  function save(patch = {}, now = Date.now()) {
    const cur = load();
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...cur };

    if (p.enabled != null) next.enabled = !!p.enabled;
    if (p.frequency != null) {
      if (!FREQUENCIES.includes(p.frequency)) throw new ScheduleError('Choose Daily, Weekly, Every 2 weeks, or Monthly.');
      next.frequency = p.frequency;
    }
    if (p.dayOfWeek != null) {
      const dow = Number(p.dayOfWeek);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) throw new ScheduleError('Choose a valid day of the week (Sunday–Saturday).');
      next.dayOfWeek = dow;
    }
    if (p.dayOfMonth != null) {
      const dom = Number(p.dayOfMonth);
      if (!Number.isInteger(dom) || dom < 1 || dom > 28) throw new ScheduleError('Choose a day between 1 and 28.');
      next.dayOfMonth = dom;
    }
    if (p.hour != null) {
      const hr = Number(p.hour);
      if (!Number.isInteger(hr) || hr < 0 || hr > 23) throw new ScheduleError('Choose a valid hour (0–23).');
      next.hour = hr;
    }
    if (p.minute != null) {
      const mn = Number(p.minute);
      if (!Number.isInteger(mn) || mn < 0 || mn > 59) throw new ScheduleError('Choose a valid minute (0–59).');
      next.minute = mn;
    }
    if (p.scope != null) {
      if (!SCOPES[p.scope]) throw new ScheduleError('Choose Tier 1, Tier 2, Tier 3, Not checked yet, or All schools.');
      next.scope = p.scope;
    }
    if (p.refresh != null) next.refresh = !!p.refresh;
    if (p.missedPolicy != null) {
      if (!MISSED_POLICIES.includes(p.missedPolicy)) throw new ScheduleError('Missed run setting must be ask, run, or skip.');
      next.missedPolicy = p.missedPolicy;
    }

    next.nextRunAt = next.enabled ? computeNextRun(next, now) : null;
    writeJson(file, next);
    return next;
  }

  function skipMissedRun(now = Date.now()) {
    const cur = load();
    if (!cur.enabled) return cur;
    cur.skippedMissedAt = new Date(now).toISOString();
    cur.nextRunAt = computeNextRun(cur, now, { afterRun: true });
    writeJson(file, cur);
    return cur;
  }

  function markStarted(now = Date.now()) {
    const cur = load();
    if (!cur.enabled) return cur;
    cur.nextRunAt = computeNextRun(cur, now, { afterRun: true });
    writeJson(file, cur);
    return cur;
  }

  function markFinished({ status, summary }, now = Date.now()) {
    const cur = load();
    cur.lastRunAt = new Date(now).toISOString();
    cur.lastStatus = status || 'ok';
    cur.lastSummary = summary || null;
    writeJson(file, cur);
    return cur;
  }

  return { load, save, skipMissedRun, markStarted, markFinished };
}

const defaultScheduler = createScheduler();

module.exports = {
  FREQUENCIES,
  MISSED_POLICIES,
  OVERDUE_GRACE_MS,
  SCOPES,
  ScheduleError,
  computeNextRun,
  isDue,
  isOverdue,
  scopeCommand,
  createScheduler,
  load: defaultScheduler.load,
  save: defaultScheduler.save,
  skipMissedRun: defaultScheduler.skipMissedRun,
  markStarted: defaultScheduler.markStarted,
  markFinished: defaultScheduler.markFinished,
};
