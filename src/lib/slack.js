'use strict';
// Slack Incoming Webhook notifications for completed scrapes and detected school updates.
// The webhook secret stays on this machine (or in SLACK_WEBHOOK_URL) and is never sent back to the browser.
//
// A message lists EVERY changed field of EVERY updated school with the complete old and new value. Slack caps one text block at
// 3,000 characters and one message at 50 blocks, so a long list is split into numbered messages instead of being cut short.
const path = require('path');
const { PATHS, readJson, writeJson } = require('./util');

const SLACK_URL_RE = /^https:\/\/hooks\.(?:slack\.com|slack-gov\.com)\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
const NOTIFY_MODES = ['scheduled', 'all', 'off'];
const BLOCK_TEXT_LIMIT = 2900;       // Slack allows 3,000 characters in one text block
const BLOCKS_PER_MESSAGE = 45;       // and 50 blocks in one message (a few are kept free for the header and the link)
const MESSAGE_TEXT_BUDGET = 30000;   // well under Slack's size limit for one message
const GAP_BETWEEN_MESSAGES_MS = 1100; // Slack asks webhooks for about one message a second

class SlackError extends Error {}

function escapeMrkdwn(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function maskUrl(url) {
  if (!url) return null;
  const tail = url.slice(-4);
  return 'https://hooks.slack.com/services/••••' + tail;
}

/** Cuts text into pieces that each fit one Slack text block, at line breaks where possible. Nothing is dropped. */
function splitForBlocks(text, limit = BLOCK_TEXT_LIMIT) {
  const parts = [];
  let cur = '';
  const flush = () => { if (cur) { parts.push(cur); cur = ''; } };
  for (const line of String(text).split('\n')) {
    let l = line;
    while (l.length > limit) { flush(); parts.push(l.slice(0, limit)); l = l.slice(limit); }
    if ((cur ? cur.length + 1 : 0) + l.length > limit) flush();
    cur = cur ? cur + '\n' + l : l;
  }
  flush();
  return parts;
}

/** One school's changes, in full: every changed field with its complete old and new value. */
function schoolText(item) {
  const fields = item.fields || [];
  const lines = [`*${escapeMrkdwn(item.name)}* (${fields.length} field${fields.length === 1 ? '' : 's'} changed)`];
  // the website in the school list does not look like this school, so what changed is probably another school's page
  if (item.wrongSite) lines.push(':warning: _The website listed for this school looks like a different school, so this change may not be real. Check the website in your school list._');
  for (const f of fields) {
    const name = escapeMrkdwn(f.label || f.key);
    if (f.kind === 'changed') lines.push(`• *${name}*\n   _Before:_ ${escapeMrkdwn(f.before)}\n   _Now:_ ${escapeMrkdwn(f.after)}`);
    else if (f.kind === 'added') lines.push(`• *${name}* _(newly found)_\n   _Now:_ ${escapeMrkdwn(f.after)}`);
    else lines.push(`• *${name}* _(no longer on the website)_\n   _Was:_ ${escapeMrkdwn(f.before)}`);
  }
  return lines.join('\n');
}

/**
 * The Slack message(s) for one finished run: an array of { text, blocks }, usually one. Several only when the list of changes
 * is too long for one Slack message; each then says "Message 2 of 3".
 */
function buildRunPayloads({ label, scheduled, stopped, exitCode, schoolsDone = 0, schoolsTotal = 0, durationMs = 0, changes = [], appUrl = '' }) {
  const updatedCount = changes.length;
  const totalFields = changes.reduce((sum, s) => sum + (s.fields ? s.fields.length : 0), 0);
  const icon = exitCode ? ':warning:' : stopped ? ':pause_button:' : updatedCount ? ':bell:' : ':white_check_mark:';
  const origin = scheduled ? 'Scheduled website check' : 'Website check';
  const state = exitCode ? 'ended with an error' : stopped ? 'stopped early' : 'finished';
  const mins = Math.max(1, Math.round((durationMs || 0) / 60000));
  const title = `${icon} *${escapeMrkdwn(origin)} ${state}* (${escapeMrkdwn(label || 'Schools')})`;
  const wrongCount = changes.filter((s) => s.wrongSite).length;
  const stats = `Checked *${schoolsDone}* of *${schoolsTotal || schoolsDone}* school${schoolsTotal === 1 ? '' : 's'} in ~${mins} min · *${updatedCount}* school${updatedCount === 1 ? '' : 's'} had website updates (${totalFields} field${totalFields === 1 ? '' : 's'} changed).`
    + (wrongCount ? `\n:warning: *${wrongCount}* of those ${wrongCount === 1 ? 'has a website that looks like a different school' : 'have websites that look like different schools'}, so ${wrongCount === 1 ? 'its' : 'their'} changes may not be real.` : '');
  const mrkdwn = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
  const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

  const pieces = [];
  for (const ch of changes) pieces.push(...splitForBlocks(schoolText(ch)));

  // pack the pieces into messages
  const messages = [];
  let cur = [mrkdwn(`${title}\n${stats}`)], size = cur[0].text.text.length;
  for (const text of pieces) {
    if (cur.length >= BLOCKS_PER_MESSAGE || size + text.length > MESSAGE_TEXT_BUDGET) { messages.push(cur); cur = [null]; size = 0; }
    cur.push(mrkdwn(text)); size += text.length;
  }
  if (appUrl && /^https?:\/\//i.test(appUrl)) cur.push(context(`<${appUrl}|Open School Info Sheet dashboard>`));
  messages.push(cur);

  const fallback = `${origin} ${state}: ${schoolsDone} schools checked, ${updatedCount} schools updated.`;
  const n = messages.length;
  return messages.map((blocks, i) => {
    if (n > 1) {
      if (i === 0) blocks.push(context(`Message 1 of ${n}: the full list of changes continues below.`));
      else blocks[0] = context(`Message ${i + 1} of ${n} (continued)`);
    }
    return { text: n > 1 ? `${fallback} (message ${i + 1} of ${n})` : fallback, blocks };
  });
}

/** The first (and usually only) Slack message for a run. */
const buildRunPayload = (info) => buildRunPayloads(info)[0];

function createSlack({ file = path.join(PATHS.data, 'slack-config.json'), env = process.env, fetchImpl = fetch, publicUrl = '', sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  function load() {
    const saved = readJson(file, null) || {};
    const envUrl = String(env.SLACK_WEBHOOK_URL || '').trim();
    const hasEnv = SLACK_URL_RE.test(envUrl);
    const savedUrl = SLACK_URL_RE.test(saved.webhookUrl || '') ? saved.webhookUrl : '';
    const webhookUrl = hasEnv ? envUrl : savedUrl;
    const notifyOn = NOTIFY_MODES.includes(saved.notifyOn) ? saved.notifyOn : 'scheduled';
    return {
      webhookUrl,
      locked: hasEnv,
      notifyOn,
      onlyIfChanges: saved.onlyIfChanges !== false,
      lastSentAt: saved.lastSentAt || null,
      lastError: saved.lastError || null,
    };
  }

  function publicView() {
    const st = load();
    return {
      configured: !!st.webhookUrl,
      locked: st.locked,
      maskedUrl: maskUrl(st.webhookUrl),
      notifyOn: st.notifyOn,
      onlyIfChanges: st.onlyIfChanges,
      lastSentAt: st.lastSentAt,
      lastError: st.lastError,
    };
  }

  function save(patch = {}) {
    const saved = readJson(file, null) || {};
    const p = patch && typeof patch === 'object' ? patch : {};
    const next = { ...saved };

    if (p.clearWebhook) {
      delete next.webhookUrl;
      delete next.lastError;
    } else if (p.webhookUrl != null && String(p.webhookUrl).trim() !== '') {
      const url = String(p.webhookUrl).trim();
      if (!SLACK_URL_RE.test(url)) {
        throw new SlackError('Please enter a valid Slack Incoming Webhook URL (starts with https://hooks.slack.com/services/).');
      }
      next.webhookUrl = url;
      next.savedAt = new Date().toISOString();
      delete next.lastError;
    }

    if (p.notifyOn != null) {
      if (!NOTIFY_MODES.includes(p.notifyOn)) throw new SlackError('Choose when to notify Slack: Automatic checks only, Every check, or Off.');
      next.notifyOn = p.notifyOn;
    }
    if (p.onlyIfChanges != null) next.onlyIfChanges = !!p.onlyIfChanges;

    writeJson(file, next, { mode: 0o600 });
    return publicView();
  }

  async function postWebhook(url, payload) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 120);
        throw new SlackError(`Slack returned HTTP ${res.status}${body ? ' (' + body + ')' : ''}. Check that the webhook is still active.`);
      }
    } catch (e) {
      if (e instanceof SlackError) throw e;
      if (e.name === 'AbortError') throw new SlackError('Slack took too long to respond.');
      throw new SlackError('Could not reach Slack (' + ((e.cause && e.cause.code) || e.message) + ').');
    } finally {
      clearTimeout(timer);
    }
  }

  function recordStatus(errorMessage) {
    const saved = readJson(file, null) || {};
    if (errorMessage) saved.lastError = String(errorMessage).slice(0, 200);
    else {
      saved.lastSentAt = new Date().toISOString();
      delete saved.lastError;
    }
    writeJson(file, saved);
  }

  async function sendTest() {
    const st = load();
    if (!st.webhookUrl) throw new SlackError('Paste a Slack Incoming Webhook URL and save it first.');
    await postWebhook(st.webhookUrl, {
      text: 'School Info Sheet Slack integration is connected!',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: ':white_check_mark: *School Info Sheet connected!*\nScheduled website checks and school update summaries will be posted here.',
          },
        },
      ],
    });
    recordStatus(null);
    return publicView();
  }

  async function notifyRun(runInfo) {
    const st = load();
    if (!st.webhookUrl || st.notifyOn === 'off') return { skipped: 'not-configured' };
    if (st.notifyOn === 'scheduled' && !runInfo.scheduled) return { skipped: 'manual-run' };
    const changed = runInfo.changes || [];
    if (st.onlyIfChanges && !changed.length && !runInfo.exitCode) return { skipped: 'no-changes' };
    const payloads = buildRunPayloads({ ...runInfo, appUrl: publicUrl });
    try {
      for (let i = 0; i < payloads.length; i++) {
        if (i > 0) await sleep(GAP_BETWEEN_MESSAGES_MS);
        await postWebhook(st.webhookUrl, payloads[i]);
      }
      recordStatus(null);
      return { sent: true, changedSchools: changed.length, messages: payloads.length };
    } catch (e) {
      recordStatus(e.message);
      return { sent: false, error: e.message };
    }
  }

  return { load, publicView, save, sendTest, notifyRun, buildRunPayload, buildRunPayloads };
}

const defaultSlack = createSlack();

module.exports = {
  SLACK_URL_RE,
  NOTIFY_MODES,
  SlackError,
  buildRunPayload,
  buildRunPayloads,
  splitForBlocks,
  createSlack,
  load: defaultSlack.load,
  publicView: defaultSlack.publicView,
  save: defaultSlack.save,
  sendTest: defaultSlack.sendTest,
  notifyRun: defaultSlack.notifyRun,
};
