'use strict';
// The AI settings: which provider, the API keys, the models and the monthly cap.
// Saved in data/agent-settings.json (the data folder is never published). On a server they come from
// environment variables instead, which win over the file:
//   ANTHROPIC_API_KEY, GROQ_API_KEY, ASK_PROVIDER (anthropic or groq), ASK_MODEL, ASK_GROQ_MODEL, ASK_MONTHLY_CAP_USD,
//   ASK_WEB_SEARCH (1 or 0: let Claude search the web; off unless switched on)
// Keys are never sent to the browser: only the last four characters are shown.
// Claude (Anthropic) is the real provider. Groq is only for trying the prototype out cheaply.
const fs = require('fs');
const path = require('path');

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most capable)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (cheaper)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest, simplest)' },
];
const GROQ_MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'];   // a starting list; "Test the connection" replaces it with what the account can use
const PROVIDERS = ['anthropic', 'groq'];
const DEFAULTS = { provider: 'anthropic', model: 'claude-opus-5-5', groqModel: 'llama-3.3-70b-versatile', monthlyCapUsd: 100, effort: 'medium', fallbacks: true };
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;
const GROQ_KEY_RE = /^gsk_[A-Za-z0-9]{20,200}$/;
const MODEL_RE = /^claude-[a-z0-9.-]{2,60}$/;
const GROQ_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{2,80}$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

class SettingsError extends Error {}

function createSettings(file, env = process.env) {
  const readFile = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; } };
  const pick = (envVal, fileVal, re, dflt) => (re.test(envVal) ? [envVal, 'env'] : re.test(fileVal || '') ? [fileVal, 'file'] : [dflt, null]);

  /** Everything the program needs, including the keys. Never send this to the browser. */
  function load() {
    const f = readFile();
    const [aKey, aSrc] = pick(String(env.ANTHROPIC_API_KEY || '').trim(), f.apiKey, KEY_RE, '');
    const [gKey, gSrc] = pick(String(env.GROQ_API_KEY || '').trim(), f.groqKey, GROQ_KEY_RE, '');
    const envProvider = String(env.ASK_PROVIDER || '').trim().toLowerCase();
    const provider = PROVIDERS.includes(envProvider) ? envProvider : PROVIDERS.includes(f.provider) ? f.provider : DEFAULTS.provider;
    const [model] = pick(String(env.ASK_MODEL || '').trim(), f.model, MODEL_RE, DEFAULTS.model);
    const [groqModel] = pick(String(env.ASK_GROQ_MODEL || '').trim(), f.groqModel, GROQ_MODEL_RE, DEFAULTS.groqModel);
    const envWeb = String(env.ASK_WEB_SEARCH || '').trim().toLowerCase();
    const webLocked = /^(1|true|on|yes|0|false|off|no)$/.test(envWeb);
    const webSearch = webLocked ? /^(1|true|on|yes)$/.test(envWeb) : f.webSearch === true;   // off unless someone switches it on
    const envCap = Number(env.ASK_MONTHLY_CAP_USD);
    const fileCap = Number(f.monthlyCapUsd);
    const cap = envCap >= 1 && envCap <= 10000 ? envCap : fileCap >= 1 && fileCap <= 10000 ? fileCap : DEFAULTS.monthlyCapUsd;
    const anthropic = { apiKey: aKey, keySource: aSrc, model };
    const groq = { apiKey: gKey, keySource: gSrc, model: groqModel };
    return {
      provider, anthropic, groq, active: provider === 'groq' ? groq : anthropic,
      monthlyCapUsd: cap, webSearch,
      effort: EFFORTS.includes(f.effort) ? f.effort : DEFAULTS.effort,
      fallbacks: f.fallbacks === false ? false : DEFAULTS.fallbacks,
      locked: { webSearch: webLocked, provider: PROVIDERS.includes(envProvider), anthropicKey: aSrc === 'env', groqKey: gSrc === 'env', model: MODEL_RE.test(String(env.ASK_MODEL || '').trim()), groqModel: GROQ_MODEL_RE.test(String(env.ASK_GROQ_MODEL || '').trim()), cap: envCap >= 1 && envCap <= 10000 },
    };
  }

  /** What the browser may see. */
  function publicView() {
    const s = load();
    const hint = (k) => (k.apiKey ? '…' + k.apiKey.slice(-4) : null);
    return {
      provider: s.provider, configured: !!s.active.apiKey,
      anthropic: { configured: !!s.anthropic.apiKey, keyHint: hint(s.anthropic), keySource: s.anthropic.keySource, model: s.anthropic.model, models: MODELS },
      groq: { configured: !!s.groq.apiKey, keyHint: hint(s.groq), keySource: s.groq.keySource, model: s.groq.model, models: GROQ_MODELS },
      monthlyCapUsd: s.monthlyCapUsd, webSearch: s.webSearch, locked: s.locked,
    };
  }

  /**
   * patch: { provider?, apiKey?, clearKey?, model?, groqKey?, clearGroqKey?, groqModel?, monthlyCapUsd? }
   * Throws SettingsError with a message that is safe to show.
   */
  function save(patch) {
    const f = readFile();
    const p = patch || {};
    if (p.provider != null && p.provider !== '') {
      if (!PROVIDERS.includes(p.provider)) throw new SettingsError('Choose Claude or Groq.');
      f.provider = p.provider;
    }
    if (p.clearKey) delete f.apiKey;
    if (p.clearGroqKey) delete f.groqKey;
    if (p.apiKey != null && String(p.apiKey).trim() !== '') {
      const key = String(p.apiKey).trim();
      if (/^sk-ant-admin/i.test(key)) throw new SettingsError('That is an admin key, which cannot ask questions. Make a normal API key in the Anthropic console (Settings, API keys).');
      if (!KEY_RE.test(key)) throw new SettingsError('That does not look like an Anthropic API key. It starts with sk-ant- and has no spaces.');
      f.apiKey = key;
    }
    if (p.groqKey != null && String(p.groqKey).trim() !== '') {
      const key = String(p.groqKey).trim();
      if (!GROQ_KEY_RE.test(key)) throw new SettingsError('That does not look like a Groq API key. It starts with gsk_ and has no spaces.');
      f.groqKey = key;
    }
    if (p.model != null && p.model !== '') {
      if (!MODELS.some((m) => m.id === p.model)) throw new SettingsError('Choose one of the Claude models in the list.');
      f.model = p.model;
    }
    if (p.groqModel != null && p.groqModel !== '') {
      if (!GROQ_MODEL_RE.test(String(p.groqModel))) throw new SettingsError('That is not a valid Groq model name.');
      f.groqModel = String(p.groqModel);
    }
    if (p.webSearch != null) f.webSearch = p.webSearch === true;
    if (p.monthlyCapUsd != null && p.monthlyCapUsd !== '') {
      const cap = Number(p.monthlyCapUsd);
      if (!(cap >= 1 && cap <= 10000)) throw new SettingsError('The monthly cap should be between $1 and $10,000.');
      f.monthlyCapUsd = Math.round(cap * 100) / 100;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(f, null, 1), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return publicView();
  }

  return { load, publicView, save, file };
}

module.exports = { createSettings, SettingsError, MODELS, GROQ_MODELS, PROVIDERS, DEFAULTS, KEY_RE, GROQ_KEY_RE };
