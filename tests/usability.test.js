'use strict';
// Checks the non-technical usability features:
//  - portable data directory preservation (%LocalAppData% on Windows portable builds)
//  - plain Excel (.xlsx) & CSV spreadsheet exports + CSV formula-injection neutralization
//  - local-only safe /api/shutdown & /api/setup metadata & navigation placement
// Run: node tests/usability.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');
const ExcelJS = require('exceljs');

const ROOT = path.join(__dirname, '..');
const { resolveDataDir } = require('../src/lib/util');
const { csvSafe } = require('../src/lib/spreadsheet-export');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usability-test-'));
  let srv = null;

  try {
    // 1. resolveDataDir rules
    const repoRoot = path.join(tmp, 'repo');
    const portRoot = path.join(tmp, 'portable');
    const portWithData = path.join(tmp, 'portable-existing');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(portRoot, { recursive: true });
    fs.writeFileSync(path.join(portRoot, '.portable-build'), '1');
    fs.mkdirSync(path.join(portWithData, 'data'), { recursive: true });
    fs.writeFileSync(path.join(portWithData, '.portable-build'), '1');
    fs.writeFileSync(path.join(portWithData, 'data', 'schools.json'), '{}');

    const localApp = path.join(tmp, 'LocalAppData');
    assert.strictEqual(
      resolveDataDir(portRoot, { LOCALAPPDATA: localApp }, 'win32'),
      path.join(localApp, 'SchoolInfoSheet', 'data'),
    );
    assert.strictEqual(
      resolveDataDir(portRoot, { DATA_DIR: path.join(tmp, 'custom'), LOCALAPPDATA: localApp }, 'win32'),
      path.resolve(path.join(tmp, 'custom')),
    );
    assert.strictEqual(
      resolveDataDir(portWithData, { LOCALAPPDATA: localApp }, 'win32'),
      path.join(portWithData, 'data'),
    );
    assert.strictEqual(
      resolveDataDir(repoRoot, { LOCALAPPDATA: localApp }, 'win32'),
      path.join(repoRoot, 'data'),
    );
    ok('resolveDataDir isolates Windows portable user data in %LocalAppData% while honoring DATA_DIR & existing data');

    // 2. csvSafe CWE-1236 formula neutralization
    assert.strictEqual(csvSafe('=SUM(A1:A2)'), `"'=SUM(A1:A2)"`);
    assert.strictEqual(csvSafe('+1-800'), `"'+1-800"`);
    assert.strictEqual(csvSafe('-100'), `"'-100"`);
    assert.strictEqual(csvSafe('@cmd'), `"'@cmd"`);
    assert.strictEqual(csvSafe('\tfoo'), `"'\\tfoo"`.replace('\\t', '\t'));
    assert.strictEqual(csvSafe('Say "Hi"'), `"Say ""Hi"""`);
    ok('csvSafe neutralizes leading formula characters and escapes embedded quotes');

    // 3. Full live dashboard fixture for spreadsheet export + shutdown + setup check
    const dataDir = path.join(tmp, 'fixture-data');
    fs.mkdirSync(path.join(dataDir, 'sheet'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'results'), { recursive: true });

    fs.writeFileSync(path.join(dataDir, 'template.json'), JSON.stringify({
      rows: [
        { kind: 'section', label: 'Costs' },
        { kind: 'field', key: 'tuition', label: 'Tuition', section: 'Costs' },
        { kind: 'field', key: 'deadline', label: 'Application Deadline', section: 'Costs' },
      ],
    }));
    fs.writeFileSync(path.join(dataDir, 'schools.json'), JSON.stringify({
      importedAt: '2026-11-12T00:00:00.000Z',
      workbook: 'fixture.xlsx',
      schools: [
        { id: 'alpha', name: 'Alpha Academy', tier: 1, region: 'Bay Area', website: 'https://alpha.example.edu', division: 'Upper', tabs: ['Alpha'] },
        { id: 'beta', name: 'Beta Prep', tier: 2, region: 'SoCal', website: 'https://beta.example.edu', division: 'All', tabs: ['Beta'] },
      ],
    }));
    fs.writeFileSync(path.join(dataDir, 'sheet', 'alpha.json'), JSON.stringify({
      tabs: [{
        name: 'Alpha',
        values: {
          tuition: { cols: [{ text: '=HYPERLINK("https://evil.example","Click")' }] },
        },
      }],
    }));
    fs.writeFileSync(path.join(dataDir, 'sheet', 'beta.json'), JSON.stringify({
      tabs: [{ name: 'Beta', values: {} }],
    }));
    fs.writeFileSync(path.join(dataDir, 'results', 'alpha.json'), JSON.stringify({
      id: 'alpha',
      name: 'Alpha Academy',
      scrapedAt: '2026-11-12T12:00:00.000Z',
      status: 'ok',
      counts: { found: 2 },
      identity: { ok: true },
      pages: ['https://alpha.example.edu/admissions'],
      fields: {
        tuition: {
          status: 'found',
          value: '$54,000',
          confidence: 'high',
          snippet: '2026-27 Tuition is $54,000',
          sources: [{ url: 'https://alpha.example.edu/tuition', quote: '2026-27 Tuition is $54,000' }],
        },
        deadline: {
          status: 'found',
          value: 'January 15, 2027',
          confidence: 'medium',
          snippet: 'Applications are due January 15, 2027',
          sources: [{ url: 'https://alpha.example.edu/apply', quote: 'Applications are due January 15, 2027' }],
        },
      },
    }));
    fs.writeFileSync(path.join(dataDir, 'results', 'beta.json'), JSON.stringify({
      id: 'beta',
      name: 'Beta Prep',
      scrapedAt: '2026-11-12T12:05:00.000Z',
      status: 'blocked',
      detail: 'HTTP 403',
      counts: { found: 0 },
      pages: [],
      fields: {},
    }));

    const PORT = 4509;
    srv = await startServer(PORT, dataDir);

    // Verify /api/setup returns active dataDir
    const setupRes = await call(PORT, 'GET', '/api/setup');
    assert.strictEqual(setupRes.status, 200);
    const setupJson = JSON.parse(setupRes.body.toString('utf8'));
    assert.strictEqual(setupJson.dataDir, dataDir);
    assert.ok(Array.isArray(setupJson.items) && setupJson.items.length > 0);
    ok('/api/setup reports dataDir and setup items');

    // Verify UI moved Script into footer and includes Turn off dashboard
    const htmlRes = await call(PORT, 'GET', '/');
    assert.strictEqual(htmlRes.status, 200);
    const htmlText = htmlRes.body.toString('utf8');
    const navMatch = /<nav[^>]*>([\s\S]*?)<\/nav>/i.exec(htmlText);
    assert.ok(navMatch && !navMatch[1].includes('#/script'), 'Script link should not live inside primary nav');
    assert.ok(htmlText.includes('class="appfoot"') && htmlText.includes('#/script') && htmlText.includes('id="quitbtn"'));
    ok('index.html moves Script link to footer and exposes local shutdown control');

    // Verify CSV export + formula escaping
    const csvRes = await call(PORT, 'GET', '/api/export-spreadsheet?format=csv&all=1');
    assert.strictEqual(csvRes.status, 200);
    assert.match(csvRes.headers['content-type'], /text\/csv/);
    const csvText = csvRes.body.toString('utf8');
    assert.ok(csvText.startsWith('\uFEFF"School","Tier","Section","Question"'), 'CSV should start with UTF-8 BOM + expected headers');
    assert.ok(csvText.includes(`"'=HYPERLINK(""`), 'CSV export must neutralize formula cells');
    assert.ok(csvText.includes('Alpha Academy') && csvText.includes('Beta Prep'));
    ok('GET /api/export-spreadsheet?format=csv exports UTF-8 BOM CSV and neutralizes formulas');

    // Verify Excel export (multi-school)
    const xlsxAllRes = await call(PORT, 'GET', '/api/export-spreadsheet?format=xlsx&all=1');
    assert.strictEqual(xlsxAllRes.status, 200);
    assert.strictEqual(xlsxAllRes.headers['x-export-count'], '2');
    assert.strictEqual(xlsxAllRes.body.subarray(0, 2).toString('utf8'), 'PK');
    const wbAll = new ExcelJS.Workbook();
    await wbAll.xlsx.load(xlsxAllRes.body);
    assert.deepStrictEqual(wbAll.worksheets.map((w) => w.name), ['Schools Summary', 'Website Answers']);
    assert.strictEqual(wbAll.getWorksheet('Schools Summary').rowCount, 3);
    assert.ok(wbAll.getWorksheet('Website Answers').rowCount >= 4);
    ok('GET /api/export-spreadsheet?format=xlsx&all=1 generates valid two-tab workbook');

    // Verify single-school Excel export & status=problem filter
    const xlsxOneRes = await call(PORT, 'GET', '/api/export-spreadsheet?format=xlsx&id=alpha');
    assert.strictEqual(xlsxOneRes.status, 200);
    assert.strictEqual(xlsxOneRes.headers['x-export-count'], '1');
    const wbOne = new ExcelJS.Workbook();
    await wbOne.xlsx.load(xlsxOneRes.body);
    assert.deepStrictEqual(wbOne.worksheets.map((w) => w.name), ['Alpha Academy']);

    const probRes = await call(PORT, 'GET', '/api/export-spreadsheet?format=xlsx&status=problem');
    assert.strictEqual(probRes.status, 200);
    assert.strictEqual(probRes.headers['x-export-count'], '1');

    const badRes = await call(PORT, 'GET', '/api/export-spreadsheet?format=csv&ids=unknown');
    assert.strictEqual(badRes.status, 409);
    ok('single-school export, status=problem filter, and unknown school validation work properly');

    // Verify malformed workbook upload returns clear 400 and preserves current overview intact
    const badWb = await call(PORT, 'POST', '/api/workbook', {
      headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('not-an-excel-zip-file'),
    });
    assert.strictEqual(badWb.status, 400);
    assert.match(JSON.parse(badWb.body.toString('utf8')).error, /Excel/i);
    const stillOv = await call(PORT, 'GET', '/api/overview');
    assert.strictEqual(JSON.parse(stillOv.body.toString('utf8')).ready, true);
    ok('POST /api/workbook rejects non-xlsx uploads with clear message and preserves loaded schools');

    // Verify /api/shutdown rejects missing header and shuts down cleanly when authorized
    const unauthStop = await call(PORT, 'POST', '/api/shutdown', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(unauthStop.status, 403);

    const exitPromise = new Promise((resolve) => srv.once('exit', (code) => resolve(code)));
    const authStop = await call(PORT, 'POST', '/api/shutdown', {
      headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' },
      body: '{}',
    });
    assert.strictEqual(authStop.status, 200);
    const code = await Promise.race([
      exitPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('server did not exit on shutdown')), 4000)),
    ]);
    assert.strictEqual(code, 0);
    srv = null;
    ok('POST /api/shutdown requires X-Dashboard header and exits local server cleanly');

    // Regression: All dashboard routes render cleanly with zero null/undefined leaks, disable empty Run buttons, and handle 401 sign-in redirects
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'public', 'app.js'), 'utf8');
    async function renderRoute({ hash = '#/ask', webSearchOn = true, force401OnExport = false, blockedSchool = false, holdWorkbook = null, askStatus = null } = {}) {
      const makeText = (s) => ({ nodeType: 3, textContent: String(s) });
      const appended = [];
      function makeNode(tag) {
        const el = {
          nodeType: tag === '#frag' ? 11 : 1,
          tagName: String(tag).toUpperCase(),
          className: '',
          attrs: {},
          children: [],
          style: {},
          dataset: {},
          disabled: false,
          hidden: false,
          classList: { toggle: () => {}, add: () => {}, remove: () => {} },
          setAttribute(k, v) {
            el.attrs[k] = v;
            if (k === 'disabled' || k === 'hidden') el[k] = true;
            if (k.startsWith('data-')) el.dataset[k.slice(5)] = String(v);
          },
          addEventListener(type, fn) { if (type === 'click') el.onclick = fn; },   // lets a test press a button
          focus() {},
          click() { el._clicked = true; if (el.onclick) return el.onclick({ preventDefault: () => {} }); },
          remove() {},
          append(...args) {
            for (const a of args) {
              if (a && a.nodeType === 11) el.children.push(...a.children);
              else if (a && a.nodeType) el.children.push(a);
              else el.children.push(makeText(String(a)));
            }
          },
          replaceChildren(...args) { el.children = []; el.append(...args); },
          querySelector(sel) {
            const cls = sel.split(/\s+/).pop().replace(/^\./, '');
            const stack = [...el.children];
            while (stack.length) {
              const cur = stack.shift();
              if (cur.nodeType === 1) {
                if ((cur.className || '').split(/\s+/).includes(cls)) return cur;
                stack.unshift(...cur.children);
              }
            }
            return null;
          },
          get options() { return el.children.filter((c) => c.tagName === 'OPTION'); },
        };
        return el;
      }
      const calls = [];
      const rootApp = makeNode('main');
      const byId = { app: rootApp, jobpill: makeNode('span'), who: makeNode('span'), quitbtn: makeNode('button'), dataloc: makeNode('span'), tasks: makeNode('div') };
      const hashListeners = [];
      const allByTag = (root, tag) => {
        const out = [];
        const walk = (n) => { if (n.tagName === tag) out.push(n); for (const c of n.children || []) walk(c); };
        walk(root);
        return out;
      };
      const location = { hash, href: 'http://127.0.0.1/' + hash };
      const ctx = {
        URL,
        URLSearchParams,
        location,
        history: { replaceState: () => {} },
        window: { addEventListener: (type, fn) => { if (type === 'hashchange') hashListeners.push(fn); }, scrollY: 0, scrollTo: () => {} },
        setTimeout: () => 0,
        clearTimeout: () => {},
        requestAnimationFrame: (fn) => fn(),
        document: {
          body: Object.assign(makeNode('body'), { dataset: {}, append: (...x) => appended.push(...x) }),
          hidden: false,
          getElementById: (id) => byId[id] || null,
          querySelectorAll: () => [],
          createElement: (tag) => makeNode(tag),
          createTextNode: makeText,
          createDocumentFragment: () => makeNode('#frag'),
        },
        fetch: async (url, opts) => {
          const clean = String(url).split('?')[0];
          let sent = null; try { sent = opts && opts.body ? JSON.parse(opts.body) : null; } catch { /* a file upload is not JSON */ }
          calls.push({ url: clean, method: (opts && opts.method) || 'GET', body: sent });
          if (clean === '/api/workbook' && holdWorkbook) await holdWorkbook;   // lets a test leave the page while the sheet is still loading
          if (clean === '/api/verify' && opts && opts.method === 'POST') return { ok: true, status: 200, json: async () => ({ verdict: 'correct', stale: false }) };
          if (force401OnExport && clean === '/api/export-spreadsheet') {
            return { ok: false, status: 401, json: async () => ({ error: 'Please sign in again.', signIn: '/auth/login' }) };
          }
          const payloads = {
            '/api/overview': {
              ready: true,
              fieldCount: 5,
              schools: [{
                id: 'a', name: 'Alpha Academy', tier: 1, status: 'ok', found: 2, fills: 1, differs: 0,
                website: 'https://alpha.edu', urlChanged: true, previousStart: 'https://old-alpha.edu', changesCount: 1, changesSummary: ['Tuition'],
              }],
            },
            '/api/school': {
              school: { id: 'a', name: 'Alpha Academy', tier: 1, website: 'https://alpha.edu', tabs: ['Alpha'] },
              tabs: [{ tab: 'Alpha', matchedBy: 'exact' }], tabIndex: 0, urlChanged: true, previousStart: 'https://old-alpha.edu',
              result: { status: blockedSchool ? 'blocked' : 'ok', start: 'https://old-alpha.edu', scrapedAt: new Date().toISOString(), counts: { found: 1 }, pages: [], fields: {}, changes: [] },
              counts: { fills: 1, differs: 0, match: 0, both: 0, 'sheet-only': 0, none: 0 },
              rows: [{ kind: 'field', row: 5, key: 'tuition', hasRule: true, section: 'Tuition', label: 'Tuition:', verdict: 'fills', sheet: [], scraped: { status: 'found', value: '$40,000', confidence: 'high', sources: [] }, trust: { score: 71, level: 'medium', triage: 'check', needsReview: false, reasons: [{ text: 'Starts from how often tuition has agreed with your sheet.', effect: 0 }, { text: 'No school year shown next to the figure.', effect: -1.2 }] } }],
            },
            '/api/schedule': { enabled: false, frequency: 'weekly', scope: 'tier1', weekday: 1, time: '02:00', windowsTask: { supported: false } },
            '/api/verify': {},
            '/api/manual-pages': { site: 'alpha.edu', pages: [{ id: 'p1', name: 'tuition.html', url: 'https://alpha.edu/tuition', urlFrom: 'page', title: 'Tuition', kind: 'html', bytes: 2048, chars: 900, addedAt: '2026-11-17T00:00:00Z' }], max: 60 },
            '/api/review-queue': {
              ready: true, facts: 4, readyToUse: 2, checked: 0, needLook: 2, skippedWrongSite: 0, truncated: false,
              byField: [{ key: 'enrollment', label: 'Total enrollment:', n: 1 }, { key: 'tuition', label: 'Tuition:', n: 1 }],
              items: [
                { schoolId: 'a', school: 'Alpha Academy', tier: 1, field: 'enrollment', label: 'Total enrollment:', value: '2,564', source: 'https://alpha.edu/about', score: 22, level: 'low', triage: 'doubtful', why: ['The page does not say which division this covers.'] },
                { schoolId: 'a', school: 'Alpha Academy', tier: 1, field: 'tuition', label: 'Tuition:', value: '$40,000', source: null, score: 71, level: 'medium', triage: 'check', why: ['No school year shown next to the figure.'] },
              ],
            },
            '/api/accuracy': {
              report: { minChecks: 10, bars: { trust: 0.95, review: 0.85 }, keyFields: [{ key: 'tuition', label: 'Tuition' }], staleChecks: 0, fields: [], confidence: [], errors: [],
                overall: { checks: 0, correct: 0, wrong: 0, missed: 0, absent: 0, rightWhenItAnswers: null, range: null, findsWhatIsThere: null, status: 'few' } },
              sample: null,
            },
            '/api/slack-config': { enabled: false, configured: false },
            '/api/export-config': { configured: false },
            '/api/code': {
              files: [{ file: 'src/server.js', lines: 1, group: 'Server', note: 'Dashboard server' }],
              config: { crawl: { parallelSites: 4, delayMs: 1500, maxPagesPerSite: 40, maxPdfsPerSite: 4, cacheDays: 7 } },
              file: 'src/server.js', content: '// server',
            },
            '/api/ask/status': {
              ready: true, canEditSettings: true, provider: 'anthropic', effort: 'medium', webSearch: webSearchOn, webSearchOn,
              monthlyCapUsd: 5, spentThisMonth: 0.25, kbCount: 2,
              locked: { model: true, effort: true, costPolicy: true },
              anthropic: { configured: true, model: 'claude-sonnet-5-5', models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (cheaper)' }] },
              groq: { configured: false, model: 'llama', models: ['llama'] },
              ...(askStatus || {}),
            },
            '/api/ask/memory': { notes: [] },
            '/api/ask/sessions': { sessions: [] },
            '/api/job': { running: false },
            '/api/me': { local: true },
            '/api/setup': { dataDir: tmp, items: [{ id: 'node', status: 'ok', title: 'Ready', detail: 'Node OK' }] },
          };
          return { ok: true, status: 200, json: async () => payloads[clean] || {} };
        },
      };
      vm.runInNewContext(appSrc, ctx, { filename: 'src/public/app.js' });
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
      const walkText = (n) => (n.nodeType === 3 ? n.textContent : (n.children || []).map(walkText).join('|'));
      const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
      const go = async (hsh) => { location.hash = hsh; for (const fn of hashListeners) await fn(); await settle(); };   // like clicking a menu link
      return { rootApp, walkText, buttons: () => allByTag(rootApp, 'BUTTON'), links: () => allByTag(rootApp, 'A'), inputs: () => allByTag(rootApp, 'INPUT'), tasks: byId.tasks, go, settle, location, calls, doc: ctx.document };
    }
    for (const [hsh, expectText] of [
      ['#/ask', 'New chat'],
      ['#/start', 'Load your school sheet'],
      ['#/', 'Alpha Academy'],
      ['#/school/a', 'Alpha Academy'],
      ['#/run', 'Tier 1 (1)'],
      ['#/accuracy', 'Pick 30 schools for me'],
      ['#/review', 'Answers to check'],
      ['#/help', 'What is this dashboard for?'],
      ['#/script', 'src/server.js'],
    ]) {
      const res = await renderRoute({ hash: hsh, webSearchOn: hsh === '#/ask' });
      const txt = res.walkText(res.rootApp);
      assert.ok(txt.includes(expectText), `${hsh} should render "${expectText}"`);
      assert.ok(!/\b(?:null|undefined|NaN)\b/i.test(txt), `${hsh} must never render literal null/undefined/NaN: ${txt}`);
      if (hsh === '#/run') {
        const tier1 = res.buttons().find((b) => res.walkText(b).includes('Tier 1 (1)'));
        const tier2 = res.buttons().find((b) => res.walkText(b).includes('Tier 2 (0)'));
        assert.ok(tier1 && !tier1.disabled, 'non-zero Tier 1 button should stay enabled');
        assert.ok(tier2 && tier2.disabled, '0-count Tier 2 button should start disabled');
        // Choosing a tier only selects it: nothing starts until "Start checking" is pressed
        const startBtn = () => res.buttons().find((b) => /^Start checking/.test(res.walkText(b)) && b.attrs['data-run'] === '1');
        assert.ok(startBtn() && startBtn().disabled, '"Start checking" must be off until a group is chosen');
        await tier1.click();
        assert.strictEqual(res.calls.filter((c) => c.url === '/api/run').length, 0, 'clicking a tier must not start a scrape');
        assert.strictEqual(tier1.attrs['aria-pressed'], 'true', 'the chosen tier shows as selected');
        assert.ok(!startBtn().disabled, '"Start checking" turns on once a group is chosen');
        await startBtn().click();
        const run = res.calls.find((c) => c.url === '/api/run');
        assert.ok(run && run.method === 'POST' && run.body.scope === 'tier' && run.body.tier === 1, 'Start checking starts the chosen tier');
        assert.strictEqual(res.calls.filter((c) => c.url === '/api/run').length, 1);
        await startBtn().click();
        assert.strictEqual(res.calls.filter((c) => c.url === '/api/run').length, 1, 'a second press must not start the same run again');
      }
      if (hsh === '#/review') {
        assert.ok(txt.includes('Alpha Academy') && txt.includes('2,564') && txt.includes('Check this · 22/100'), 'the queue lists the doubtful value with its score');
        assert.ok(txt.includes('alpha.edu/about') && txt.includes('none'), 'the source page is shown as a link, or none');
        assert.ok(!/sheet says/i.test(txt), 'the queue does not mention the sheet');
        assert.ok(txt.includes('50%') && txt.includes('need your check'), 'the tiles show how much is ready to use');
        const fieldBtn = res.buttons().find((b) => res.walkText(b).startsWith('Total enrollment'));
        assert.ok(fieldBtn, 'a button per field lets a researcher work one field at a time');
        await fieldBtn.click();
        assert.ok(res.calls.some((c) => c.url === '/api/review-queue'), 'the queue loads from the server');
      }
      if (hsh === '#/school/a') {
        assert.ok(txt.includes('Quick look') && txt.includes('71/100'), 'a found value shows its trust score');
        assert.ok(txt.includes('No school year shown next to the figure.'), 'the reasons behind the score are shown');
        // a found value can be spot-checked right on the school page
        const rightBtn = res.buttons().find((b) => res.walkText(b) === '✓ Right');
        assert.ok(rightBtn && res.buttons().some((b) => res.walkText(b) === '✗ Wrong'), 'a found value offers Right and Wrong');
        await rightBtn.click();
        const posted = res.calls.find((c) => c.url === '/api/verify' && c.method === 'POST');
        assert.ok(posted && posted.body.school_id === 'a' && posted.body.field === 'tuition' && posted.body.verdict === 'correct', 'pressing Right records the check');
        assert.ok(res.walkText(res.rootApp).includes('You marked it: right'), 'the row then shows that it was checked');
      }
      if (hsh === '#/ask') {
        const effWrap = res.rootApp.querySelector('.effort-wrap');
        const settingsEl = res.rootApp.querySelector('.asksettings');
        assert.ok(effWrap && effWrap.hidden === true, 'Effort selector must stay hidden when locked');
        assert.ok(res.rootApp.querySelector('.askshell') && res.rootApp.querySelector('.ask-side') && res.rootApp.querySelector('.composer-card'), 'Redesigned Ask shell, sidebar & composer card should render');
        assert.ok(res.rootApp.querySelector('.school-pick') && res.rootApp.querySelector('.ask-cards'), 'School quick-picker and starter cards should render');
        assert.ok(txt.includes('Saved notes (0) · Learned answers (2)'), 'Compact Memory/KB pill should render in Ask toolbar');
        assert.ok(!txt.includes('Default thinking effort') && !txt.includes('locked to Claude'), 'Locked settings notices/controls must not be shown');
        assert.ok(!txt.includes('Claude Sonnet 5.5'), 'Locked model label must stay hidden in Ask bar');
        assert.ok(!res.walkText(settingsEl).includes('|Model|'), 'Locked Model select must be omitted from AI settings');
      }
    }
    // The colour key: what the colours in the Google Sheet file and the Excel file mean, shown on Help and next to the buttons that make the files
    {
      const swatchColours = (n) => { const out = []; const walk = (x) => { if (x.nodeType === 1 && /\bswatch\b/.test(x.className || '') && x.style.background) out.push(x.style.background.toLowerCase()); (x.children || []).forEach(walk); }; walk(n); return out; };
      const gsSrc = fs.readFileSync(path.join(ROOT, 'google-sheet', 'Code.gs'), 'utf8');
      const xlSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'spreadsheet-export.js'), 'utf8');
      const yellow = /FILLED_COLOR:\s*'(#[0-9a-f]{6})'/i.exec(gsSrc)[1].toLowerCase(), orange = /UPDATE_COLOR:\s*'(#[0-9a-f]{6})'/i.exec(gsSrc)[1].toLowerCase();
      const fill = (k) => '#' + new RegExp(`${k}: 'FF([0-9A-F]{6})'`).exec(xlSrc)[1].toLowerCase();
      const help = await renderRoute({ hash: '#/help/colours' });
      const ht = help.walkText(help.rootApp);
      assert.ok(ht.includes('What the colours mean in your Google Sheet and Excel files') && ht.includes('School Info → Load export file…') && ht.includes('How They Compare'), 'Help explains the colours of both files');
      for (const word of ['Yellow:', 'Orange:', 'Blue:', 'Green:', 'No colour:']) assert.ok(ht.includes(word), `the key names ${word}`);
      assert.deepStrictEqual(swatchColours(help.rootApp), [yellow, orange, fill('fills'), fill('differs'), fill('match')], 'the swatches are exactly the colours the Google Sheet script and the Excel file really use');
      assert.ok(ht.includes('Jump to:') && help.links().some((a) => a.attrs.href === '#/help/colours'), 'Help has a jump-to menu for its sections');
      assert.ok(help.doc.title.startsWith('Help'), 'the browser tab is named after the page');
      const school = await renderRoute({ hash: '#/school/a' });
      const st = school.walkText(school.rootApp);
      assert.ok(st.includes('What do the colours in the Google Sheet and Excel files mean?') && swatchColours(school.rootApp).length === 5, 'a school page shows the colour key beside its download buttons');
      assert.ok(school.links().some((a) => a.attrs.href === '#/help/colours'), 'and links to the full explanation');
      assert.ok(school.doc.title.startsWith('Alpha Academy'), 'a school page names the browser tab after the school');
      const start = await renderRoute({ hash: '#/start' });
      assert.ok(start.walkText(start.rootApp).includes('What do the colours in the Google Sheet and Excel files mean?'), 'Start here shows the colour key next to the downloads');
      ok('the colour key on Help, school pages and Start here uses exactly the colours the Google Sheet script and the Excel file really use');
    }

    // Easier to follow: a next-step card, a Schools table that fits, and links from each page to the part of Help that explains it
    {
      const schools = await renderRoute({ hash: '#/' });
      const t = schools.walkText(schools.rootApp);
      assert.ok(t.includes('All done: every school is checked'), 'a next-step card says what to do next (everything checked here)');
      const headers = []; const walkTh = (n) => { if (n.tagName === 'TH') headers.push(schools.walkText(n).replace(/\|/g, '').trim()); (n.children || []).forEach(walkTh); }; walkTh(schools.rootApp);
      assert.ok(headers.includes('Last checked') && !headers.includes('Website') && !headers.includes('Sent to Google Sheet'), 'the table drops the two columns that pushed it off the screen: ' + headers.join(','));
      assert.ok(t.includes('Website:') && t.includes('alpha.edu') && t.includes('link changed'), 'the website and link warnings sit under the school name');
      assert.ok(schools.links().some((a) => a.attrs.href === '#/help/status'), 'Schools links to what its labels mean');
      const review = await renderRoute({ hash: '#/review' });
      assert.ok(review.links().some((a) => a.attrs.href === '#/help/ratings'), 'To check links to what the ratings mean');
      assert.ok(review.rootApp.querySelector('.whycol'), 'the Why column has its own width so it is not squeezed');
      const empty = await renderRoute({ hash: '#/start' });
      assert.ok(empty.rootApp.querySelector('.nextstep'), 'Start here shows the next-step card');
      ok('next-step card, a Schools table without the two off-screen columns, Help links on each page, and a wider Why column');
    }

    // A website that refuses automatic reading: the school page explains the way forward and takes pages the person saved by hand
    {
      const blocked = await renderRoute({ hash: '#/school/a', blockedSchool: true });
      const bt = blocked.walkText(blocked.rootApp);
      const panel = blocked.rootApp.querySelector('.savedpages');
      assert.ok(panel && 'open' in panel.attrs, 'the saved-pages panel is open on a blocked school');
      assert.ok(bt.includes('does not let the dashboard in') && bt.includes('Ctrl + S') && bt.includes('Webpage, Complete') && bt.includes('Read these pages'), 'it explains how to save the pages and read them');
      assert.ok(bt.includes('does not try to get around it') && !/bypass|workaround|evade/i.test(bt), 'it says plainly that the dashboard does not get around the security check');
      assert.ok(bt.includes('Tuition') && bt.includes('Remove'), 'pages already saved are listed, each with Remove');
      assert.ok(blocked.calls.some((c) => c.url === '/api/manual-pages' && c.method === 'GET'), 'the saved pages are loaded from the server');
      assert.ok(blocked.links().some((a) => a.attrs.href === '#/help/blocked'), 'and it links to the Help section about blocked websites');
      const normal = await renderRoute({ hash: '#/school/a' });
      assert.ok(!normal.rootApp.querySelector('.savedpages'), 'a school that was read normally does not show the panel');
      const help = await renderRoute({ hash: '#/help/blocked' });
      const ht = help.walkText(help.rootApp);
      assert.ok(ht.includes('A school’s website will not let the dashboard in') && ht.includes('SchoolInfoSheetBot/1.0') && ht.includes('Could your web team allow that name'), 'Help explains the two ways forward and gives a message to send the school');
      ok('a blocked school page explains how to save the pages by hand, lists them, and never suggests getting around the check');
    }

    // Anything that takes a while keeps going when the person opens another page, and finishing never pulls them back
    {
      const sheetInput = (res) => res.inputs().find((i) => i.attrs.type === 'file' && /School Information Sheet/.test(i.attrs['aria-label'] || ''));
      let release;
      const gate = new Promise((r) => { release = r; });
      const res = await renderRoute({ hash: '#/start', holdWorkbook: gate });
      const input = sheetInput(res);
      assert.ok(input, 'Start here has the sheet chooser');
      input.files = [{ name: 'Marketing Sheet.xlsx' }];
      input.onchange();
      await res.settle();
      assert.ok(res.walkText(res.tasks).includes('Loading your school sheet'), 'a card says the sheet is loading');
      assert.ok(res.walkText(res.tasks).includes('You can keep using the dashboard'), 'the card says the person does not have to wait');
      await res.go('#/help');
      assert.ok(res.walkText(res.rootApp).includes('What is this dashboard for?'), 'the person can open another page while the sheet loads');
      assert.ok(res.walkText(res.tasks).includes('Loading your school sheet'), 'and the card follows them to that page');
      await res.go('#/start');
      assert.ok(res.walkText(res.rootApp).includes('Reading…') && !res.walkText(res.rootApp).includes('Waiting for your file'), 'coming back to Start here shows that it is still reading, not an empty box');
      await res.go('#/help');
      release();
      await res.settle();
      const after = res.walkText(res.rootApp);
      assert.ok(after.includes('What is this dashboard for?') && !after.includes('Load your school sheet'), 'finishing does not pull the person back to Start here');
      const tray = res.walkText(res.tasks);
      assert.ok(tray.includes('Your school sheet is loaded') && tray.includes('Open the school list'), 'a card says it is done, with a link to the school list: ' + tray);
      assert.ok(res.links().length >= 0 && res.calls.filter((c) => c.url === '/api/workbook').length === 1, 'the sheet was sent exactly once');

      // staying on Start here: the page updates by itself when the sheet is ready
      let release2;
      const gate2 = new Promise((r) => { release2 = r; });
      const stay = await renderRoute({ hash: '#/start', holdWorkbook: gate2 });
      const input2 = sheetInput(stay);
      input2.files = [{ name: 'Marketing Sheet.xlsx' }];
      input2.onchange();
      await stay.settle();
      release2();
      await stay.settle();
      assert.ok(stay.walkText(stay.rootApp).includes('Replace sheet (.xlsx)'), 'on Start here the page shows the loaded sheet by itself');

      // a download keeps its own card
      const dl = await renderRoute({ hash: '#/start' });
      const xl = dl.buttons().find((b) => dl.walkText(b).includes('Download Excel (.xlsx)'));
      assert.ok(xl);
      await xl.click();
      await dl.settle();
      assert.ok(dl.calls.some((c) => c.url === '/api/export-spreadsheet'), 'the Excel file was asked for');
      ok('loading the sheet keeps going on other pages, shows a card, and never pulls the person back to Start here');
    }

    // The Google Sheet script: the steps to install and use it are in the dashboard, with the script to copy
    {
      const setup = await renderRoute({ hash: '#/sheet-setup' });
      const st = setup.walkText(setup.rootApp).replace(/\|/g, '');
      for (const need of ['Set up the Google Sheet menu, step by step', 'Before you start', 'Part 1', 'Part 2', 'Extensions', 'Apps Script', 'School Info Export', 'Add a new file', 'Copy the script', 'Save', 'reload the page',
        'Advanced', 'Go to School Info Export (unsafe)', 'Allow', 'Choose file', 'Load into this sheet', 'Keep that window open until it says Done', 'Reviewed?', 'If something goes wrong', 'I do not see the School Info menu']) {
        assert.ok(st.includes(need), `the setup page says: ${need}`);
      }
      assert.ok(st.includes('Download the file for 1 checked school'), 'it offers the file for the checked schools');
      assert.strictEqual((st.match(/Yellow:/g) || []).length, 1, 'and shows the colour key');
      // the menu names in the steps are the real ones from the script
      const gs = fs.readFileSync(path.join(ROOT, 'google-sheet', 'Code.gs'), 'utf8');
      const menu = /createMenu\('([^']+)'\)/.exec(gs)[1];
      const items = [...gs.matchAll(/\.addItem\('([^']+)'/g)].map((m) => m[1].replace(/\.\.\./g, '…'));
      assert.ok(menu === 'School Info' && items.length >= 2, 'the script adds a School Info menu with items');
      for (const item of items) assert.ok(st.includes(item), `the steps name the menu item “${item}” exactly as the script makes it`);
      assert.ok(st.includes('NOTIFY_EMAILS') && /NOTIFY_EMAILS:\s*''/.test(gs), 'the step about the email setting names a line that exists in the script');
      const copy = setup.buttons().find((b) => setup.walkText(b) === 'Copy the script');
      assert.ok(copy, 'there is a Copy the script button');
      await copy.click();
      await setup.settle();
      assert.ok(setup.calls.some((c) => c.url === '/api/code'), 'the script comes from the dashboard');
      assert.strictEqual(setup.doc.title, 'Google Sheet setup · School Info Sheet');
      // it can be found from where people look
      for (const hsh of ['#/start', '#/school/a', '#/help']) {
        const r = await renderRoute({ hash: hsh });
        assert.ok(r.links().some((a) => a.attrs.href === '#/sheet-setup'), `${hsh} links to the step-by-step setup`);
      }
      ok('the Google Sheet script has its own step-by-step page with the script to copy, the real menu names, and links from Start here, school pages and Help');
    }

    // The AI settings on a shared server: the administrator sees and edits them, everyone else only sees the status
    {
      const notConnected = { ready: false, anthropic: { configured: false, keyHint: null, keySource: null, model: 'claude-sonnet-5-5', models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (cheaper)' }] }, locked: { model: true, effort: true, costPolicy: true }, sharedServer: true };
      const admin = await renderRoute({ hash: '#/ask', askStatus: { ...notConnected, canEditSettings: true, adminsSet: true } });
      const at = admin.walkText(admin.rootApp);
      assert.ok(at.includes('administrator only') && at.includes('Only you can see this') && at.includes('Anthropic API key'), 'the administrator gets the key box, marked as for them only');
      const other = await renderRoute({ hash: '#/ask', askStatus: { ...notConnected, canEditSettings: false, adminsSet: true } });
      const ot = other.walkText(other.rootApp);
      assert.ok(ot.includes('Only the AI administrator can connect it') && !ot.includes('Anthropic API key') && !ot.includes('Only you can see this'), 'everyone else sees a plain status and no key box');
      const nobody = await renderRoute({ hash: '#/ask', askStatus: { ...notConnected, canEditSettings: false, adminsSet: false } });
      assert.ok(nobody.walkText(nobody.rootApp).includes('ASK_ADMIN_EMAILS'), 'when no administrator is set up, it says how to set one up');
      const mine = await renderRoute({ hash: '#/ask', askStatus: { ...notConnected, sharedServer: false, canEditSettings: true } });
      assert.ok(!mine.walkText(mine.rootApp).includes('administrator only'), 'on a private computer nothing changes');
      ok('Ask settings: the administrator sees the key box on a shared server, everyone else only the status, and a private computer is unchanged');
    }

    const barNoWeb = await renderRoute({ hash: '#/ask', webSearchOn: false });
    const barNoWebTxt = barNoWeb.walkText(barNoWeb.rootApp.querySelector('.askbar'));
    assert.ok(barNoWebTxt.includes('New chat') && !/\bnull\b/i.test(barNoWebTxt));
    // Trigger 401 redirect check on spreadsheet export button
    const expView = await renderRoute({ hash: '#/start', force401OnExport: true });
    const xlsxBtn = expView.buttons().find((b) => expView.walkText(b).includes('Download Excel (.xlsx)'));
    assert.ok(xlsxBtn);
    await xlsxBtn.click();
    assert.strictEqual(expView.location.href, '/auth/login', 'expired OAuth session during file download must redirect to /auth/login');
    ok('All dashboard views render without null/undefined, disable 0-count scraper buttons, and redirect on 401 expiry');

    // Regression: Fetcher invokes headless JS fallback ONLY on empty static SPA shells, never on bot challenges
    const { Fetcher } = require('../src/lib/fetcher');
    let headlessCalls = 0;
    const spaFetcher = new Fetcher(
      { crawl: { userAgent: 'Bot/1.0', delayMs: 0, timeoutMs: 2000, cacheDays: 7, maxHtmlBytes: 1e6, maxPdfBytes: 1e6, headlessFallback: true } },
      {
        cacheDir: path.join(tmp, 'fetcher-cache'),
        dnsLookup: async () => [{ address: '93.184.216.34' }],
        fetch: async (u) => {
          if (u.endsWith('/robots.txt')) return { status: 404, headers: new Map(), body: null };
          const bodyHtml = u.includes('/challenge')
            ? '<html><body>Just a moment... cf-chl-token</body></html>'
            : '<html><body><div id="__next"></div><noscript>Enable JavaScript</noscript></body></html>';
          return {
            status: 200,
            url: u,
            headers: new Map([['content-type', 'text/html']]),
            body: (async function* () { yield Buffer.from(bodyHtml); })(),
          };
        },
        renderHtml: async () => {
          headlessCalls++;
          return '<html><body><main><h1>Upper School Tuition</h1><p>' + 'Tuition is $58,000 for 2026-27. '.repeat(25) + '</p></main></body></html>';
        },
      },
    );
    const spaRec = await spaFetcher.get('https://example.org/spa-tuition');
    assert.strictEqual(spaRec.ok, true);
    assert.strictEqual(spaRec.renderedHeadless, true);
    assert.strictEqual(headlessCalls, 1);
    const challengeRec = await spaFetcher.get('https://example.org/challenge');
    assert.strictEqual(challengeRec.blocked, true);
    assert.strictEqual(headlessCalls, 1, 'headless fallback must never run on anti-bot / captcha challenges');
    ok('Fetcher renders thin JS-shell pages with optional headless fallback and refuses bot challenges');

    // Regression: dashboard-data detects URL mismatches against sheet link & surfaces change summary
    const urlCheckDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urlchk-'));
    try {
      fs.mkdirSync(path.join(urlCheckDir, 'results'), { recursive: true });
      fs.writeFileSync(path.join(urlCheckDir, 'template.json'), JSON.stringify({ rows: [{ kind: 'field', key: 'tuition', label: 'Tuition:' }] }));
      fs.writeFileSync(path.join(urlCheckDir, 'schools.json'), JSON.stringify({
        importedAt: '2026-11-16T00:00:00Z',
        workbook: 'x.xlsx',
        schools: [{ id: 's1', name: 'New Site School', tier: 1, website: 'https://newsite.edu/', tabs: [] }],
      }));
      fs.writeFileSync(path.join(urlCheckDir, 'results', 's1.json'), JSON.stringify({
        id: 's1', name: 'New Site School', scrapedAt: '2026-11-10T00:00:00Z', start: 'https://oldsite.edu/',
        status: 'ok', counts: { found: 1 }, changes: [{ key: 'tuition', kind: 'changed', before: '$1', after: '$2' }], pages: [], fields: {},
      }));
      const { spawnSync } = require('child_process');
      const probe = spawnSync(
        process.execPath,
        ['-e', "const d = require('./src/lib/dashboard-data'); const o = d.overview(); const p = d.schoolPayload('s1'); if (!o.schools[0].urlChanged || !p.urlChanged || o.schools[0].changesSummary[0] !== 'Tuition') process.exit(2);"],
        { cwd: ROOT, env: { ...process.env, DATA_DIR: urlCheckDir } },
      );
      assert.strictEqual(probe.status, 0, 'dashboard-data must flag changed sheet website URLs and include change labels');
      ok('dashboard-data flags changed sheet website URLs and surfaces change summary labels');
    } finally {
      fs.rmSync(urlCheckDir, { recursive: true, force: true });
    }

    // Regression: DigitalOcean deployment bundle validates HTTPS proxy, volume persistence, Chromium container flags & auth requirements
    const doDir = path.join(ROOT, 'deploy', 'digitalocean');
    const compose = fs.readFileSync(path.join(doDir, 'docker-compose.yml'), 'utf8');
    const caddy = fs.readFileSync(path.join(doDir, 'Caddyfile'), 'utf8');
    const envEx = fs.readFileSync(path.join(doDir, 'env.example'), 'utf8');
    const setupSh = fs.readFileSync(path.join(doDir, 'setup-droplet.sh'), 'utf8');
    const doGuide = fs.readFileSync(path.join(ROOT, 'docs', 'DIGITALOCEAN-SETUP.md'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    assert.ok(dockerfile.includes('INSTALL_CHROMIUM') && dockerfile.includes('/healthz'));
    assert.ok(compose.includes('school_data:/data') && compose.includes('PUBLIC_URL: "https://${APP_DOMAIN') && compose.includes('GOOGLE_CLIENT_ID:') && compose.includes('expose:') && !compose.includes('- "8080:8080"'));
    assert.ok(caddy.includes('{$APP_DOMAIN}') && caddy.includes('reverse_proxy app:8080') && caddy.includes('flush_interval -1'));
    assert.ok(envEx.includes('APP_DOMAIN=') && envEx.includes('GOOGLE_CLIENT_ID=') && envEx.includes('ANTHROPIC_API_KEY=') && envEx.includes('ASK_MONTHLY_CAP_USD='));
    assert.ok(setupSh.startsWith('#!/usr/bin/env bash\n') && !setupSh.includes('\r\n'), 'setup-droplet.sh must use LF endings');
    assert.ok(doGuide.includes('DuckDNS') && doGuide.includes('/auth/callback'));
    ok('DigitalOcean bundle configures Caddy HTTPS, isolated /data volume, OAuth env vars, and LF scripts');

    // Regression: parallelized crawlSite respects per-host Fetcher serialization & maxPagesPerSite cap, and config supports higher parallelSites
    const { crawlSite } = require('../src/lib/crawl');
    const { loadConfig } = require('../src/lib/util');
    assert.strictEqual(loadConfig().crawl.parallelSites, 12);
    const savedEnvPar = process.env.CRAWL_PARALLEL_SITES;
    process.env.CRAWL_PARALLEL_SITES = '20';
    try { assert.strictEqual(loadConfig().crawl.parallelSites, 20); } finally {
      if (savedEnvPar === undefined) delete process.env.CRAWL_PARALLEL_SITES; else process.env.CRAWL_PARALLEL_SITES = savedEnvPar;
    }
    let activeOnAlpha = 0, maxActiveOnAlpha = 0;
    const pipeFetcher = new Fetcher(
      { crawl: { userAgent: 'Bot/1.0', delayMs: 25, timeoutMs: 3000, cacheDays: 7, maxHtmlBytes: 1e6, maxPdfBytes: 1e6, maxPagesPerSite: 4, maxPdfsPerSite: 2, headlessFallback: false } },
      {
        cacheDir: path.join(tmp, 'pipe-cache'),
        dnsLookup: async () => [{ address: '93.184.216.34' }],
        fetch: async (u) => {
          const parsedU = new URL(u);
          if (parsedU.pathname === '/robots.txt') return { status: 404, headers: new Map(), body: null };
          if (parsedU.hostname === 'alpha.edu') {
            activeOnAlpha++;
            if (activeOnAlpha > maxActiveOnAlpha) maxActiveOnAlpha = activeOnAlpha;
          }
          await new Promise((r) => setTimeout(r, 15));
          if (parsedU.hostname === 'alpha.edu') activeOnAlpha--;
          const links = ['admissions', 'tuition', 'about', 'visit', 'academics', 'contact'].map((k) => `<a href="https://alpha.edu/${k}">${k}</a>`).join(' ');
          const html = `<html><body><main><h1>Alpha Academy ${parsedU.pathname}</h1><p>${'Tuition is $42,000 and financial aid is available for grades 9-12. '.repeat(25)}</p>${links}</main></body></html>`;
          return { status: 200, url: u, headers: new Map([['content-type', 'text/html']]), body: (async function* () { yield Buffer.from(html); })() };
        },
      },
    );
    const crawlRes = await crawlSite('https://alpha.edu/', pipeFetcher, { crawl: { maxPagesPerSite: 4, maxPdfsPerSite: 2 } });
    assert.strictEqual(crawlRes.status, 'ok');
    assert.strictEqual(crawlRes.pages.length, 4, 'concurrent pick workers must never exceed maxPagesPerSite');
    assert.strictEqual(maxActiveOnAlpha, 1, 'same-host requests must stay strictly serialized (max 1 in-flight)');
    ok('crawlSite pipelines page fetches within maxPagesPerSite while keeping per-host concurrency at 1');

    // Regression (ACS Cobham): pages are recorded in the order they were PICKED, never the order they finished downloading,
    // so the same website gives the same page order (and the same answers) on every check.
    const slowFirstFetch = (delays) => new Fetcher(
      { crawl: { userAgent: 'Bot/1.0', delayMs: 1, timeoutMs: 3000, cacheDays: 7, maxHtmlBytes: 1e6, maxPdfBytes: 1e6, maxPagesPerSite: 12, maxPdfsPerSite: 2, headlessFallback: false } },
      {
        cacheDir: path.join(tmp, 'order-cache-' + Math.random().toString(36).slice(2)),
        dnsLookup: async () => [{ address: '93.184.216.34' }],
        fetch: async (u) => {
          const p = new URL(u).pathname;
          if (p === '/robots.txt') return { status: 404, headers: new Map(), body: null };
          await new Promise((r) => setTimeout(r, delays[p] || 1));   // each run makes different pages finish first
          const links = ['admissions', 'tuition', 'about', 'visit', 'academics', 'contact', 'faculty'].map((k) => `<a href="https://beta.edu/${k}">${k}</a>`).join(' ');
          const html = `<html><body><main><h1>Beta School ${p}</h1><p>${'Tuition is $42,000 and financial aid is available for grades 9-12. '.repeat(25)}</p>${links}</main></body></html>`;
          return { status: 200, url: u, headers: new Map([['content-type', 'text/html']]), body: (async function* () { yield Buffer.from(html); })() };
        },
      },
    );
    const orderOf = async (delays) => (await crawlSite('https://beta.edu/', slowFirstFetch(delays), { crawl: { maxPagesPerSite: 12, maxPdfsPerSite: 2 } })).pages.map((pg) => pg.finalUrl);
    const orderA = await orderOf({ '/admissions': 60, '/tuition': 1, '/about': 30, '/visit': 1 });
    const orderB = await orderOf({ '/admissions': 1, '/tuition': 60, '/about': 1, '/visit': 40, '/academics': 50 });
    assert.ok(orderA.length >= 5, 'the test site gave several pages');
    assert.deepStrictEqual(orderA, orderB, 'page order must not depend on which download finished first');
    ok('crawlSite keeps a fixed page order however the downloads finish, so the same website gives the same answers every time');

    // Regression: parseHtml does not let Webflow/state wrappers (.menu-target, .has-nav) poison mainChars, and <main> resets zone
    const { parseHtml, PARSER_VERSION } = require('../src/lib/html');
    const wrapperHtml = `<html><body>
      <div class="menu-target"><nav class="site-nav"><a href="/x">Menu link</a></nav>
        <div class="g-contentbody"><h1>Tuition &amp; Fees</h1><p>2026-27 Upper School Tuition is $54,000 for grades 9-12.</p></div>
      </div>
      <div class="has-nav"><div class="nav-drawer"><main role="main"><p>Admissions open October 1.</p></main></div></div>
      <footer class="site-footer"><p>Copyright 2026</p></footer>
    </body></html>`;
    const wp = parseHtml(wrapperHtml, 'https://example.edu/tuition');
    assert.ok(wp.mainChars > 80 && wp.blocks.some((b) => b.z === 'main' && b.text.includes('$54,000')));
    assert.ok(wp.blocks.some((b) => b.z === 'main' && b.text.includes('Admissions open October 1.')));
    assert.ok(wp.blocks.some((b) => b.z === 'nav' && b.text.includes('Menu link')));
    assert.ok(wp.blocks.some((b) => b.z === 'footer' && b.text.includes('Copyright 2026')));
    ok('parseHtml preserves main content inside .menu-target and nested <main> wrappers');

    // Regression: Fetcher retries HTTP 429 with adaptive hostDelay and self-heals poisoned 0-mainChars/transient cache entries
    const rlCacheDir = path.join(tmp, 'rl-cache');
    const { writeJson } = require('../src/lib/util');
    let rlHits = 0;
    const rlFetcher = new Fetcher(
      { crawl: { userAgent: 'Bot/1.0', delayMs: 25, timeoutMs: 3000, cacheDays: 7, maxHtmlBytes: 1e6, maxPdfBytes: 1e6, headlessFallback: false } },
      {
        cacheDir: rlCacheDir,
        dnsLookup: async () => [{ address: '93.184.216.34' }],
        fetch: async (u) => {
          if (u.endsWith('/robots.txt')) return { status: 404, headers: new Map(), body: null };
          rlHits++;
          if (rlHits === 1) return { status: 429, url: u, headers: new Map([['retry-after', '0']]), body: null };
          return { status: 200, url: u, headers: new Map([['content-type', 'text/html']]), body: (async function* () { yield Buffer.from('<html><body><main><p>Tuition $48,000.</p></main></body></html>'); })() };
        },
      },
    );
    const healUrl = 'https://rate-limit.edu/tuition';
    // Plant a poisoned 0-mainChars cache record from earlier wrapper bug
    writeJson(rlFetcher.cacheFile(healUrl), {
      url: healUrl, finalUrl: healUrl, fetchedAt: new Date().toISOString(), parser: PARSER_VERSION,
      ok: true, kind: 'html', mainChars: 0, blocks: Array.from({ length: 20 }, (_, i) => ({ k: 'p', z: 'nav', text: 'item ' + i })),
    });
    const rlRes = await rlFetcher.get(healUrl);
    assert.strictEqual(rlRes.ok, true);
    assert.ok(!rlRes.fromCache && rlHits === 2, 'must invalidate poisoned 0-mainChars cache and recover from 429 retry');
    assert.ok((rlFetcher.hostDelay.get('rate-limit.edu') || 0) >= 2500, 'HTTP 429 must raise adaptive per-host delay');
    ok('Fetcher heals poisoned 0-mainChars cache entries and adapts cooldown delay after HTTP 429');

    console.log(`\n${passed} checks passed.`);
  } finally {
    if (srv) srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('\nFAILED:', e.message, '\n', (e.stack || '').split('\n').slice(1, 5).join('\n'));
  process.exit(1);
});
