'use strict';
// The assistant behind the dashboard's Ask page: settings, conversations, and one question at a time.
// Conversations live in memory only (a restart starts them fresh); every question and answer is also appended to
// data/agent-log.jsonl so mistakes can be reviewed. Nothing here changes the school data.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PATHS, clip } = require('../lib/util');
const { createSettings, SettingsError } = require('./settings');
const { createLedger } = require('./usage');
const { createTools } = require('./tools');
const { anthropicProvider, groqProvider } = require('./providers');
const { systemFor } = require('./prompt');
const { runTurn, AskError, explainError } = require('./agent');

const IDLE_MS = 2 * 3600e3;        // an unused conversation is forgotten after two hours
const MAX_SESSIONS = 100;
const MAX_QUESTION = 4000;

/** Loaded only when a question is asked, so the dashboard still opens if the library is missing. */
function defaultClientFactory(apiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 180000 });
}

/**
 * opts (all optional, for tests): deps { data, sheetExport }, settings, ledger, logFile (null for none),
 * clientFactory(apiKey) -> Anthropic-like client, groqFactory(apiKey) -> provider.
 */
function createAssistant(opts = {}) {
  const deps = opts.deps || { data: require('../lib/dashboard-data'), sheetExport: require('../lib/sheet-export') };
  const settings = opts.settings || createSettings(path.join(PATHS.data, 'agent-settings.json'));
  const ledger = opts.ledger || createLedger(path.join(PATHS.data, 'agent-usage.jsonl'));
  const logFile = opts.logFile === undefined ? path.join(PATHS.data, 'agent-log.jsonl') : opts.logFile;
  const tools = createTools(deps);
  const makeClient = opts.clientFactory || ((key) => module.exports.clientFactory(key));
  const makeGroq = opts.groqFactory || ((key) => groqProvider({ apiKey: key }));
  const sessions = new Map();

  const log = (entry) => {
    if (!logFile) return;
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* the log is a convenience */ }
  };
  const sdkMissing = () => {
    if (opts.clientFactory || module.exports.clientFactory !== defaultClientFactory) return false;
    try { require.resolve('@anthropic-ai/sdk'); return false; } catch { return true; }
  };

  function providerFor(cfg) {
    if (!cfg.active.apiKey) throw new AskError('The AI is not connected yet. Add an API key in the settings above.', 409);
    if (cfg.provider === 'groq') return makeGroq(cfg.active.apiKey);
    if (sdkMissing()) throw new AskError('The Anthropic library is not installed on this computer. Run:  npm install', 500);
    return anthropicProvider(makeClient(cfg.active.apiKey), { fallbacks: cfg.fallbacks, webSearch: webOn(cfg) });
  }
  /** Web search is a Claude feature and stays off unless someone switched it on. */
  const webOn = (cfg) => cfg.provider === 'anthropic' && !!cfg.webSearch;

  /** Everything the Ask page needs to draw itself (never a key). */
  function status(user) {
    const v = settings.publicView();
    const ready = v.configured && !(v.provider === 'anthropic' && sdkMissing());
    return { ...v, spentThisMonth: ledger.monthSpend(), canEditSettings: !!(user && user.local), sdkMissing: sdkMissing(), ready, webSearchOn: v.provider === 'anthropic' && v.webSearch };
  }

  function saveSettings(user, body) {
    if (!(user && user.local)) throw new AskError('On a shared server the AI settings are set by whoever runs the server (environment variables), not on this page.', 403);
    try { settings.save(body); return status(user); } catch (e) {
      if (e instanceof SettingsError) throw new AskError(e.message, 400);
      throw e;
    }
  }

  async function testConnection(user) {
    const cfg = settings.load();
    const provider = providerFor(cfg);
    try { return { ok: true, provider: cfg.provider, ...(await provider.test({ model: cfg.active.model })) }; } catch (e) { throw new AskError(explainError(e), 502); }
  }

  function prune() {
    const now = Date.now();
    for (const [id, s] of sessions) if (!s.busy && now - s.touched > IDLE_MS) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) { const oldest = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.touched - b.touched)[0]; if (!oldest) break; sessions.delete(oldest.id); }
  }

  /**
   * Checks the question and finds or starts its conversation. Throws AskError (with .status) for things the person can fix.
   * Returns { conversationId, fresh, run(emit, signal) }.
   */
  function begin({ user, conversationId, message }) {
    const q = typeof message === 'string' ? message.trim() : '';
    if (!q) throw new AskError('Type a question first.');
    if (q.length > MAX_QUESTION) throw new AskError(`Please keep the question under ${MAX_QUESTION} characters.`);
    const cfg = settings.load();
    const provider = providerFor(cfg);          // throws when no key is saved
    const owner = (user && (user.email || (user.local && 'local'))) || 'local';
    prune();
    let s = typeof conversationId === 'string' && /^[a-f0-9]{32}$/.test(conversationId) ? sessions.get(conversationId) : null;
    if (s && s.owner !== owner) s = null;        // someone else's conversation id is treated as unknown
    const fresh = !!conversationId && !s;
    if (!s) {
      s = { id: crypto.randomBytes(16).toString('hex'), owner, history: [], lastInputTokens: 0, busy: false, touched: Date.now(), provider: cfg.provider, model: cfg.active.model, web: webOn(cfg) };
      sessions.set(s.id, s);
    }
    if (s.busy) throw new AskError('That conversation is still answering. Wait for it to finish.', 409);
    // a different provider, model or web search setting reads the conversation differently (web results sit in it), so it starts clean
    if (s.provider !== cfg.provider || s.model !== cfg.active.model || s.web !== webOn(cfg)) { s.history = []; s.lastInputTokens = 0; s.provider = cfg.provider; s.model = cfg.active.model; s.web = webOn(cfg); }
    s.busy = true;                                // held from here, so a second question cannot start before run() ends

    return {
      conversationId: s.id, fresh,
      async run(emit, signal) {
        const config = { model: cfg.active.model, effort: cfg.effort, monthlyCapUsd: cfg.monthlyCapUsd };
        const entry = { at: new Date().toISOString(), user: owner, conversation: s.id, provider: cfg.provider, model: cfg.active.model, question: clip(q, 2000) };
        try {
          const turn = await runTurn({ provider, config, system: systemFor({ webSearch: webOn(cfg) }), tools, conversation: s, text: q, emit, ledger, user: owner, signal });
          emit({
            type: 'usage', provider: cfg.provider, model: cfg.active.model, calls: turn.calls, steps: turn.steps.length, searches: turn.searches,
            cost: turn.cost, tracked: cfg.provider === 'anthropic', inputTokens: turn.inputTokens, outputTokens: turn.outputTokens,
            month: { spent: ledger.monthSpend(), cap: cfg.monthlyCapUsd },
          });
          log({ ...entry, steps: turn.steps, answer: clip(turn.answer, 4000), cost: turn.cost, searches: turn.searches || undefined, sources: turn.sources.length ? turn.sources.map((x) => x.url) : undefined });
        } catch (e) {
          const t = e && e.turn;
          if (!(signal && signal.aborted)) {
            emit({ type: 'error', message: explainError(e) });
            if (!(e instanceof AskError) && e && e.name !== 'ProviderError') console.error('Assistant error:', e && e.message);
          }
          log({ ...entry, steps: t ? t.steps : [], error: clip(explainError(e), 300), cost: t ? t.cost : 0 });
        } finally { s.busy = false; s.touched = Date.now(); }
      },
    };
  }

  function reset(user, conversationId) {
    const owner = (user && (user.email || (user.local && 'local'))) || 'local';
    const s = sessions.get(conversationId);
    if (s && s.owner === owner && !s.busy) sessions.delete(conversationId);
  }

  return { status, saveSettings, testConnection, begin, reset, tools, settings, ledger };
}

module.exports = { createAssistant, AskError, clientFactory: defaultClientFactory };
