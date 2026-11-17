'use strict';
// Checks website change detection, built-in dashboard scheduler, Slack webhook validation/formatting,
// and server endpoints (/api/schedule, /api/slack-config, status=updated exports).
// Run: node tests/scheduler-slack.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { diffFields } = require('../src/lib/changes');
const { createScheduler, computeNextRun, isDue, scopeCommand, ScheduleError } = require('../src/lib/scheduler');
const { createSlack, buildRunPayload, buildRunPayloads, SlackError } = require('../src/lib/slack');

let passed = 0;
const ok = (name) => { passed++; console.log('  ok   ' + name); };

function call(port, method, reqPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: reqPath, headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js'), '--no-browser'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('server start timed out: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      if (/dashboard:/i.test(out)) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (!/dashboard:/i.test(out)) reject(new Error(`server exited (${code}): ${out}`));
    });
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-slack-test-'));
  let srv = null;

  try {
    // 1. Change detection (diffFields)
    const nextFields = {
      tuition: { status: 'found', value: '$54,500' },
      deadline: { status: 'found', value: 'Jan 15, 2027' },
      notes: { status: 'manual', note: 'ignored' },
      oldField: { status: 'none' },
    };
    assert.deepStrictEqual(diffFields(null, nextFields), []);
    assert.deepStrictEqual(diffFields({ status: 'blocked', fields: {} }, nextFields), []);
    const diffs = diffFields({
      status: 'ok',
      fields: {
        tuition: { status: 'found', value: ' $50,000 ' },
        deadline: { status: 'found', value: 'Jan 15, 2027' }, // unchanged
        notes: { status: 'manual', note: 'prev' },
        oldField: { status: 'found', value: 'Previous text' },
        newField: { status: 'none' },
      },
    }, {
      ...nextFields,
      newField: { status: 'found', value: 'Added value' },
    });
    assert.deepStrictEqual(diffs, [
      { key: 'tuition', kind: 'changed', before: '$50,000', after: '$54,500' },
      { key: 'oldField', kind: 'removed', before: 'Previous text' },
      { key: 'newField', kind: 'added', after: 'Added value' },
    ]);
    ok('diffFields ignores initial scrapes/unchanged values and tracks added, changed, and removed fields');

    // 2. Built-in scheduler math & validation
    const base = new Date(2026, 10, 13, 10, 0, 0).getTime(); // Fri Nov 13 2026 10:00 local
    const dailyLater = new Date(computeNextRun({ frequency: 'daily', hour: 14, minute: 0 }, base));
    assert.strictEqual(dailyLater.getDate(), 13);
    assert.strictEqual(dailyLater.getHours(), 14);
    const dailyTomorrow = new Date(computeNextRun({ frequency: 'daily', hour: 8, minute: 0 }, base));
    assert.strictEqual(dailyTomorrow.getDate(), 14);
    assert.strictEqual(dailyTomorrow.getHours(), 8);

    const sunNext = new Date(computeNextRun({ frequency: 'weekly', dayOfWeek: 0, hour: 2, minute: 0 }, base));
    assert.strictEqual(sunNext.getDay(), 0);
    assert.strictEqual(sunNext.getDate(), 15);

    const biAfter = new Date(computeNextRun({ frequency: 'biweekly', dayOfWeek: 0, hour: 2, minute: 0 }, sunNext.getTime(), { afterRun: true }));
    assert.strictEqual(Math.round((biAfter - sunNext) / 86400000), 14);

    const schedFile = path.join(tmp, 'schedule.json');
    const sched = createScheduler(schedFile);
    assert.strictEqual(sched.load().enabled, false);
    assert.throws(() => sched.save({ frequency: 'hourly' }), ScheduleError);
    assert.throws(() => sched.save({ scope: 'bad' }), ScheduleError);
    assert.throws(() => sched.save({ hour: 29 }), ScheduleError);

    const savedSched = sched.save({ enabled: true, frequency: 'weekly', dayOfWeek: 0, hour: 2, minute: 0, scope: 'tier1', refresh: true }, base);
    assert.strictEqual(savedSched.enabled, true);
    assert.strictEqual(isDue(savedSched, base), false);
    assert.strictEqual(isDue(savedSched, Date.parse(savedSched.nextRunAt) + 1000), true);
    assert.deepStrictEqual(scopeCommand('tier1', true), { args: ['--tier', '1', '--refresh'], label: 'Tier 1 schools (fresh check)' });
    ok('scheduler computes next runs cleanly across frequencies, validates input, and tracks due state');

    // 3. Slack webhook validation, secret masking & message rules
    const slackFile = path.join(tmp, 'slack.json');
    const sent = [];
    const mockFetch = async (url, opts) => {
      sent.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, text: async () => 'ok' };
    };
    const validHook = 'https://hooks.slack.com/services/T00000001/B00000002/abcdefghijklmnop1234';
    const slack = createSlack({ file: slackFile, env: {}, fetchImpl: mockFetch, publicUrl: 'https://schools.example.com' });

    assert.throws(() => slack.save({ webhookUrl: 'http://hooks.slack.com/services/a/b/c' }), SlackError);
    assert.throws(() => slack.save({ webhookUrl: 'https://evil.example.com/steal' }), SlackError);
    assert.throws(() => slack.save({ notifyOn: 'sometimes' }), SlackError);

    const pub = slack.save({ webhookUrl: validHook, notifyOn: 'scheduled', onlyIfChanges: true });
    assert.strictEqual(pub.configured, true);
    assert.strictEqual(pub.maskedUrl.endsWith('1234'), true);
    assert.ok(!pub.maskedUrl.includes('abcdefghijklmnop'), 'full webhook secret must never be returned to browser');

    await slack.sendTest();
    assert.strictEqual(sent.length, 1);

    // Skips manual run when notifyOn === 'scheduled'
    const manualRes = await slack.notifyRun({ label: 'Tier 1', scheduled: false, exitCode: 0, schoolsDone: 5, schoolsTotal: 5, changes: [{ name: 'Alpha', fields: [] }] });
    assert.strictEqual(manualRes.skipped, 'manual-run');
    // Skips scheduled run with 0 changes when onlyIfChanges === true
    const noChangeRes = await slack.notifyRun({ label: 'Tier 1', scheduled: true, exitCode: 0, schoolsDone: 5, schoolsTotal: 5, changes: [] });
    assert.strictEqual(noChangeRes.skipped, 'no-changes');

    // Sends when scheduled + changed schools found, escaping Slack mrkdwn special chars
    const sentRes = await slack.notifyRun({
      label: 'Tier 1 schools',
      scheduled: true,
      exitCode: 0,
      schoolsDone: 2,
      schoolsTotal: 2,
      durationMs: 120000,
      changes: [{ name: 'Alpha <Upper> & Lower', fields: [{ label: 'Tuition', kind: 'changed', before: '$50k', after: '$54k' }] }],
    });
    assert.strictEqual(sentRes.sent, true);
    assert.strictEqual(sent.length, 2);
    const payload = buildRunPayload({
      label: 'Tier 1',
      scheduled: true,
      schoolsDone: 1,
      schoolsTotal: 1,
      changes: [{ name: 'Alpha & Beta', fields: [{ label: 'Tuition', kind: 'changed', before: '$1', after: '$2' }] }],
      appUrl: 'https://schools.example.com',
    });
    assert.ok(JSON.stringify(payload.blocks).includes('Alpha &amp; Beta'));
    assert.ok(JSON.stringify(payload.blocks).includes('Open School Info Sheet dashboard'));
    ok('Slack enforces webhook allowlist, masks tokens, skips noise runs, and builds safe Block Kit alerts');

    // Complete messages: every school, every field and the whole old and new value; a long list is split into numbered messages, never cut short
    {
      const longBefore = 'Old mission statement. ' + 'The school was founded long ago and values curiosity above all. '.repeat(14);
      const longAfter = 'New mission statement. ' + 'Our students pursue higher education at renowned universities. '.repeat(14);
      const [one, ...rest] = buildRunPayloads({
        label: 'Tier 1', scheduled: true, schoolsDone: 1, schoolsTotal: 1, changes: [{ name: 'ASIJ | Upper', fields: [
          { label: 'About the School', kind: 'changed', before: longBefore, after: longAfter },
          { label: 'Tuition', kind: 'added', after: '$65,065' }, { label: 'Ratio', kind: 'removed', before: '8:1' }] }],
      });
      assert.strictEqual(rest.length, 0);
      const text = JSON.stringify(one.blocks);
      assert.ok(text.includes(longBefore) && text.includes(longAfter), 'the complete old and new value is in the message');
      assert.ok(!text.includes('…') && !/more school/.test(text), 'nothing is cut short with an ellipsis or "and N more"');
      assert.ok(/Before:/.test(text) && /Now:/.test(text) && /newly found/.test(text) && /no longer on the website/.test(text));

      // many schools with many fields: all of them appear, across several messages, each inside Slack's limits
      const many = Array.from({ length: 100 }, (_, i) => ({ name: `School ${i + 1}`, fields: Array.from({ length: 12 }, (_, j) => ({ label: `Field ${j + 1}`, kind: 'changed', before: `old ${i}-${j}`, after: `new ${i}-${j}` })) }));
      const msgs = buildRunPayloads({ label: 'All', scheduled: true, schoolsDone: 100, schoolsTotal: 100, changes: many, appUrl: 'https://schools.example.com' });
      assert.ok(msgs.length >= 3, 'a long list is split into several messages');
      const all = JSON.stringify(msgs.map((m) => m.blocks));
      for (let i = 1; i <= 100; i++) assert.ok(all.includes(`*School ${i}* (12 fields changed)`), `School ${i} is missing`);
      assert.ok(all.includes('old 0-0') && all.includes('new 99-11'), 'first and last fields are both present');
      msgs.forEach((m, i) => {
        assert.ok(m.blocks.length <= 50, 'at most 50 blocks per Slack message');
        for (const b of m.blocks) if (b.type === 'section') assert.ok(b.text.text.length <= 3000, 'at most 3,000 characters per text block');
        assert.ok(new RegExp(`Message ${i + 1} of ${msgs.length}`).test(JSON.stringify(m.blocks)), 'each message says which one it is');
      });
      assert.ok(JSON.stringify(msgs[msgs.length - 1].blocks).includes('Open School Info Sheet dashboard'), 'the dashboard link closes the last message');

      // a school whose listed website looks like a different school is flagged, in the header and on its own entry
      const flagged = buildRunPayloads({ label: 'Tier 1', scheduled: true, schoolsDone: 2, schoolsTotal: 2, changes: [
        { name: 'Crystal Springs (Middle) School', wrongSite: true, fields: [{ label: 'Mission', kind: 'changed', before: 'a', after: 'b' }] },
        { name: 'Real Change School', fields: [{ label: 'Tuition', kind: 'changed', before: '$1', after: '$2' }] }] });
      const ft = JSON.stringify(flagged[0].blocks);
      assert.ok(/1\*? of those has a website that looks like a different school/.test(ft), 'the header counts flagged schools');
      const csBlock = flagged[0].blocks.find((b) => b.type === 'section' && b.text.text.includes('Crystal Springs'));
      const realBlock = flagged[0].blocks.find((b) => b.type === 'section' && b.text.text.includes('Real Change School'));
      assert.ok(/looks like a different school, so this change may not be real/.test(csBlock.text.text), 'the wrong-website school carries a warning');
      assert.ok(!/different school/.test(realBlock.text.text), 'an ordinary school carries none');
      assert.ok(!/looks like a different school/.test(JSON.stringify(buildRunPayloads({ label: 'x', scheduled: true, schoolsDone: 1, schoolsTotal: 1, changes: [{ name: 'Fine', fields: [{ label: 'T', kind: 'added', after: '1' }] }] }))), 'nothing is flagged when no school is');

      // one very long value is split across blocks and nothing is lost
      const huge = 'start-marker ' + 'y'.repeat(7000) + ' end-marker';
      const hp = buildRunPayloads({ label: 'x', scheduled: true, schoolsDone: 1, schoolsTotal: 1, changes: [{ name: 'Big', fields: [{ label: 'About', kind: 'changed', before: 'short', after: huge }] }] });
      const joined = hp.flatMap((m) => m.blocks).filter((b) => b.type === 'section').map((b) => b.text.text).join('');
      assert.ok(joined.includes('start-marker') && joined.includes('end-marker') && (joined.match(/y/g) || []).length === 7000);

      // posting: one webhook call per message, spaced out
      const posted = [], pauses = [];
      const multi = createSlack({ file: path.join(tmp, 'slack-multi.json'), env: {}, fetchImpl: async (u, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200, text: async () => 'ok' }; }, sleep: async (ms) => { pauses.push(ms); } });
      multi.save({ webhookUrl: validHook, notifyOn: 'all' });
      const sentAll = await multi.notifyRun({ label: 'All', scheduled: false, exitCode: 0, schoolsDone: 100, schoolsTotal: 100, changes: many });
      assert.strictEqual(sentAll.sent, true); assert.strictEqual(sentAll.messages, posted.length); assert.ok(posted.length >= 3);
      assert.strictEqual(pauses.length, posted.length - 1, 'a short pause between messages keeps within Slack\'s rate limit');

      // the stored change keeps the whole value too (up to a safety cap)
      const { diffFields } = require('../src/lib/changes');
      const d = diffFields({ status: 'ok', fields: { about: { status: 'found', value: 'a' } } }, { about: { status: 'found', value: 'b'.repeat(1500) } });
      assert.strictEqual(d[0].after.length, 1500);
      ok('Slack alerts are complete: every school and field, whole old and new values, long lists split into numbered messages');
    }

    // 4. Server endpoints integration
    const dataDir = path.join(tmp, 'server-data');
    fs.mkdirSync(path.join(dataDir, 'sheet'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'results'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'template.json'), JSON.stringify({
      rows: [{ kind: 'field', key: 'tuition', label: 'Tuition', section: 'Costs' }],
    }));
    fs.writeFileSync(path.join(dataDir, 'schools.json'), JSON.stringify({
      importedAt: '2026-11-12T00:00:00.000Z',
      workbook: 'fixture.xlsx',
      schools: [
        { id: 'alpha', name: 'Alpha Academy', tier: 1, region: 'Bay', website: 'https://alpha.example.edu', tabs: [] },
        { id: 'beta', name: 'Beta Prep', tier: 1, region: 'LA', website: 'https://beta.example.edu', tabs: [] },
      ],
    }));
    fs.writeFileSync(path.join(dataDir, 'results', 'alpha.json'), JSON.stringify({
      id: 'alpha',
      name: 'Alpha Academy',
      scrapedAt: '2026-11-12T12:00:00.000Z',
      changedAt: '2026-11-12T12:00:00.000Z',
      status: 'ok',
      counts: { found: 1 },
      changes: [{ key: 'tuition', kind: 'changed', before: '$50,000', after: '$54,000' }],
      pages: [],
      fields: { tuition: { status: 'found', value: '$54,000', confidence: 'high', sources: [] } },
    }));
    fs.writeFileSync(path.join(dataDir, 'results', 'beta.json'), JSON.stringify({
      id: 'beta',
      name: 'Beta Prep',
      scrapedAt: '2026-11-12T12:00:00.000Z',
      status: 'ok',
      counts: { found: 1 },
      changes: [],
      pages: [],
      fields: { tuition: { status: 'found', value: '$45,000', confidence: 'high', sources: [] } },
    }));

    const PORT = 4510;
    srv = await startServer(PORT, dataDir);

    const ov = JSON.parse((await call(PORT, 'GET', '/api/overview')).body.toString('utf8'));
    assert.strictEqual(ov.schools.find((s) => s.id === 'alpha').changesCount, 1);
    assert.strictEqual(ov.schools.find((s) => s.id === 'beta').changesCount, 0);

    const updXlsx = await call(PORT, 'GET', '/api/export-spreadsheet?format=xlsx&status=updated');
    assert.strictEqual(updXlsx.status, 200);
    assert.strictEqual(updXlsx.headers['x-export-count'], '1');

    const getSch = await call(PORT, 'GET', '/api/schedule');
    assert.strictEqual(getSch.status, 200);
    assert.strictEqual(JSON.parse(getSch.body.toString('utf8')).enabled, false);

    const unauthSch = await call(PORT, 'POST', '/api/schedule', { headers: { 'Content-Type': 'application/json' }, body: '{"enabled":true}' });
    assert.strictEqual(unauthSch.status, 403);

    const pastIso = new Date(Date.now() - 5 * 3600e3).toISOString();
    const postSch = await call(PORT, 'POST', '/api/schedule', {
      headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' },
      body: JSON.stringify({ enabled: true, frequency: 'weekly', dayOfWeek: 0, hour: 3, scope: 'tier1', refresh: true, missedPolicy: 'ask' }),
    });
    assert.strictEqual(postSch.status, 200);
    const savedOnServer = JSON.parse(postSch.body.toString('utf8'));
    assert.strictEqual(savedOnServer.enabled, true);
    assert.strictEqual(savedOnServer.missedPolicy, 'ask');
    assert.ok(savedOnServer.nextRunAt);

    // Overdue detection & skip endpoint
    const schedOnDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'schedule.json'), 'utf8'));
    schedOnDisk.nextRunAt = pastIso;
    fs.writeFileSync(path.join(dataDir, 'schedule.json'), JSON.stringify(schedOnDisk));
    const overdueView = JSON.parse((await call(PORT, 'GET', '/api/schedule')).body.toString('utf8'));
    assert.strictEqual(overdueView.overdue, true);
    const skipRes = await call(PORT, 'POST', '/api/schedule/missed', {
      headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' },
      body: JSON.stringify({ action: 'skip' }),
    });
    assert.strictEqual(skipRes.status, 200);
    assert.strictEqual(JSON.parse(skipRes.body.toString('utf8')).overdue, false);

    const badSlack = await call(PORT, 'POST', '/api/slack-config', {
      headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' },
      body: JSON.stringify({ webhookUrl: 'https://example.com/not-slack' }),
    });
    assert.strictEqual(badSlack.status, 400);

    const goodSlack = await call(PORT, 'POST', '/api/slack-config', {
      headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' },
      body: JSON.stringify({ webhookUrl: validHook, notifyOn: 'all', onlyIfChanges: false }),
    });
    assert.strictEqual(goodSlack.status, 200);
    const slackState = JSON.parse(goodSlack.body.toString('utf8'));
    assert.strictEqual(slackState.configured, true);
    assert.strictEqual(slackState.notifyOn, 'all');
    assert.ok(!JSON.stringify(slackState).includes('abcdefghijklmnop'));
    ok('dashboard API exposes updated counts, schedule CRUD, Slack config masking, and updated-school exports');

    console.log(`\n${passed} checks passed.`);
  } finally {
    if (srv) srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('\nFAILED:', e.message, '\n', (e.stack || '').split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
