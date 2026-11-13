'use strict';
// The two AI services the assistant can use, behind one shape. The conversation is kept in Claude's message format;
// each provider turns it into what its service expects and turns the answer back, so the loop in agent.js is the same for both.
//   anthropic: Claude. The real one.
//   groq:      an OpenAI-style service with open models. Only for trying the prototype out cheaply.
//
// provider.create({ model, system, tools, messages, effort, signal }) resolves to
//   { content: [{type:'text'|'tool_use'|...}], stop_reason, usage: { input_tokens, output_tokens, ... }, model }
const BETA_FALLBACK = 'server-side-fallback-2026-07-01';
const GROQ_BASE = 'https://api.groq.com/openai/v1';

class ProviderError extends Error {
  constructor(message, { status, code } = {}) { super(message); this.name = 'ProviderError'; this.status = status; this.code = code; }
}
const oneLine = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// ------------------------------------------------------------------ Claude ---

/**
 * Claude's own web search tool: it runs on Anthropic's servers, so there is nothing to call here. The newer version
 * filters results with code before they reach the model; Haiku only has the plain one.
 */
const webSearchTool = (model) => ({ type: /haiku/i.test(model) ? 'web_search_20250305' : 'web_search_20260209', name: 'web_search', max_uses: 3 });

/** client: an Anthropic SDK client (or anything with the same messages calls). webSearch: also offer the web search tool. */
function anthropicProvider(client, { fallbacks = true, webSearch = false } = {}) {
  return {
    name: 'anthropic', compact: false, maxToolChars: 40000, maxContextTokens: 150000, webSearch,
    async create({ model, system, tools, messages, effort, signal }) {
      const body = {
        model, max_tokens: 16000, system: [{ type: 'text', text: system }], tools: webSearch ? [...tools, webSearchTool(model)] : tools, messages,
        output_config: { effort }, cache_control: { type: 'ephemeral' },
      };
      // if the safety filter declines a request, the API retries it on a substitute model inside the same call
      if (fallbacks) return client.beta.messages.create({ ...body, betas: [BETA_FALLBACK], fallbacks: 'default' }, { signal });
      return client.messages.create(body, { signal });
    },
    async test({ model, signal }) {
      const m = await client.models.retrieve(model, undefined, { signal });
      return { message: `Connected. ${m && m.display_name ? m.display_name : model} is available.` };
    },
  };
}

// -------------------------------------------------------------------- Groq ---

/** Claude-format history -> OpenAI-format messages. Thinking blocks do not exist on this side and are dropped. */
function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') { out.push({ role: 'user', content: m.content }); continue; }
      const text = [];
      for (const b of m.content || []) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Error: ' : '') + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)) });
        else if (b.type === 'text') text.push(b.text);
      }
      if (text.length) out.push({ role: 'user', content: text.join('\n') });
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      out.push(calls.length ? { role: 'assistant', content: text || null, tool_calls: calls } : { role: 'assistant', content: text });
    }
  }
  return out;
}

/** OpenAI-format answer -> Claude-format answer. */
function fromOpenAi(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice || !choice.message) throw new ProviderError('Groq sent back an empty answer.');
  const m = choice.message;
  const content = [];
  const text = String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();   // some open models print their reasoning
  if (text) content.push({ type: 'text', text });
  (m.tool_calls || []).forEach((tc, i) => {
    let input = {};
    try { input = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { input = {}; }
    if (input == null || typeof input !== 'object' || Array.isArray(input)) input = {};
    content.push({ type: 'tool_use', id: tc.id || `call_${i}`, name: tc.function && tc.function.name, input });
  });
  const u = json.usage || {};
  return {
    content, model: json.model,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: Number(u.prompt_tokens) || 0, output_tokens: Number(u.completion_tokens) || 0 },
  };
}

function retryAfterMs(res, err) {
  const h = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
  if (h > 0) return h * 1000 + 250;
  const m = /try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i.exec((err && err.message) || '');
  return m ? ((Number(m[1]) || 0) * 60 + Number(m[2])) * 1000 + 250 : 8000;
}

/**
 * Groq's free plan allows only a few thousand tokens a minute, so this provider asks the tools for shorter results
 * (compact), waits and retries when it is told to slow down, and retries once when the model makes a malformed tool call.
 */
function groqProvider({ apiKey, fetchImpl = fetch, baseUrl = GROQ_BASE, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 2 } = {}) {
  const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
  async function call(method, path, body, signal) {
    let attempt = 0, toolRetry = false;
    for (;;) {
      let res;
      try { res = await fetchImpl(baseUrl + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal }); } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new ProviderError('Could not reach Groq. Check the internet connection.', { code: 'connection' });
      }
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not JSON */ }
      if (res.ok && json) return json;
      const err = (json && json.error) || {};
      if (res.status === 429 && attempt < maxRetries) {
        const wait = retryAfterMs(res, err);
        if (wait <= 30000) { attempt++; await sleep(wait); continue; }
      }
      if (res.status === 400 && err.code === 'tool_use_failed' && !toolRetry) { toolRetry = true; continue; }
      throw new ProviderError(oneLine(err.message || `Groq answered with status ${res.status}.`, 300), { status: res.status, code: err.code });
    }
  }
  return {
    name: 'groq', compact: true, maxToolChars: 12000, maxContextTokens: 60000,
    async create({ model, system, tools, messages, signal }) {
      const json = await call('POST', '/chat/completions', {
        model, messages: toOpenAiMessages(system, messages),
        tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        tool_choice: 'auto', temperature: 0.2, max_completion_tokens: 2048,
      }, signal);
      return fromOpenAi(json);
    },
    /** The chat models this key can use. */
    async listModels(signal) {
      const json = await call('GET', '/models', null, signal);
      return (json.data || []).filter((m) => m && m.id && m.active !== false && !/whisper|guard|tts|playai|orpheus|embed|compound|prompt-guard|safeguard/i.test(m.id)).map((m) => m.id).sort();
    },
    async test({ model, signal }) {
      const models = await this.listModels(signal);
      const has = models.includes(model);
      return { message: has ? `Connected. ${model} is available.` : `Connected, but ${model} is not in the list for this key. Choose another model.`, models, modelAvailable: has };
    },
  };
}

module.exports = { anthropicProvider, groqProvider, ProviderError, toOpenAiMessages, fromOpenAi, webSearchTool, BETA_FALLBACK };
