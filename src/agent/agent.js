'use strict';
// One question and answer: asks the AI, runs the tools it picks, hands the results back, and repeats until it has an answer.
// The loop is the same for every provider (see providers.js). It never changes anything: the tools only read.
const { clip } = require('../lib/util');
const { costOf } = require('./usage');
const { ToolError } = require('./tools');

class AskError extends Error {          // the message is safe to show the person
  constructor(message, status) { super(message); this.name = 'AskError'; this.status = status || 400; }
}
const MAX_STEPS = 8;                    // rounds of "ask the AI, run its tools" for one question
const SOURCE_LIMIT = 12;                // web sources listed under one answer

/** The web searches whose results arrived in this response, each reported once: { id, query, ok, count, error, results }. */
function finishedSearches(content, history, seen) {
  const queryOf = (id) => {
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
      const b = m.content.find((x) => x.type === 'server_tool_use' && x.id === id);
      if (b) return String((b.input && b.input.query) || '');
    }
    return '';
  };
  const out = [];
  for (const b of content) {
    if (b.type !== 'web_search_tool_result' || seen.has(b.tool_use_id)) continue;
    seen.add(b.tool_use_id);
    const list = Array.isArray(b.content) ? b.content : null;
    out.push({ id: b.tool_use_id, query: queryOf(b.tool_use_id), ok: !!list, count: list ? list.length : 0, error: list ? null : (b.content && b.content.error_code) || 'unknown', results: list || [] });
  }
  return out;
}

function addSource(sources, url, title) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 600 || sources.length >= SOURCE_LIMIT || sources.some((s) => s.url === url)) return;
  sources.push({ url, title: clip(String(title || '').replace(/\s+/g, ' ').trim(), 120) });
}

/**
 * The answer's text. A web answer arrives as many small text blocks (one per cited phrase) that belong together, so
 * neighbours are joined as they are; only a tool call between two blocks starts a new paragraph.
 */
function answerText(content) {
  let out = '', gap = false;
  for (const b of content) {
    if (b.type === 'text') { out += (gap && out ? '\n\n' : '') + b.text; gap = false; }
    else if (b.type === 'server_tool_use' || b.type === 'web_search_tool_result' || b.type === 'tool_use') gap = true;
  }
  return out.trim();
}

/** A message for the person, from whatever went wrong. Never includes a key. */
function explainError(e) {
  if (e instanceof AskError) return e.message;
  const s = e && e.status;
  const msg = clip(String((e && e.message) || ''), 220);
  if (e && (e.name === 'AbortError' || e.name === 'APIUserAbortError')) return 'Stopped.';
  if (s === 401) return 'The AI service rejected the API key. Check the key in the settings above.';
  if (s === 403) return 'This key is not allowed to use that model, or the account is blocked.';
  if (s === 404) return 'The AI service does not know that model. Choose another model in the settings.';
  if (s === 413) return 'That request was bigger than this model allows. Ask a narrower question, or use a model with higher limits.';
  if (s === 429) return 'The AI service says it is being asked too often (or the account hit its limit). Wait a minute and try again.';
  if (s === 400 && e && e.code === 'tool_use_failed') return 'The test model made a malformed tool call. Try again, or choose another model in the settings.';
  if (s === 400) return 'The AI service did not accept the request: ' + msg;
  if (s >= 500) return 'The AI service had a problem. Try again in a moment.';
  if (e && (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError')) return 'Could not reach the AI service. Check the internet connection.';
  if (e && e.name === 'ProviderError') return msg;
  return 'Something went wrong while asking the AI: ' + msg;
}

function isThinkingBlock(block) {
  return !!block && (block.type === 'thinking' || block.type === 'redacted_thinking');
}

/**
 * Removes `thinking` and `redacted_thinking` blocks from completed assistant messages so Anthropic does not
 * reject signature-bound blocks from earlier turns (across KB/memory updates, trimming, or restarts).
 */
function stripThinkingFromMessage(msg) {
  if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;
  if (!msg.content.some(isThinkingBlock)) return msg;
  const kept = msg.content.filter(
    (b) => b && !isThinkingBlock(b) && (b.type !== 'text' || (typeof b.text === 'string' && b.text.trim().length > 0)),
  );
  return { ...msg, content: kept.length ? kept : [{ type: 'text', text: '...' }] };
}

/** Strips thinking blocks from `history[0 .. upToIndex - 1]` in place. Returns true if any message changed. */
function stripThinkingFromHistory(history, upToIndex = Array.isArray(history) ? history.length : 0) {
  if (!Array.isArray(history) || !history.length) return false;
  const end = Math.min(history.length, Math.max(0, upToIndex));
  let changed = false;
  for (let i = 0; i < end; i++) {
    const cleaned = stripThinkingFromMessage(history[i]);
    if (cleaned !== history[i]) {
      history[i] = cleaned;
      changed = true;
    }
  }
  return changed;
}

function isThinkingSignatureError(err) {
  if (!err || err.status !== 400) return false;
  const msg = String(err.message || '');
  return /\b(?:thinking|redacted_thinking)\b/i.test(msg)
    && /(?:signature|bound to a different conversation|invalid\b.*\bthinking)/i.test(msg);
}

/**
 * provider      from providers.js
 * config        { model, effort, monthlyCapUsd }
 * conversation  { history: [], lastInputTokens }: kept between questions; put back as it was if this question fails
 * emit(event)   progress for the page: step, step-done, proposal, answer
 * ledger        records every call and knows the month's spending
 * Resolves to { answer, steps, proposals, cost, calls, inputTokens, outputTokens }. Throws AskError (or the provider's error)
 * with the partial figures on error.turn.
 */
async function runTurn({ provider, config, system, tools, conversation, text, emit, ledger, user, signal, maxSteps = MAX_STEPS }) {
  const history = conversation.history;
  const startLen = history.length;
  // Prior completed turns must not resend signed thinking blocks from earlier conversations/system prefixes.
  stripThinkingFromHistory(history, startLen);
  const turn = { answer: '', steps: [], proposals: [], sources: [], searches: 0, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
  const seenSearches = new Set();
  const paid = provider.name === 'anthropic';   // the test provider's spending is not tracked here
  history.push({ role: 'user', content: text });
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (signal && signal.aborted) throw new AskError('Stopped.');
      if (conversation.lastInputTokens > provider.maxContextTokens) throw new AskError('This conversation has got long. Press “New chat” to start a fresh one.');
      if (paid && ledger.monthSpend() >= config.monthlyCapUsd) throw new AskError(`This month's AI spending cap ($${config.monthlyCapUsd}) has been reached. Raise it in the settings above, or wait for next month.`, 402);

      let streamedAny = false;
      const onText = (delta) => {
        if (!delta) return;
        streamedAny = true;
        emit({ type: 'text-delta', text: delta });
      };
      let res;
      try {
        res = await provider.create({ model: config.model, system, tools: tools.definitions, messages: history, effort: config.effort, signal, onText });
      } catch (err) {
        if (isThinkingSignatureError(err) && stripThinkingFromHistory(history, history.length)) {
          if (streamedAny) { streamedAny = false; emit({ type: 'text-reset' }); }
          res = await provider.create({ model: config.model, system, tools: tools.definitions, messages: history, effort: config.effort, signal, onText });
        } else {
          throw err;
        }
      }

      const u = res.usage || {};
      const cost = paid ? costOf(res.model || config.model, u) : 0;
      const promptTokens = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
      conversation.lastInputTokens = promptTokens;
      turn.cost += cost; turn.calls++; turn.inputTokens += promptTokens; turn.outputTokens += Number(u.output_tokens) || 0;
      ledger.record({
        at: new Date().toISOString(), user: user || 'local', provider: provider.name, model: res.model || config.model,
        in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0, cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite: Number(u.cache_creation_input_tokens) || 0,
        searches: Number(u.server_tool_use && u.server_tool_use.web_search_requests) || 0, cost,
      });

      const content = Array.isArray(res.content) ? res.content : [];
      history.push({ role: 'assistant', content });   // exactly as received: the AI service checks that it comes back unchanged

      if (res.stop_reason === 'refusal') throw new AskError('The AI declined to answer that. Try asking it a different way.');

      // web searches run on the AI service's side: show each one, and keep its sources so the page can list them
      for (const w of finishedSearches(content, history, seenSearches)) {
        turn.searches++;
        turn.steps.push({ name: 'web_search', input: { query: w.query } });
        emit({ type: 'step', id: w.id, label: `Searching the web for “${clip(w.query, 80)}”…` });
        emit({ type: 'step-done', id: w.id, label: w.ok ? `Web search: ${w.count} result${w.count === 1 ? '' : 's'}` : `Web search did not work (${w.error})`, ok: w.ok });
        for (const r of w.results) addSource(turn.sources, r.url, r.title);
      }
      for (const b of content) if (b.type === 'text' && Array.isArray(b.citations)) for (const c of b.citations) addSource(turn.sources, c.url, c.title);

      const calls = content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason === 'pause_turn') {
        if (streamedAny) emit({ type: 'text-reset' });
        continue;
      }
      if (res.stop_reason === 'tool_use' && calls.length) {
        if (streamedAny) emit({ type: 'text-reset' });
        const results = [];
        for (const call of calls) {
          if (signal && signal.aborted) throw new AskError('Stopped.');
          turn.steps.push({ name: call.name, input: call.input });
          emit({ type: 'step', id: call.id, label: tools.running(call.name, call.input) });
          let body, label, proposal, isError = false;
          try {
            const r = tools.run(call.name, call.input, { compact: !!provider.compact, owner: user || 'local' });
            body = JSON.stringify(r.data); label = r.label; proposal = r.proposal;
            if (body.length > provider.maxToolChars) {
              body = JSON.stringify({ error: `That result was too large (${body.length} characters). Ask for fewer schools or fields, or add a filter.` });
              isError = true; label = 'The result was too large'; proposal = undefined;
            }
          } catch (e) {
            isError = true;
            if (e instanceof ToolError) { body = JSON.stringify({ error: e.message }); label = clip(e.message, 160); }
            else { console.error('Assistant tool failed:', e); body = JSON.stringify({ error: 'The tool failed unexpectedly.' }); label = 'The tool failed'; }
          }
          emit({ type: 'step-done', id: call.id, label, ok: !isError });
          if (proposal) { turn.proposals.push(proposal); emit({ type: 'proposal', proposal }); }
          results.push({ type: 'tool_result', tool_use_id: call.id, content: body, ...(isError ? { is_error: true } : {}) });
        }
        history.push({ role: 'user', content: results });
        continue;
      }

      const answer = answerText(content);
      turn.answer = (answer || 'I could not put an answer together. Try asking again, or ask in a different way.')
        + (res.stop_reason === 'max_tokens' ? '\n\n(The answer was cut off because it got too long. Ask for fewer schools or one field at a time.)' : '');
      if (turn.sources.length) emit({ type: 'sources', sources: turn.sources });
      emit({ type: 'answer', text: turn.answer });
      // Once the turn finishes, drop thinking/redacted_thinking signatures so follow-up turns or saved threads stay portable.
      stripThinkingFromHistory(history, history.length);
      return turn;
    }
    throw new AskError('That needed more steps than I allow for one question. Try a narrower question.');
  } catch (e) {
    history.length = startLen;   // a failed question leaves no half-finished tool calls behind
    e.turn = turn;
    throw e;
  }
}

module.exports = {
  runTurn,
  AskError,
  explainError,
  MAX_STEPS,
  stripThinkingFromMessage,
  stripThinkingFromHistory,
  isThinkingSignatureError,
};
