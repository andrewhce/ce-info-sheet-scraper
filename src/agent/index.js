'use strict';
// The assistant behind the dashboard's Ask page: settings, persisted sessions, scoped memory, multi-layer guardrails,
// and one question at a time. Every question and answer is appended to data/agent-log.jsonl (with secrets scrubbed).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PATHS, clip, redactSecrets } = require('../lib/util');
const { createSettings, SettingsError, EFFORTS } = require('./settings');
const { createLedger } = require('./usage');
const { createTools } = require('./tools');
const { anthropicProvider, groqProvider } = require('./providers');
const { systemBlocksFor, analyzePrompt, REFUSAL_MESSAGE } = require('./prompt');
const { runTurn, AskError, explainError } = require('./agent');
const { createMemoryStore, MemoryError } = require('./memory');
const { createKnowledgeBase } = require('./kb');
const { createScopeGuard } = require('./scope-guard');

const IDLE_MS = 14 * 86400e3;      // inactive chats stay resumable for two weeks (also persisted on disk)
const MAX_SESSIONS = 100;
const MAX_QUESTION = 4000;
const MAX_REQ_PER_MIN = 30;

/** Loaded only when a question is asked, so the dashboard still opens if the library is missing. */
function defaultClientFactory(apiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey, maxRetries: 2, timeout: 180000 });
}

const ownerOf = (user) => (user && (user.email || (user.local && 'local'))) || 'local';

/** The emails that may change the AI settings on a shared server. They come from the ASK_ADMIN_EMAILS setting, never from the code. */
const parseAdmins = (raw) => new Set(String(raw || '').toLowerCase().split(/[,;\s]+/).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)));

/**
 * opts (all optional, for tests): deps { data, sheetExport }, settings, ledger, logFile (null for none),
 * memoryFile (null for in-memory), sessionsFile (null for in-memory), scopeGuard (false | custom classifier),
 * clientFactory(apiKey) -> Anthropic-like client, groqFactory(apiKey) -> provider, adminEmails (a list or comma separated text; default
 * is the ASK_ADMIN_EMAILS setting).
 */
function createAssistant(opts = {}) {
  const deps = opts.deps || {
    data: require('../lib/dashboard-data'),
    sheetExport: require('../lib/sheet-export'),
    scheduler: require('../lib/scheduler'),
    slack: require('../lib/slack'),
    cacheDir: PATHS.cacheDir,
  };
  const settings = opts.settings || createSettings(path.join(PATHS.data, 'agent-settings.json'));
  const ledger = opts.ledger || createLedger(path.join(PATHS.data, 'agent-usage.jsonl'));
  const logFile = opts.logFile === undefined ? path.join(PATHS.data, 'agent-log.jsonl') : opts.logFile;
  const baseDir = opts.settings && opts.settings.file ? path.dirname(opts.settings.file) : PATHS.data;
  const memoryFile = opts.memoryFile !== undefined ? opts.memoryFile : path.join(baseDir, 'agent-memory.json');
  const sessionsFile = opts.sessionsFile !== undefined ? opts.sessionsFile : path.join(baseDir, 'agent-sessions.json');
  const kbFile = opts.kbFile !== undefined ? opts.kbFile : path.join(baseDir, 'agent-kb.json');

  const getOverview = () => {
    try { return deps && deps.data && typeof deps.data.overview === 'function' ? deps.data.overview() : null; } catch { return null; }
  };
  const schoolNames = () => {
    const ov = getOverview();
    return ov && Array.isArray(ov.schools) ? ov.schools.map((s) => s.name).filter(Boolean) : [];
  };

  const memory = createMemoryStore({ memoryFile, sessionsFile, getSchoolNames: schoolNames });
  const kb = createKnowledgeBase({ kbFile, getOverview });
  const tools = createTools({ ...deps, kb });
  const makeClient = opts.clientFactory || ((key) => module.exports.clientFactory(key));
  const makeGroq = opts.groqFactory || ((key) => groqProvider({ apiKey: key }));
  const defaultGuard = createScopeGuard({ makeAnthropicClient: makeClient, makeGroqClient: makeGroq });
  const isMocked = !!(opts.clientFactory || opts.groqFactory || module.exports.clientFactory !== defaultClientFactory);
  const activeGuard = opts.scopeGuard === false
    ? null
    : (opts.scopeGuard && typeof opts.scopeGuard.classify === 'function')
      ? opts.scopeGuard
      : (!isMocked ? defaultGuard : null);

  // Who may change the AI settings (the API key, the cap, web search): the person at a private computer, or, on a shared server,
  // only the signed-in people named in ASK_ADMIN_EMAILS. The sign-in checks the email with Google, so it cannot be typed in by someone else.
  const adminEmails = parseAdmins(opts.adminEmails !== undefined ? (Array.isArray(opts.adminEmails) ? opts.adminEmails.join(',') : opts.adminEmails) : process.env.ASK_ADMIN_EMAILS);
  const isAdmin = (user) => !!(user && (user.local || (user.email && adminEmails.has(String(user.email).toLowerCase()))));
  const notAdmin = () => new AskError(adminEmails.size
    ? 'Only the AI administrator can change the AI settings.'
    : 'Nobody is set up to change the AI settings on this server yet. Whoever runs the server adds the administrator’s email to the ASK_ADMIN_EMAILS setting.', 403);

  const sessions = new Map();
  for (const saved of memory.allSessionsForHydration()) {
    sessions.set(saved.id, {
      ...saved,
      busy: false,
      touched: Date.parse(saved.updatedAt || saved.createdAt || 0) || Date.now(),
    });
  }
  const rateLog = new Map();

  const checkRateLimit = (owner) => {
    const now = Date.now();
    const recent = (rateLog.get(owner) || []).filter((t) => now - t < 60000);
    if (recent.length >= MAX_REQ_PER_MIN) {
      rateLog.set(owner, recent);
      throw new AskError('Too many questions sent too quickly. Wait a moment and try again.', 429);
    }
    recent.push(now);
    rateLog.set(owner, recent);
  };

  const log = (entry) => {
    if (!logFile) return;
    try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch { /* the log is a convenience */ }
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
    const owner = ownerOf(user);
    const v = settings.publicView();
    const ready = v.configured && !(v.provider === 'anthropic' && sdkMissing());
    return {
      ...v,
      spentThisMonth: ledger.monthSpend(),
      canEditSettings: isAdmin(user),
      sharedServer: !(user && user.local),          // true when the page is a shared server (not one person's own computer)
      adminsSet: adminEmails.size > 0,              // whether anyone is set up as administrator (the emails themselves are never sent)
      sdkMissing: sdkMissing(),
      ready,
      webSearchOn: v.provider === 'anthropic' && v.webSearch,
      memoryCount: memory.list(owner).length,
      sessionCount: memory.listSessions(owner).length,
      kbCount: kb.stats(owner).count,
    };
  }

  function saveSettings(user, body) {
    if (!isAdmin(user)) throw notAdmin();
    try { settings.save(body); return status(user); } catch (e) {
      if (e instanceof SettingsError) throw new AskError(e.message, 400);
      throw e;
    }
  }

  async function testConnection(user) {
    if (!isAdmin(user)) throw notAdmin();
    const cfg = settings.load();
    const provider = providerFor(cfg);
    try { return { ok: true, provider: cfg.provider, ...(await provider.test({ model: cfg.active.model })) }; } catch (e) { throw new AskError(redactSecrets(explainError(e)), 502); }
  }

  function prune() {
    const now = Date.now();
    for (const [id, s] of sessions) if (!s.busy && now - s.touched > IDLE_MS) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) { const oldest = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.touched - b.touched)[0]; if (!oldest) break; sessions.delete(oldest.id); }
  }

  // ---------------------------------------------------------------- memory API ---

  const listMemories = (user) => ({ notes: memory.list(ownerOf(user)) });

  async function mutateMemory(user, body = {}) {
    const owner = ownerOf(user);
    const action = String(body.action || 'add').toLowerCase();
    try {
      if (action === 'delete') {
        const id = String(body.id || '').trim();
        if (!id) throw new MemoryError('Missing memory note id.');
        memory.remove(owner, id);
      } else if (action === 'clear') {
        memory.clear(owner);
      } else if (action === 'add' || action === 'edit') {
        const validated = memory.validateNote(body.note);
        if (activeGuard) {
          const cfg = settings.load();
          if (cfg.active.apiKey && (cfg.provider !== 'anthropic' || !sdkMissing())) {
            const verdict = await activeGuard.classify({ cfg, message: `Save to school-research memory: ${validated}`, ledger, user: owner });
            if (!verdict || verdict.allow !== true) {
              throw new MemoryError('Saved memories must stay strictly within school admissions, Sheet preferences, or scraper workflows.');
            }
          }
        }
        if (action === 'edit') {
          const id = String(body.id || '').trim();
          if (!id) throw new MemoryError('Missing memory note id.');
          memory.update(owner, id, validated);
        } else {
          memory.add(owner, validated, body.kind);
        }
      } else {
        throw new MemoryError('Unknown memory action.');
      }
      return { notes: memory.list(owner) };
    } catch (e) {
      if (e instanceof MemoryError) throw new AskError(e.message, e.status);
      throw e;
    }
  }

  const listSessions = (user) => ({ sessions: memory.listSessions(ownerOf(user)) });
  const getSession = (user, id) => memory.getSessionDetail(ownerOf(user), String(id || ''));
  function renameSession(user, id, title) {
    const owner = ownerOf(user);
    try {
      const updated = memory.renameSession(owner, String(id || '').trim(), title);
      const s = sessions.get(updated.id);
      if (s && s.owner === owner) s.title = updated.title;
      return updated;
    } catch (e) {
      if (e instanceof MemoryError) throw new AskError(e.message, e.status);
      throw e;
    }
  }

  /**
   * Checks the question and finds or starts its conversation. Throws AskError (with .status) for things the person can fix.
   * Returns { conversationId, fresh, run(emit, signal) }.
   */
  function begin({ user, conversationId, message, effort }) {
    const q = typeof message === 'string' ? message.trim() : '';
    if (!q) throw new AskError('Type a question first.');
    if (q.length > MAX_QUESTION) throw new AskError(`Please keep the question under ${MAX_QUESTION} characters.`);
    const owner = ownerOf(user);
    checkRateLimit(owner);
    const cfg = settings.load();
    let reqEffort = null;
    if (effort != null && effort !== '') {
      reqEffort = String(effort).trim().toLowerCase();
      if (!EFFORTS.includes(reqEffort)) throw new AskError('Unknown thinking effort level.');
    }

    let existing = typeof conversationId === 'string' && /^[a-f0-9]{32}$/.test(conversationId) ? sessions.get(conversationId) : null;
    if (existing && existing.owner !== owner) existing = null;

    const names = schoolNames();
    const analysis = analyzePrompt(q, names, existing ? existing.history : []);
    if (analysis.blocked) {
      log({ at: new Date().toISOString(), user: owner, question: clip(redactSecrets(q), 2000), blocked: analysis.reason });
      throw new AskError(REFUSAL_MESSAGE);
    }

    if (analysis.memCmd && analysis.memCmd.action === 'add') {
      try { memory.validateNote(analysis.memCmd.note); } catch (e) {
        if (e instanceof MemoryError) throw new AskError(e.message, e.status);
        throw e;
      }
    }

    const chosenEffort = !cfg.locked.effort && reqEffort ? reqEffort : cfg.effort;
    const provider = providerFor(cfg);          // throws when no key is saved
    prune();
    let s = existing;
    const fresh = !!conversationId && !s;
    if (!s) {
      s = {
        id: crypto.randomBytes(16).toString('hex'),
        owner,
        history: [],
        uiItems: [],
        lastInputTokens: 0,
        busy: false,
        createdAt: new Date().toISOString(),
        touched: Date.now(),
        provider: cfg.provider,
        model: cfg.active.model,
        web: webOn(cfg),
      };
      sessions.set(s.id, s);
    }
    if (s.busy) throw new AskError('That conversation is still answering. Wait for it to finish.', 409);
    // a different provider, model or web search setting reads the conversation differently (web results sit in it), so it starts clean
    if (s.provider !== cfg.provider || s.model !== cfg.active.model || s.web !== webOn(cfg)) {
      s.history = []; s.uiItems = []; s.lastInputTokens = 0; s.provider = cfg.provider; s.model = cfg.active.model; s.web = webOn(cfg);
    }
    s.busy = true;                                // held from here, so a second question cannot start before run() ends

    return {
      conversationId: s.id, fresh,
      async run(emit, signal) {
        const config = { model: cfg.active.model, effort: chosenEffort, monthlyCapUsd: cfg.monthlyCapUsd };
        const entry = { at: new Date().toISOString(), user: owner, conversation: s.id, provider: cfg.provider, model: cfg.active.model, effort: cfg.provider === 'anthropic' ? chosenEffort : undefined, question: clip(redactSecrets(q), 2000) };
        const uiBot = { role: 'assistant', steps: [], proposals: [], sources: [], memory: [], text: '', usage: null, error: null };
        const sendEv = (ev) => {
          emit(ev);
          if (ev.type === 'step') uiBot.steps.push({ id: ev.id, label: ev.label, done: false, ok: true });
          else if (ev.type === 'step-done') { const st = uiBot.steps.find((x) => x.id === ev.id); if (st) { st.label = ev.label; st.done = true; st.ok = ev.ok; } }
          else if (ev.type === 'proposal') uiBot.proposals.push({ ...ev.proposal, state: 'idle' });
          else if (ev.type === 'sources') uiBot.sources = ev.sources;
          else if (ev.type === 'memory') uiBot.memory.push(ev);
          else if (ev.type === 'answer') uiBot.text = ev.text;
          else if (ev.type === 'usage') uiBot.usage = ev;
          else if (ev.type === 'error') uiBot.error = ev.message;
        };
        const persistUi = () => {
          if (!Array.isArray(s.uiItems)) s.uiItems = [];
          s.uiItems.push({ role: 'user', text: redactSecrets(q) }, uiBot);
          memory.saveSession(s);
        };

        try {
          // Semantic scope check runs before mutating memory or invoking the full model/tools when enabled
          const pendingMem = (analysis.memCmd && analysis.memCmd.action === 'add') ? analysis.memCmd : analysis.autoRule;
          if (activeGuard && (analysis.needsSemanticCheck || !!pendingMem)) {
            const verdict = await activeGuard.classify({ cfg, message: q, history: s.history, ledger, user: owner, signal });
            if (!verdict || verdict.allow !== true) {
              emit({ type: 'error', message: REFUSAL_MESSAGE });
              log({ ...entry, steps: [], blocked: 'scope_guard', reason: verdict && verdict.reason ? verdict.reason : 'denied', cost: (verdict && verdict.cost) || 0 });
              if (s.history.length === 0) sessions.delete(s.id);
              return;
            }
          }

          let promptForModel = q;
          if (analysis.memCmd) {
            if (analysis.memCmd.action === 'add') {
              const { item, duplicate } = memory.add(owner, analysis.memCmd.note, 'preference');
              sendEv({ type: 'memory', action: 'added', items: [item], duplicate });
              if (!analysis.memCmd.remainder) {
                const ack = duplicate
                  ? `Already in your saved Ask memory: "${item.note}"`
                  : `Saved to your Ask memory for this chat and future chats: "${item.note}"`;
                sendEv({ type: 'answer', text: ack });
                sendEv({
                  type: 'usage', provider: cfg.provider, model: cfg.active.model, effort: cfg.provider === 'anthropic' ? chosenEffort : null,
                  calls: 0, steps: 0, searches: 0, cost: 0, tracked: cfg.provider === 'anthropic',
                  inputTokens: 0, outputTokens: 0, month: { spent: ledger.monthSpend(), cap: cfg.monthlyCapUsd },
                  kbCount: kb.stats(owner).count,
                });
                s.history.push({ role: 'user', content: q }, { role: 'assistant', content: [{ type: 'text', text: ack }] });
                persistUi();
                log({ ...entry, steps: [], memorySaved: item.id, answer: clip(ack, 4000), cost: 0 });
                return;
              }
              promptForModel = analysis.memCmd.remainder;
            } else if (analysis.memCmd.action === 'forget') {
              const removed = memory.forgetMatching(owner, analysis.memCmd.query);
              sendEv({ type: 'memory', action: 'removed', items: removed });
              const ack = removed.length
                ? `Removed ${removed.length} saved memory ${removed.length === 1 ? 'note' : 'notes'}: ${removed.map((r) => `"${r.note}"`).join('; ')}`
                : `No saved memory notes matched "${analysis.memCmd.query}". You can view or remove notes in Saved memory.`;
              sendEv({ type: 'answer', text: ack });
              sendEv({
                type: 'usage', provider: cfg.provider, model: cfg.active.model, effort: cfg.provider === 'anthropic' ? chosenEffort : null,
                calls: 0, steps: 0, searches: 0, cost: 0, tracked: cfg.provider === 'anthropic',
                inputTokens: 0, outputTokens: 0, month: { spent: ledger.monthSpend(), cap: cfg.monthlyCapUsd },
                kbCount: kb.stats(owner).count,
              });
              s.history.push({ role: 'user', content: q }, { role: 'assistant', content: [{ type: 'text', text: ack }] });
              persistUi();
              log({ ...entry, steps: [], memoryRemoved: removed.length, answer: clip(ack, 4000), cost: 0 });
              return;
            }
          } else if (analysis.autoRule) {
            try {
              const { item, duplicate } = memory.add(owner, analysis.autoRule.note, 'school_note');
              if (!duplicate) sendEv({ type: 'memory', action: 'added', auto: true, items: [item], duplicate: false });
            } catch { /* auto-learning never blocks answering the question */ }
          }

          const activeMemories = memory.list(owner);
          const learned = kb.findRelevant(owner, promptForModel, { limit: 3 });
          const turn = await runTurn({
            provider, config, system: systemBlocksFor({ webSearch: webOn(cfg), memories: activeMemories, learned }),
            tools, conversation: s, text: promptForModel, emit: sendEv, ledger, user: owner, signal,
          });
          // An answer is kept only if it was backed by at least one real lookup (a school tool or a web search). A reply written
          // without looking anything up is not worth keeping, and keeping it would let an unchecked answer come back later as "knowledge".
          const backedByLookup = (turn.steps || []).some((st) => st && st.name !== 'search_past_answers');
          if (turn.answer && !turn.answer.startsWith('I can only answer questions') && turn.answer !== REFUSAL_MESSAGE && (analysis.autoRule || backedByLookup)) {
            const schoolIds = [], fieldKeys = [];
            for (const st of turn.steps || []) {
              const inp = st && st.input;
              if (!inp) continue;
              if (typeof inp.school_id === 'string') schoolIds.push(inp.school_id);
              if (Array.isArray(inp.school_ids)) schoolIds.push(...inp.school_ids);
              if (typeof inp.field === 'string') fieldKeys.push(inp.field);
              if (Array.isArray(inp.fields)) fieldKeys.push(...inp.fields);
            }
            kb.learnTurn({
              owner,
              question: promptForModel,
              answer: turn.answer,
              schoolIds,
              fieldKeys,
              sources: turn.sources || [],
              usedWebSearch: (turn.searches || 0) > 0,
              kind: analysis.autoRule ? 'correction' : 'qa',
            });
          }
          sendEv({
            type: 'usage', provider: cfg.provider, model: cfg.active.model, effort: cfg.provider === 'anthropic' ? chosenEffort : null, calls: turn.calls, steps: turn.steps.length, searches: turn.searches,
            cost: turn.cost, tracked: cfg.provider === 'anthropic', inputTokens: turn.inputTokens, outputTokens: turn.outputTokens,
            month: { spent: ledger.monthSpend(), cap: cfg.monthlyCapUsd },
            kbCount: kb.stats(owner).count,
          });
          persistUi();
          log({ ...entry, steps: turn.steps, answer: clip(redactSecrets(turn.answer), 4000), cost: turn.cost, searches: turn.searches || undefined, sources: turn.sources.length ? turn.sources.map((x) => x.url) : undefined });
        } catch (e) {
          const t = e && e.turn;
          const safeMsg = redactSecrets(explainError(e));
          if (!(signal && signal.aborted)) {
            sendEv({ type: 'error', message: safeMsg });
            if (!(e instanceof AskError) && e && e.name !== 'ProviderError') console.error('Assistant error:', redactSecrets(e && e.message));
          }
          if (s.history.length > 0) persistUi();
          else sessions.delete(s.id);
          log({ ...entry, steps: t ? t.steps : [], error: clip(safeMsg, 300), cost: t ? t.cost : 0 });
        } finally { s.busy = false; s.touched = Date.now(); }
      },
    };
  }

  function reset(user, conversationId) {
    const owner = ownerOf(user);
    const s = sessions.get(conversationId);
    if (s && s.owner === owner && !s.busy) {
      sessions.delete(conversationId);
      memory.deleteSession(owner, conversationId);
    } else if (!s && conversationId) {
      memory.deleteSession(owner, String(conversationId));
    }
  }

  return {
    status, saveSettings, testConnection, begin, reset,
    listMemories, mutateMemory, listSessions, getSession, renameSession,
    kbStats: (user) => kb.stats(ownerOf(user)),
    listKb: (user) => ({ entries: kb.list(ownerOf(user)) }),
    clearKb: (user) => { kb.clear(ownerOf(user)); return kb.stats(ownerOf(user)); },
    exportDatasetJsonl: (user) => kb.exportJsonl(ownerOf(user)),
    tools, settings, ledger, kb,
  };
}

module.exports = { createAssistant, AskError, clientFactory: defaultClientFactory };
