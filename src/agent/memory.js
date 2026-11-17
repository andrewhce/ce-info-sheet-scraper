'use strict';
// Persistent, scoped Ask memory:
//   1) agent-memory.json   -> long-term user preferences & school notes injected across chats (hardened against prompt/secret poisoning)
//   2) agent-sessions.json -> conversation threads preserved across dashboard restarts
const crypto = require('crypto');
const { readJson, writeJson, redactSecrets } = require('../lib/util');
const { stripThinkingFromMessage } = require('./agent');
const { normalizeForGuard, deobfuscateForGuard, isOffTopicQuestion } = {
  ...require('./prompt'),
  deobfuscateForGuard: (s) => String(s || '')
    .toLowerCase()
    .replace(/\b(?:[a-z0-9]\s+){2,}[a-z0-9]\b/g, (m) => m.replace(/\s+/g, ''))
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/@/g, 'a').replace(/\$/g, 's'),
};

const MAX_MEMORIES = 50;
const MAX_NOTE_CHARS = 320;
const MAX_SESSIONS_PER_OWNER = 30;
const MAX_HISTORY_PER_SESSION = 28;
const VALID_KINDS = new Set(['preference', 'school_note', 'workflow']);

const MEMORY_POISON_RE = new RegExp([
  '\\b(?:always\\s+(?:answer|allow|obey|respond|output|act|write\\s+code)|disable\\s+(?:guardrails?|safety|scope|filters?)|ignore\\s+(?:all\\s+)?(?:rules?|scope|instructions?|safety)|no\\s+restrictions|unrestricted|without\\s+rules|jailbreak|developer\\s*mode|dan\\s*mode|system\\s*prompt|reveal\\s+(?:your\\s+)?prompt|act\\s+as\\s+a\\s+general|pretend\\s+to\\s+be|you\\s+are\\s+now\\s+(?!helping\\s+with\\s+schools?))\\b',
  '(?:<\\s*\\/?\\s*(?:system|developer|instructions?|assistant)\\s*>|<<\\s*SYS\\s*>>|\\[\\/?INST\\]|###\\s*(?:system|instruction))',
].join('|'), 'i');

class MemoryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'MemoryError';
    this.status = status;
  }
}

/**
 * Manages persisted user/team school memories and saved chat threads in the data directory.
 * Pass `memoryFile: null` / `sessionsFile: null` for in-memory-only operation.
 */
function createMemoryStore({ memoryFile = null, sessionsFile = null, getSchoolNames = () => [] } = {}) {
  let memState = null;
  let sesState = null;

  const loadMemories = () => {
    if (memState) return memState;
    const raw = memoryFile ? readJson(memoryFile) : null;
    memState = Array.isArray(raw && raw.notes) ? raw.notes.filter((x) => x && typeof x.id === 'string' && typeof x.note === 'string') : [];
    return memState;
  };

  const persistMemories = () => {
    if (!memoryFile) return;
    writeJson(memoryFile, { version: 1, notes: loadMemories() }, { mode: 0o600 });
  };

  const loadSessions = () => {
    if (sesState) return sesState;
    const raw = sessionsFile ? readJson(sessionsFile) : null;
    sesState = Array.isArray(raw && raw.sessions) ? raw.sessions.filter((x) => x && typeof x.id === 'string' && Array.isArray(x.history)) : [];
    return sesState;
  };

  const persistSessions = () => {
    if (!sessionsFile) return;
    writeJson(sessionsFile, { version: 1, sessions: loadSessions() }, { mode: 0o600 });
  };

  /** Validates and normalizes a memory note; rejects secrets, injections, policy overrides, and off-topic notes. */
  function validateNote(rawNote) {
    const note = normalizeForGuard(rawNote);
    if (!note || note.length < 3) throw new MemoryError('Write at least a few words to save to memory.');
    if (note.length > MAX_NOTE_CHARS) throw new MemoryError(`Please keep each saved memory note under ${MAX_NOTE_CHARS} characters.`);
    if (redactSecrets(note) !== note) throw new MemoryError('Do not save API keys, webhooks, bearer tokens, or credentials in memory.');
    const lower = note.toLowerCase();
    const deobf = deobfuscateForGuard(lower);
    if (MEMORY_POISON_RE.test(lower) || MEMORY_POISON_RE.test(deobf) || isOffTopicQuestion(note, getSchoolNames())) {
      throw new MemoryError('Saved memories must stay strictly within private schools, admissions research, your School Information Sheet, or scraper preferences (no general topics or rule overrides).');
    }
    return note;
  }

  function list(owner) {
    return loadMemories()
      .filter((m) => m.owner === owner)
      .map(({ id, note, kind, createdAt, updatedAt }) => ({ id, note, kind, createdAt, updatedAt }));
  }

  function add(owner, rawNote, kind = 'school_note') {
    const note = validateNote(rawNote);
    const cleanKind = VALID_KINDS.has(kind) ? kind : 'school_note';
    const all = loadMemories();
    const now = new Date().toISOString();
    const existing = all.find((m) => m.owner === owner && m.note.toLowerCase() === note.toLowerCase());
    if (existing) {
      existing.note = note;
      existing.kind = cleanKind;
      existing.updatedAt = now;
      persistMemories();
      return { item: { id: existing.id, note: existing.note, kind: existing.kind, createdAt: existing.createdAt, updatedAt: existing.updatedAt }, duplicate: true };
    }
    const mine = all.filter((m) => m.owner === owner);
    if (mine.length >= MAX_MEMORIES) {
      throw new MemoryError(`Memory limit reached (${MAX_MEMORIES} notes). Remove an old note before adding another.`);
    }
    const item = { id: crypto.randomBytes(6).toString('hex'), owner, note, kind: cleanKind, createdAt: now, updatedAt: now };
    all.push(item);
    persistMemories();
    return { item: { id: item.id, note: item.note, kind: item.kind, createdAt: item.createdAt, updatedAt: item.updatedAt }, duplicate: false };
  }

  function update(owner, id, rawNote) {
    const note = validateNote(rawNote);
    const all = loadMemories();
    const cur = all.find((m) => m.owner === owner && m.id === id);
    if (!cur) throw new MemoryError('Saved memory note not found.', 404);
    const conflict = all.find((m) => m.owner === owner && m.id !== id && m.note.toLowerCase() === note.toLowerCase());
    if (conflict) throw new MemoryError('That note is already in your saved memory.', 409);
    cur.note = note;
    cur.updatedAt = new Date().toISOString();
    persistMemories();
    return { id: cur.id, note: cur.note, kind: cur.kind, createdAt: cur.createdAt, updatedAt: cur.updatedAt };
  }

  function remove(owner, id) {
    const all = loadMemories();
    const idx = all.findIndex((m) => m.owner === owner && m.id === id);
    if (idx < 0) return null;
    const [removed] = all.splice(idx, 1);
    persistMemories();
    return removed;
  }

  function clear(owner) {
    const all = loadMemories();
    const kept = all.filter((m) => m.owner !== owner);
    const removedCount = all.length - kept.length;
    memState = kept;
    if (removedCount > 0) persistMemories();
    return removedCount;
  }

  /** Deletes saved memories matching a natural "forget about ..." query, or all if query is "everything/all". */
  function forgetMatching(owner, rawQuery) {
    const q = normalizeForGuard(rawQuery).toLowerCase();
    if (!q) throw new MemoryError('Say which saved note to forget, or remove it from the Saved memory panel.');
    const all = loadMemories();
    if (/^(?:everything|all|all notes|all memories)$/i.test(q)) {
      const mine = all.filter((m) => m.owner === owner);
      memState = all.filter((m) => m.owner !== owner);
      if (mine.length) persistMemories();
      return mine;
    }
    const words = q.split(/\s+/).filter((w) => w.length >= 3);
    const removed = [];
    const kept = [];
    for (const m of all) {
      if (m.owner !== owner) { kept.push(m); continue; }
      const hay = m.note.toLowerCase();
      const matched = hay.includes(q) || (words.length > 0 && words.every((w) => hay.includes(w)));
      if (matched) removed.push(m);
      else kept.push(m);
    }
    memState = kept;
    if (removed.length) persistMemories();
    return removed;
  }

  // --------------------------------------------------- persisted conversations ---

  /** Slices conversation history only at clean user plain-text turn boundaries so tool_use/tool_result stay paired. */
  function trimHistory(history, max = MAX_HISTORY_PER_SESSION) {
    if (!Array.isArray(history) || !history.length) return [];
    let start = Math.max(0, history.length - max);
    while (start < history.length) {
      const m = history[start];
      if (m && m.role === 'user' && typeof m.content === 'string') break;
      start++;
    }
    const sliced = history.slice(start);
    // Drop trailing unpaired tool_use assistant turn if present
    while (sliced.length) {
      const last = sliced[sliced.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b && b.type === 'tool_use')) {
        sliced.pop();
      } else {
        break;
      }
    }
    return sliced.map(stripThinkingFromMessage);
  }

  function allSessionsForHydration() {
    const all = loadSessions();
    let anyChanged = false;
    const out = all.map((s) => {
      if (!s || !Array.isArray(s.history)) return { ...s, busy: false };
      let sessionChanged = false;
      const cleanHistory = s.history.map((m) => {
        const cleaned = stripThinkingFromMessage(m);
        if (cleaned !== m) {
          sessionChanged = true;
          anyChanged = true;
        }
        return cleaned;
      });
      if (sessionChanged) s.history = cleanHistory;
      return { ...s, history: cleanHistory, busy: false };
    });
    if (anyChanged) persistSessions();
    return out;
  }

  function saveSession(session) {
    if (!session || !session.id) return;
    const all = loadSessions();
    const idx = all.findIndex((s) => s.id === session.id && s.owner === session.owner);
    const trimmedHistory = trimHistory(session.history, MAX_HISTORY_PER_SESSION);
    const safeUiItems = Array.isArray(session.uiItems)
      ? session.uiItems.slice(-40).map((it) => ({ ...it, text: it && it.text ? redactSecrets(it.text) : it.text }))
      : [];
    const firstUser = safeUiItems.find((it) => it && it.role === 'user' && it.text);
    const rawTitle = session.title || (firstUser && firstUser.text) || 'School chat';
    const title = rawTitle.length > 60 ? rawTitle.slice(0, 59).trimEnd() + '…' : rawTitle;
    const record = {
      id: session.id,
      owner: session.owner,
      title,
      provider: session.provider,
      model: session.model,
      web: !!session.web,
      history: trimmedHistory,
      lastInputTokens: Number(session.lastInputTokens) || 0,
      uiItems: safeUiItems,
      createdAt: session.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (idx >= 0) all[idx] = record;
    else all.push(record);

    // Keep most recent MAX_SESSIONS_PER_OWNER per owner
    const mine = all.filter((s) => s.owner === session.owner).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    if (mine.length > MAX_SESSIONS_PER_OWNER) {
      const dropIds = new Set(mine.slice(MAX_SESSIONS_PER_OWNER).map((s) => s.id));
      sesState = all.filter((s) => !(s.owner === session.owner && dropIds.has(s.id)));
    }
    persistSessions();
  }

  function renameSession(owner, id, rawTitle) {
    const title = normalizeForGuard(rawTitle);
    if (!title || title.length < 2) throw new MemoryError('Give the chat a short title (at least 2 characters).');
    if (redactSecrets(title) !== title) throw new MemoryError('Do not place API keys or secrets in chat titles.');
    const clipped = title.length > 80 ? title.slice(0, 79).trimEnd() + '…' : title;
    const all = loadSessions();
    const s = all.find((x) => x.owner === owner && x.id === id);
    if (!s) throw new MemoryError('Conversation not found.', 404);
    s.title = clipped;
    persistSessions();
    return { id: s.id, title: s.title };
  }

  function deleteSession(owner, id) {
    const all = loadSessions();
    const idx = all.findIndex((s) => s.owner === owner && s.id === id);
    if (idx < 0) return false;
    all.splice(idx, 1);
    persistSessions();
    return true;
  }

  function listSessions(owner) {
    return loadSessions()
      .filter((s) => s.owner === owner)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0))
      .map((s) => ({
        id: s.id,
        title: s.title || 'School chat',
        turns: Array.isArray(s.uiItems) ? Math.ceil(s.uiItems.length / 2) : Math.ceil((s.history || []).length / 2),
        provider: s.provider,
        updatedAt: s.updatedAt,
      }));
  }

  function getSessionDetail(owner, id) {
    const s = loadSessions().find((x) => x.owner === owner && x.id === id);
    if (!s) return null;
    return {
      id: s.id,
      title: s.title || 'School chat',
      provider: s.provider,
      model: s.model,
      updatedAt: s.updatedAt,
      items: Array.isArray(s.uiItems) ? s.uiItems : [],
    };
  }

  return {
    list,
    add,
    update,
    remove,
    clear,
    forgetMatching,
    validateNote,
    trimHistory,
    allSessionsForHydration,
    saveSession,
    renameSession,
    deleteSession,
    listSessions,
    getSessionDetail,
  };
}

module.exports = { createMemoryStore, MemoryError, MAX_MEMORIES, MAX_NOTE_CHARS };
