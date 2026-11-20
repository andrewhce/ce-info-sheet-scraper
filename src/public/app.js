(() => {
  'use strict';
  // Dashboard front end. Everything scraped from the web is inserted as plain text,
  // never as HTML, and only http(s) links are made clickable.
  const app = document.getElementById('app');
  const pill = document.getElementById('jobpill');
  // The read-only copy (made by build-static.js) has no server: it reads saved JSON files and has no Run controls.
  const STATIC = document.body.dataset.mode === 'static';
  const S = { ov: null, q: '', tier: '', status: '', sort: 'name', dir: 1, job: null, log: [], since: 0, verdict: 'all', view: '', selected: new Set(), runPick: null };

  // ---------------------------------------------------------------- helpers ---
  function appendKids(target, kids) {
    for (const c of kids) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) appendKids(target, c);
      else target.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
  }
  function setKids(el, ...kids) {
    const frag = document.createDocumentFragment();
    appendKids(frag, kids);
    el.replaceChildren(frag);
  }
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    if (kids.length) appendKids(el, kids);
    return el;
  }
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  function shortUrl(u) {
    try {
      const x = new URL(u);
      let p = x.pathname;
      try { p = decodeURIComponent(p); } catch { /* keep */ }
      if (p.length > 48) p = p.slice(0, 24) + '…' + p.slice(-20);
      return x.hostname.replace(/^www\./, '') + (p === '/' ? '' : p);
    } catch { return String(u); }
  }
  function ext(url, text, title) {
    const u = safeUrl(url);
    if (!u) return document.createTextNode(text || '');
    return h('a', { href: u, target: '_blank', rel: 'noopener noreferrer', title: title || null }, text || shortUrl(u));
  }
  const jsonCache = new Map();
  async function getJson(file) {
    if (!jsonCache.has(file)) {
      jsonCache.set(file, fetch(file).then((r) => { if (!r.ok) throw new Error(r.status === 404 ? 'Not found in this copy.' : 'Could not load ' + file); return r.json(); }));
    }
    return jsonCache.get(file);
  }
  /** Read-only copy: the same answers the live server gives, taken from files saved by build-static.js. */
  async function staticApi(path, body) {
    if (body) throw new Error('This is a read-only copy. Websites are checked on the computer that holds the sheet.');
    const u = new URL(path, 'http://x/');
    if (u.pathname === '/api/overview') return getJson('data/overview.json');
    if (u.pathname === '/api/job') return { running: false };
    if (u.pathname === '/api/school') {
      const all = await getJson('data/school/' + encodeURIComponent(u.searchParams.get('id') || '') + '.json');
      return all[Math.max(0, Math.min(Number(u.searchParams.get('tab')) || 0, all.length - 1))];
    }
    if (u.pathname === '/api/code') {
      const all = await getJson('data/code.json');
      const file = u.searchParams.get('file');
      if (!file) return { files: all.files, config: all.config };
      if (all.contents[file] == null) throw new Error('Not found in this copy.');
      return { file, content: all.contents[file] };
    }
    throw new Error('Not available in the read-only copy.');
  }
  async function checkedFetch(path, opts, fallbackErr) {
    const r = await fetch(path, opts);
    if (r.ok) return r;
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.signIn) { location.href = j.signIn; throw new Error('Please sign in again.'); }   // the sign-in has expired
    throw new Error(j.error || fallbackErr || 'Request failed (' + r.status + ')');
  }
  async function api(path, body) {
    if (STATIC) return staticApi(path, body);
    const r = await checkedFetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' }, body: JSON.stringify(body) } : undefined);
    return r.json().catch(() => ({}));
  }
  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - Date.parse(iso)) / 1000;
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 86400 * 14) return Math.round(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  async function copyText(text, btn) {
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch { /* fallback below */ }
    if (!ok) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    if (btn) {
      const prev = btn.dataset.orig || btn.textContent;
      btn.dataset.orig = prev;
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      if (ok) btn.classList.add('copied');
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => { btn.textContent = prev; btn.classList.remove('copied'); }, 1500);
    }
    return ok;
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---- things that take a while keep going when you open another page ----
  // Each one shows as a small card at the bottom right of every page and says when it is done. Finishing never
  // re-draws a page you moved to, except to fill in what that page was waiting for (see refreshIfOn).
  const TASKS = new Map();   // id -> { id, state: 'running' | 'done' | 'failed', label, title, message, link, linkText, hideOnView }
  let taskSeq = 0;
  function dismissTask(id) { TASKS.delete(id); drawTasks(); }
  function drawTasks() {
    const box = document.getElementById('tasks');
    if (!box) return;
    setKids(box, [...TASKS.values()].filter((t) => !(t.hideOnView && t.hideOnView === S.view)).map((t) => h('div', { class: 'taskcard ' + t.state, role: t.state === 'failed' ? 'alert' : 'status' },
      h('span', { class: 'taskicon' + (t.state === 'running' ? ' spin' : ''), 'aria-hidden': 'true' }, t.state === 'done' ? '✓' : t.state === 'failed' ? '!' : ''),
      h('div', { class: 'tasktext' },
        h('b', null, t.state === 'running' ? t.label : t.title),
        t.message ? h('span', null, t.message) : null,
        t.link ? h('a', { href: t.link, target: /^https?:/i.test(t.link) ? '_blank' : null, rel: /^https?:/i.test(t.link) ? 'noopener noreferrer' : null, onclick: () => { if (t.state !== 'running') dismissTask(t.id); } }, t.linkText || 'Open') : null),
      t.state !== 'running' ? h('button', { type: 'button', class: 'taskx', 'aria-label': 'Dismiss this message', title: 'Dismiss', onclick: () => dismissTask(t.id) }, '✕') : null)));
  }
  const taskRunning = (id) => { const t = TASKS.get(id); return !!(t && t.state === 'running'); };
  function startTask(id, label, extra) { TASKS.set(id, { id, state: 'running', label, ...(extra || {}) }); drawTasks(); }
  function endTask(id, { title, message, link, linkText, failed } = {}) {
    const t = { ...(TASKS.get(id) || {}), id, state: failed ? 'failed' : 'done', title: title || (failed ? 'That did not work' : 'Done'), message: message || '', link: link || null, linkText: linkText || null };
    TASKS.set(id, t); drawTasks();
    if (!failed) setTimeout(() => { if (TASKS.get(id) === t) dismissTask(id); }, 15000);   // good news fades by itself; a problem stays until dismissed
  }
  /** Re-draws the page the person is on, but only if it is one of `views` (the pages that show what just finished). */
  function refreshIfOn(...views) {
    if (!views.includes(S.view)) return;
    if (S.view !== 'start' && document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;   // never interrupt typing
    const y = window.scrollY;
    const again = S.view === 'schools' ? viewSchools() : S.view === 'start' ? viewStart() : S.view === 'review' ? viewReview() : S.view === 'run' ? viewRun() : null;
    Promise.resolve(again).then(() => window.scrollTo(0, y));
  }

  async function downloadSpreadsheet(params) {
    const id = 'file-' + (++taskSeq);   // each file gets its own card
    const what = params.format === 'csv' ? 'the CSV file' : 'the Excel file';
    startTask(id, `Making ${what}…`);
    try {
      const q = new URLSearchParams(params).toString();
      const r = await checkedFetch('/api/export-spreadsheet?' + q, undefined, 'Could not create spreadsheet.');
      const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || ('school-info.' + (params.format || 'xlsx'));
      triggerBlobDownload(await r.blob(), name);
      endTask(id, { title: `Saved ${name}`, message: 'It is in your Downloads folder.' });
      return { name, count: Number(r.headers.get('X-Export-Count')) || 0 };
    } catch (e) { dismissTask(id); throw e; }   // the button that was pressed shows the problem
  }

  function downloadStaticCsv(d) {
    const esc = (v) => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    };
    const rows = [['Section', 'Question', 'What Your Sheet Says', 'What the Website Says', 'How They Compare', 'How Sure', 'Page It Came From', 'Words From the Page']];
    for (const row of d.rows) {
      if (row.kind !== 'field') continue;
      const sc = row.scraped;
      const has = sc && sc.status === 'found';
      const sheetTxt = (row.sheet || []).map((c) => (c.text || c.link || '').trim()).filter(Boolean).join(' | ');
      const src = has ? ((sc.sources || []).find((x) => safeUrl(x.url)) || {}).url || '' : '';
      rows.push([row.section || '', row.label.replace(/:$/, ''), sheetTxt, has ? sc.value : '', (VERDICT[row.verdict] || [row.verdict])[0], has ? (CONF_LABEL[sc.confidence] || sc.confidence) : '', src, has && sc.snippet ? sc.snippet : '']);
    }
    const csv = '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
    triggerBlobDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `school-info-${d.school.id}.csv`);
  }

  const STATUS = {
    'not-scraped': ['Not checked yet', ''], ok: ['Checked', 'ok'], blocked: ['Website blocked us', 'warn'], error: ['Website would not open', 'bad'],
    thin: ['Nothing readable', 'warn'], robots: ['Website asks not to be read', 'warn'], 'no-website': ['No website link', 'bad'],
  };
  const STATUS_HELP = {
    blocked: 'This website stops automatic readers, and the dashboard respects that. You can still use it: open the school’s pages in your own browser, save them, and add the files on this school’s page.',
    thin: 'This website shows its content in a way the dashboard cannot read. Open the school’s website yourself to check.',
    robots: 'This website asks automatic programs not to read it, and the dashboard respects that. Open the school’s website yourself to check.',
    error: 'The dashboard could not open this website. Check that the website link in your sheet still works.',
    'no-website': 'There is no website link for this school in your sheet. Add one there, then load the sheet again.',
  };
  const VERDICT = {
    fills: ['Website can fill your blank', 'info'], match: ['Same as your sheet', 'ok'], differs: ['Different from your sheet', 'warn'],
    both: ['Both have an answer', ''], 'sheet-only': ['Only your sheet has it', ''], none: ['Not found on the website', ''], manual: ['Not on websites: fill in by hand', ''],
  };
  const CONF_LABEL = {
    high: 'Exact match',
    medium: 'Probable match',
    low: 'Please double-check',
  };
  const chip = (pair, title) => h('span', { class: 'chip ' + (pair[1] || ''), title: title || null }, pair[0]);

  /** A small "what does this mean?" link to a section of the Help page. */
  const helpLink = (section, text) => h('a', { class: 'helplink', href: '#/help/' + section }, text || 'What does this mean?');

  // The colours in the files this dashboard makes. The hex values are the real cell colours used by
  // google-sheet/Code.gs (the Google Sheet file) and src/lib/spreadsheet-export.js (the Excel file).
  const COLOUR_GROUPS = [
    { title: 'In your Google Sheet, after School Info → Load export file…', rows: [
      ['#fff2cc', 'Yellow', 'The cell was blank, and the answer was filled in from the school’s website. Point at the cell to read its note: which page the answer came from and how sure the dashboard was. (A small dark triangle in the cell’s corner means it has a note.)'],
      ['#fce5cd', 'Orange', 'The cell already had a different answer, so nothing was overwritten. The website’s answer is in the cell’s note, so you can decide which one is right.'],
      [null, 'No colour', 'Your sheet already says the same thing, or the website had nothing to add. Nothing was changed.'],
    ], foot: 'A cell that already has a colour of its own keeps that colour, but it still gets the note. Every load is also listed on the “Export Log” tab of your sheet.' },
    { title: 'In the Excel file (the “How They Compare” column)', rows: [
      ['#e2eefb', 'Blue', 'Your sheet is empty here and the website has an answer, so it can fill the blank.'],
      ['#fce5cd', 'Orange', 'The website and your sheet say different things. Open the school’s page to see which is right.'],
      ['#e3f3ea', 'Green', 'The website and your sheet say the same thing.'],
      [null, 'No colour', 'Anything else: both have an answer but in different words, only your sheet has one, or nobody has one.'],
    ] },
  ];
  /** The colour key. `compact` is the short version shown next to the buttons that make the files. */
  function colourKey(compact) {
    return h('div', { class: 'colourkey' }, COLOUR_GROUPS.map((g) => h('div', { class: 'ckgroup' },
      h('h3', null, g.title),
      h('ul', null, g.rows.map(([hex, name, text]) => {
        const sw = h('span', { class: 'swatch' + (hex ? '' : ' none'), 'aria-hidden': 'true' });
        if (hex) sw.style.background = hex;   // set from script: the page's security policy blocks inline style attributes
        return h('li', null, sw, h('span', null, h('b', null, name + ': '), compact ? text.split('. ')[0].replace(/\.$/, '') + '.' : text));
      })),
      !compact && g.foot ? h('p', { class: 'muted small' }, g.foot) : null)),
    compact ? h('p', { class: 'small' }, helpLink('colours', 'Full explanation on the Help page')) : null);
  }
  /** The colour key folded away under a short question, for the pages that make these files. */
  const colourDetails = () => h('details', { class: 'guide colourdetails' },
    h('summary', null, 'What do the colours in the Google Sheet and Excel files mean?'), colourKey(true),
    h('p', { class: 'small' }, 'The yellow and orange colours only appear after the Google Sheet menu is set up. ', h('a', { href: '#/sheet-setup' }, 'Set up the Google Sheet menu, step by step'), '.'));

  /** Tells the person the one thing to do next, from what has been done so far. */
  function nextStepCard() {
    const ov = S.ov;
    if (STATIC || !ov) return null;
    const running = !!(S.job && S.job.running);
    const scraped = ov.ready ? ov.schools.filter((s) => s.status === 'ok') : [];
    const notChecked = ov.ready ? ov.schools.filter((s) => s.status === 'not-scraped').length : 0;
    const look = scraped.filter((s) => !s.wrongSite).reduce((n, s) => n + (s.look || 0), 0);   // the same count the To check list shows (it leaves out wrong-website schools)
    let title, text, btn;
    if (running) { title = 'Checking websites right now'; text = 'You can keep looking around while it works. Schools fill in as they finish.'; btn = h('a', { class: 'btn primary', href: '#/run' }, 'See the progress'); }
    else if (!ov.ready) { title = 'Next step: load your school sheet'; text = 'Download your Google Sheet as an Excel file (File → Download → Microsoft Excel), then choose it in Step 1 below.'; btn = h('a', { class: 'btn primary', href: '#/start' }, 'Go to Step 1'); }
    else if (!scraped.length) { title = 'Next step: check your first schools'; text = 'Choose a group of schools and press Start checking. The dashboard will read their websites for you.'; btn = h('a', { class: 'btn primary', href: '#/run' }, 'Choose schools to check'); }
    else if (look > 0) { title = `Next step: look at ${look} answer${look === 1 ? '' : 's'} the dashboard is not sure about`; text = 'They are listed least certain first. Open a school, press ✓ Right or ✗ Wrong, and each one drops off the list.'; btn = h('a', { class: 'btn primary', href: '#/review' }, 'Open the list'); }
    else if (notChecked > 0) { title = `Next step: ${notChecked} school${notChecked === 1 ? ' is' : 's are'} not checked yet`; text = 'Pick “Schools not checked yet” and press Start checking.'; btn = h('a', { class: 'btn primary', href: '#/run' }, 'Check them now'); }
    else { title = 'All done: every school is checked and nothing needs a look'; text = 'Download your results as an Excel file, or send them to your Google Sheet.'; btn = h('a', { class: 'btn primary', href: '#/start' }, 'Go to the downloads'); }
    return h('div', { class: 'nextstep', role: 'region', 'aria-label': 'What to do next' }, h('div', { class: 'ns-text' }, h('b', null, title), h('span', null, text)), btn);
  }

  /** Long text is clamped with a "Show all" toggle. */
  const pending = [];
  function clamped(text, extraBtn) {
    const val = h('div', { class: 'val clamp' }, text);
    const btn = h('button', { class: 'btn link small', type: 'button', onclick: () => {
      const open = val.classList.toggle('clamp');
      btn.textContent = open ? 'Show all' : 'Show less';
    } }, 'Show all');
    pending.push([val, btn]);
    if (extraBtn) return [h('div', { class: 'valhead' }, val, extraBtn), btn];
    return [val, btn];
  }
  function settleClamps() {
    requestAnimationFrame(() => {
      for (const [val, btn] of pending.splice(0)) {
        if (val.scrollHeight <= val.clientHeight + 2) { val.classList.remove('clamp'); btn.remove(); }
      }
    });
  }

  let lastOverview = 0;
  async function loadOverview() { S.ov = await api('/api/overview'); lastOverview = Date.now(); }

  async function startRun(body) {
    try {
      await api('/api/run', body);
      S.log = [];
      location.hash = '#/run';
      poll(true);
    } catch (e) { alert(e.message); }
  }

  // ----------------------------------------------------------- schools view ---
  function filtered() {
    const q = S.q.trim().toLowerCase();
    const list = S.ov.schools.filter((s) => {
      if (q && !(s.name + ' ' + (s.region || '')).toLowerCase().includes(q)) return false;
      if (S.tier && String(s.tier) !== S.tier) return false;
      if (S.status === 'problem') return !['ok', 'not-scraped'].includes(s.status) || !!s.wrongSite;
      if (S.status === 'updated') return s.changesCount > 0;
      if (S.status === 'fills') return s.fills > 0;
      if (S.status === 'differs') return s.differs > 0;
      if (S.status) return s.status === S.status;
      return true;
    });
    const k = S.sort;
    const val = (s) => (k === 'name' ? s.name.toLowerCase() : k === 'status' ? s.status : k === 'scrapedAt' || k === 'exportedAt' ? (s[k] || '') : (s[k] == null ? -1 : s[k]));
    return list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * S.dir; });
  }

  function viewSchools() {
    const ov = S.ov;
    if (!ov.ready && taskRunning('workbook')) {   // the sheet is being read: this page fills in by itself when it is done
      app.replaceChildren(h('div', { class: 'panel' }, h('h2', null, 'Your school sheet is loading…'),
        h('p', null, 'This takes about 30 seconds. You can stay here: the school list appears by itself as soon as it is ready.')));
      return;
    }
    if (!ov.ready) {
      app.replaceChildren(h('div', { class: 'panel' }, h('h2', null, 'No school list yet'),
        h('p', null, 'Load your School Information Sheet first on the Start here page.'),
        h('a', { class: 'btn primary', href: '#/start' }, 'Go to Start here')));
      return;
    }
    const scraped = ov.schools.filter((s) => s.status === 'ok');
    const notScraped = ov.schools.filter((s) => s.status === 'not-scraped');
    const needsCheck = ov.schools.filter((s) => !['ok', 'not-scraped'].includes(s.status) || !!s.wrongSite);
    const updated = scraped.filter((s) => s.changesCount > 0);
    const withFills = scraped.filter((s) => s.fills > 0);
    const withDiffs = scraped.filter((s) => s.differs > 0);
    const sum = (k) => scraped.reduce((n, s) => n + (s[k] || 0), 0);
    const tbody = h('tbody');
    const count = h('span', { class: 'muted small' });
    const statusSel = h('select', { 'aria-label': 'Status', onchange: (e) => { S.status = e.target.value; draw(); } },
      [['', 'All schools'], ['ok', 'Checked'], ['updated', 'Changed on their website'], ['fills', 'Website can fill a blank'], ['differs', 'Different from your sheet'],
        ['problem', 'Needs a person to look'], ['not-scraped', 'Not checked yet']].map(([v, t]) => h('option', { value: v }, t)));
    statusSel.value = S.status;

    const statBtns = [];
    const statBtn = (filterVal, n, label, title) => {
      const btn = h('button', { type: 'button', class: 'stat-btn', 'aria-pressed': String(S.status === filterVal), title: title || 'Click to filter the table below',
        onclick: () => { S.status = S.status === filterVal && filterVal !== '' ? '' : filterVal; statusSel.value = S.status; draw(); } },
      h('b', null, n), h('span', null, label));
      statBtns.push([filterVal, btn]);
      return btn;
    };

    const scrapeBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
      const ids = filtered().map((s) => s.id);
      if (!ids.length) return;
      if (ids.length > 400) return alert('Narrow the list to 400 schools or fewer, or use the Check websites page.');
      if (confirm(`Check the website${ids.length === 1 ? '' : 's'} of the ${ids.length} school${ids.length === 1 ? '' : 's'} shown in the list now?`)) startRun({ scope: 'schools', ids });
    } });
    const xlsxBtn = STATIC ? null : h('button', { class: 'btn', type: 'button', title: 'Download an Excel workbook for the currently shown schools', onclick: async () => {
      const list = filtered();
      if (!list.length) return;
      const isAll = !S.q && !S.tier && !S.status;
      xlsxBtn.disabled = true;
      try {
        await downloadSpreadsheet(isAll ? { all: '1', format: 'xlsx' } : { ids: list.map((s) => s.id).join(','), format: 'xlsx' });
      } catch (e) { alert(e.message); }
      xlsxBtn.disabled = false;
    } }, 'Download Excel');
    const bulkBar = h('div', { class: 'bulkbar', hidden: true });
    const cols = [
      ...(STATIC ? [] : [['_chk', '', 'chkcol']]),
      ['name', 'School'], ['tier', 'Tier'], ['status', 'Status'], ['found', 'Answers found', 'num'], ['fills', 'Blanks it can fill', 'num'],
      ['differs', 'Different from sheet', 'num'], ['look', 'Needs checking', 'num'], ['scrapedAt', 'Last checked'],
    ];
    const headRow = h('tr');
    const validIds = new Set(ov.schools.map((s) => s.id));
    for (const sid of [...S.selected]) if (!validIds.has(sid)) S.selected.delete(sid);

    const drawBulk = (list) => {
      if (STATIC || !S.selected.size) { bulkBar.hidden = true; return; }
      const ids = [...S.selected];
      const running = !!(S.job && S.job.running);
      const mkBtn = (label, primary, fn) => {
        const b = h('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button', onclick: () => fn(b) }, label);
        return b;
      };
      const xlB = mkBtn(`Excel (${ids.length})`, true, async (b) => {
        b.disabled = true;
        try { await downloadSpreadsheet({ ids: ids.join(','), format: 'xlsx' }); } catch (e) { alert(e.message); }
        b.disabled = false;
      });
      const csvB = mkBtn('CSV', false, async (b) => {
        b.disabled = true;
        try { await downloadSpreadsheet({ ids: ids.join(','), format: 'csv' }); } catch (e) { alert(e.message); }
        b.disabled = false;
      });
      const scrapeSelB = h('button', { class: 'btn', type: 'button', disabled: running || ids.length > 400, onclick: () => {
        startRun({ scope: 'schools', ids });   // the button itself is the explicit start, so there is no second prompt
      } }, `Check ${ids.length} website${ids.length === 1 ? '' : 's'}`);
      const clearB = h('button', { class: 'btn link small', type: 'button', onclick: () => { S.selected.clear(); draw(); } }, 'Clear selection');
      setKids(bulkBar, `${ids.length} school${ids.length === 1 ? '' : 's'} selected`, h('span', { class: 'spacer' }), xlB, csvB, scrapeSelB, clearB);
      bulkBar.hidden = false;
    };

    const draw = () => {
      for (const [v, b] of statBtns) b.setAttribute('aria-pressed', String(S.status === v));
      const list = filtered();
      drawBulk(list);
      const allVisChecked = !STATIC && list.length > 0 && list.every((s) => S.selected.has(s.id));
      setKids(headRow, ...cols.map(([k, label, cls]) => {
        if (k === '_chk') {
          const allChk = h('input', {
            type: 'checkbox', checked: allVisChecked, 'aria-label': 'Select all shown schools',
            onchange: (e) => {
              for (const s of list) { if (e.target.checked) S.selected.add(s.id); else S.selected.delete(s.id); }
              draw();
            },
          });
          return h('th', { class: cls }, allChk);
        }
        return h('th', { class: cls || null, 'aria-sort': k && S.sort === k ? (S.dir > 0 ? 'ascending' : 'descending') : null },
          k ? h('button', { type: 'button', onclick: () => { if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === 'name' || k === 'tier' || k === 'status' ? 1 : -1; } draw(); } }, label) : label);
      }));
      count.textContent = `${list.length} of ${ov.schools.length} schools`;
      scrapeBtn.textContent = `Check these ${list.length} website${list.length === 1 ? '' : 's'}`;
      scrapeBtn.disabled = !list.length || !!(S.job && S.job.running);
      if (xlsxBtn) xlsxBtn.disabled = !list.length || !scraped.length;
      if (!list.length) { setKids(tbody, h('tr', null, h('td', { colspan: cols.length, class: 'empty' }, 'No schools match these filters.'))); return; }
      setKids(tbody, ...list.map((s) => {
        const href = '#/school/' + encodeURIComponent(s.id);
        const total = Math.max(1, (Number(ov.fieldCount) || 0) - 2);
        const found = Number(s.found) || 0;
        const tip = [s.detail, STATUS_HELP[s.status]].filter(Boolean).join(' — ');
        const chSummary = Array.isArray(s.changesSummary) && s.changesSummary.length ? s.changesSummary.join(', ') + (s.changesCount > s.changesSummary.length ? ', …' : '') : '';
        const chkCell = STATIC ? null : h('td', { class: 'chkcol', onclick: (e) => e.stopPropagation() },
          h('input', {
            type: 'checkbox', checked: S.selected.has(s.id), 'aria-label': `Select ${s.name}`,
            onchange: (e) => { if (e.target.checked) S.selected.add(s.id); else S.selected.delete(s.id); drawBulk(list); headRow.querySelector('input[type=checkbox]').checked = list.length > 0 && list.every((x) => S.selected.has(x.id)); },
          }));
        return h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('a, input, button')) location.hash = href; } },
          chkCell,
          h('td', { class: 'name' }, h('a', { href }, s.name), h('span', { class: 'sub' }, s.region || ''),
            h('span', { class: 'sub' }, s.website ? ['Website: ', ext(s.website, shortUrl(s.website).split('/')[0])] : h('span', { class: 'muted' }, 'No website link'),
              s.urlChanged ? [' ', h('span', { class: 'chip warn', title: 'The website link in your sheet changed since this school was last checked, so check it again.' }, 'link changed')] : null,
              s.wrongSite ? [' ', h('span', { class: 'chip warn', title: 'This website never mentions the school’s name, so the link in your sheet may point to the wrong school. Please check it.' }, 'check link?')] : null),
            !STATIC && s.exportedAt ? h('span', { class: 'sub', title: 'The last time this school’s answers were sent to your Google Sheet' }, 'Sent to Google Sheet ' + ago(s.exportedAt)) : null),
          h('td', null, s.tier == null ? '' : s.tier),
          h('td', null, chip(STATUS[s.status] || [s.status, ''], tip || null),
            s.changesCount > 0 ? [' ', h('span', { class: 'chip info', title: `${s.changesCount} answer${s.changesCount === 1 ? '' : 's'} on the school’s website changed since the last check: ${chSummary}` }, `${s.changesCount} changed`)] : null,
            chSummary ? h('span', { class: 'sub' }, chSummary) : null),
          h('td', { class: 'num' }, s.status === 'ok' ? [h('span', { class: 'meter' }, (() => { const i = h('i'); i.style.width = Math.min(100, Math.max(0, Math.round((found / total) * 100))) + '%'; return i; })()), `${found} / ${total}`] : ''),
          h('td', { class: 'num' }, s.status === 'ok' ? (s.fills ?? 0) : ''),
          h('td', { class: 'num' }, s.status === 'ok' ? (s.differs ?? 0) : ''),
          h('td', { class: 'num' }, s.status === 'ok' && s.look != null
            ? h('span', { class: 'chip ' + (s.look ? (s.doubtful ? 'bad' : 'warn') : 'ok'), title: `Main facts: ${s.ready} safe to use, ${s.check} need a quick look, ${s.doubtful} need checking` }, s.look ? String(s.look) : 'all safe') : ''),
          h('td', { class: 'small muted' }, ago(s.scrapedAt)));
      }));
    };
    const search = h('input', { type: 'search', placeholder: 'Search school or region', 'aria-label': 'Search school or region', value: S.q, oninput: (e) => { S.q = e.target.value; draw(); } });
    const tierSel = h('select', { 'aria-label': 'Tier', onchange: (e) => { S.tier = e.target.value; draw(); } }, [['', 'All tiers'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3']].map(([v, t]) => h('option', { value: v }, t)));
    tierSel.value = S.tier;
    setKids(
      app,
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Schools'),
        h('p', null, 'Every school in your sheet. The dashboard reads each school’s own website and shows what it found next to what your sheet says. Click a number card to show only those schools, or click a school to see its answers and copy them. ', helpLink('status', 'What do the labels mean?')),
        STATIC && ov.generatedAt ? h('p', { class: 'snapshot' }, `Read-only copy of the results as of ${new Date(ov.generatedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. It does not update by itself.`) : null)),
      nextStepCard(),
      addSchoolPanel(),
      h('div', { class: 'stats', role: 'group', 'aria-label': 'Quick filters' },
        statBtn('', ov.schools.length, 'all schools'),
        statBtn('ok', scraped.length, 'checked', 'Schools whose website has been read'),
        statBtn('updated', updated.length, 'changed on their website', 'Schools whose website has different answers than the last time it was checked'),
        statBtn('fills', `${sum('fills')}`, `blank answers the websites can fill (${withFills.length} schools)`, 'Questions that are empty in your sheet but the school’s website answers'),
        statBtn('differs', `${sum('differs')}`, `answers that differ from your sheet (${withDiffs.length} schools)`, 'Questions where the website and your sheet give different answers (your sheet may be out of date)'),
        statBtn('problem', needsCheck.length, 'need a person to look', 'Websites that blocked us, would not open, have no link, or may be the wrong school'),
        statBtn('not-scraped', notScraped.length, 'not checked yet')),
      h('div', { class: 'bar' }, search, tierSel, statusSel, count, h('span', { class: 'spacer' }), xlsxBtn, STATIC ? null : scrapeBtn),
      bulkBar,
      h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, headRow), tbody)));
    draw();
  }

  // ------------------------------------- pages a person saved by hand (for websites that refuse automatic reading) ---
  // The dashboard does not try to get past a website's security check. A person opens the school's pages in their own
  // browser, saves them, and adds the files here; the dashboard reads them the same way it reads any website.
  function savedPagesPanel(s, r, reload) {
    const blocked = !r || r.status !== 'ok' || !!(r.websiteStatus && r.websiteStatus.status !== 'ok');
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const listBox = h('div');
    const readBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Read these pages');
    const input = h('input', { type: 'file', multiple: true, accept: '.html,.htm,.pdf', hidden: true, 'aria-label': 'Choose the pages you saved' });
    const addr = h('input', { type: 'text', class: 'wide', placeholder: 'https://… (only if you know the page’s web address)', 'aria-label': 'Web address of the page (optional)', autocomplete: 'off' });
    const pick = h('button', { class: 'btn', type: 'button' }, 'Choose saved pages…');

    async function drawList() {
      let l;
      try { l = await api('/api/manual-pages?school=' + encodeURIComponent(s.id)); } catch (e) { say(e.message, true); return; }
      readBtn.disabled = !l.pages.length;
      setKids(listBox, l.pages.length
        ? h('ul', { class: 'savedlist' }, l.pages.map((p) => h('li', null,
          h('b', null, p.title || p.name), ' ',
          h('span', { class: 'muted small' }, `(${p.kind === 'pdf' ? 'PDF' : 'web page'}, ${Math.max(1, Math.round(p.bytes / 1024)).toLocaleString()} KB)`),
          h('span', { class: 'sub' }, safeUrl(p.url) ? ext(p.url) : p.url,
            p.urlFrom === 'name' ? h('span', { class: 'muted' }, ' (web address made up from the file name; it only matters for working out what the page is about)') : null),
          h('button', { class: 'btn link small', type: 'button', onclick: async () => {
            try { await api('/api/manual-pages/remove', { school: s.id, id: p.id }); } catch (e) { say(e.message, true); }
            drawList();
          } }, 'Remove')))) : h('p', { class: 'muted small' }, 'No saved pages yet.'));
    }
    async function upload(files) {
      let added = 0;
      const bad = [];
      pick.disabled = true;
      const tid = 'pages-add-' + s.id;
      startTask(tid, `Adding ${files.length} saved page${files.length === 1 ? '' : 's'}…`, { message: s.name });
      for (const f of files) {
        say(`Adding “${f.name}”…`);
        const q = new URLSearchParams({ school: s.id, name: f.name });
        if (files.length === 1 && addr.value.trim()) q.set('page', addr.value.trim());
        try { await checkedFetch('/api/manual-pages?' + q, { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: f }, 'That page could not be added.'); added++; } catch (e) { bad.push(`“${f.name}”: ${e.message}`); }
      }
      pick.disabled = false; input.value = ''; addr.value = '';
      if (added) endTask(tid, { title: `${added} saved page${added === 1 ? '' : 's'} added`, message: (bad.length ? `${bad.length} could not be added. ` : '') + s.name, link: '#/school/' + encodeURIComponent(s.id), linkText: 'Open the school' });
      else endTask(tid, { failed: true, title: 'No pages were added', message: bad.join(' '), link: '#/school/' + encodeURIComponent(s.id), linkText: 'Open the school' });
      await drawList();
      say((added ? `${added} page${added === 1 ? '' : 's'} added. ` : '') + (bad.length ? 'Not added: ' + bad.join(' ') : 'Press “Read these pages” when you have added them all.'), !added && bad.length > 0);
    }
    pick.onclick = () => input.click();
    input.onchange = () => { if (input.files.length) upload([...input.files]); };
    readBtn.onclick = async () => {
      readBtn.disabled = true; say('Reading the saved pages. This takes a few seconds. You can open other pages meanwhile.');
      const tid = 'pages-read-' + s.id;
      startTask(tid, 'Reading the saved pages…', { message: s.name });
      try {
        const r2 = await api('/api/manual-pages/build', { school: s.id });
        const mine = r2.schools.find((x) => x.id === s.id) || r2.schools[0] || {};
        const result = `Read ${r2.pages} page${r2.pages === 1 ? '' : 's'}` + (mine.total ? ` and found ${mine.found} of ${mine.total} answers.` : '.');
        say('Done. ' + result);
        endTask(tid, { title: 'The saved pages were read', message: `${s.name}: ${result}`, link: '#/school/' + encodeURIComponent(s.id), linkText: 'Open the school' });
        await loadOverview();
        // refresh the school page only if the person is still looking at it
        if (reload && S.view === 'school' && location.hash.startsWith('#/school/' + encodeURIComponent(s.id))) setTimeout(reload, 900);
        else refreshIfOn('schools', 'review');
      } catch (e) { endTask(tid, { failed: true, title: 'The saved pages could not be read', message: e.message }); say(e.message, true); readBtn.disabled = false; }
    };
    drawList();
    return h('details', { class: 'panel savedpages', open: blocked },
      h('summary', null, blocked ? 'The website does not let the dashboard in. You can still use it: add pages you saved yourself' : 'Pages saved by hand: add or change them'),
      h('p', null, 'Some websites show a security check (for example “Just a moment…”) and refuse automatic readers. The dashboard respects that and does not try to get around it. You can still use the school’s website yourself: open its pages in your own browser, save them, and add the files here. The dashboard reads them the same way it reads any other website.'),
      h('ol', null,
        h('li', null, 'In your own browser, open the school’s pages that hold the answers: admissions and how to apply, tuition and financial aid, key dates, “fast facts” or “at a glance”, and the pages about classes and faculty.'),
        h('li', null, 'On each page, wait until it has fully loaded, then press ', h('b', null, 'Ctrl + S'), ' and save it as ', h('b', null, '“Webpage, Complete”'), '. The file ending in .html is the one to add (ignore the folder next to it). If a page will not save properly, print it to a PDF instead.'),
        h('li', null, 'Choose the saved files below. You can pick several at once.'),
        h('li', null, 'Press ', h('b', null, 'Read these pages'), '. The answers then appear on this page, marked as read from saved pages.')),
      h('label', { class: 'field' }, h('span', null, 'Web address of the page (optional, used when you add one file at a time)'), addr),
      h('div', { class: 'runbtns' }, pick, input, readBtn), out, listBox,
      h('p', { class: 'muted small' }, 'These pages are shared by every school on the same website (for example the middle and upper school). ', helpLink('blocked', 'More about blocked websites'), '.'));
  }

  // ----------------------------------------------- adding one school without loading the whole sheet again ---
  function addSchoolPanel() {
    if (STATIC) return null;
    const just = S.justAdded; S.justAdded = null;
    const msg = h('p', { class: 'small' });
    const say = (t, bad) => { msg.textContent = t; msg.className = 'small ' + (bad ? 'bad' : 'good'); };
    const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
    const name = h('input', { type: 'text', maxlength: '120', placeholder: 'For example: Westbrook Academy (Upper) School', autocomplete: 'off', 'aria-label': 'School name' });
    const site = h('input', { type: 'text', placeholder: 'https://www.school.org', autocomplete: 'off', 'aria-label': 'School website' });
    const tier = h('select', { 'aria-label': 'Tier' }, [['', 'Not sure yet'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3']].map(([v, t]) => h('option', { value: v }, t)));
    const region = h('input', { type: 'text', maxlength: '80', placeholder: 'For example: San Francisco, CA', autocomplete: 'off', 'aria-label': 'Region' });
    const portal = h('input', { type: 'text', placeholder: 'Ravenna or other application link (optional)', autocomplete: 'off', 'aria-label': 'Application portal link' });
    const add = h('button', { class: 'btn primary', type: 'button' }, 'Add this school');
    const done = h('div');
    const running = !!(S.job && S.job.running);
    if (just) {
      setKids(done, h('div', { class: 'notice ok' }, h('b', null, `“${just.name}” was added.`), ' It is on the school list now. Next:',
        h('div', { class: 'runbtns' },
          h('button', { class: 'btn primary', type: 'button', disabled: running || !just.website, title: just.website ? null : 'This school has no website address yet', onclick: () => startRun({ scope: 'schools', ids: [just.id] }) }, 'Read its website now'),
          h('a', { class: 'btn', href: '#/school/' + encodeURIComponent(just.id) }, 'Open the school'),
          h('a', { class: 'btn', href: '#/sources/ravenna', onclick: () => { S.srcQ = just.name; } }, 'Add its Ravenna / Niche pages'))));
    }
    add.onclick = async () => {
      add.disabled = true; say('Adding…');
      try {
        const r = await api('/api/schools/add', { name: name.value, website: site.value, tier: tier.value, region: region.value, portal: portal.value });
        S.justAdded = r.school;
        await loadOverview();
        viewSchools();
      } catch (e) { say(e.message, true); add.disabled = false; }
    };
    return h('details', { class: 'panel addschool', open: !!just },
      h('summary', null, 'Add a school that is not in your sheet'),
      h('p', null, 'A new school does not need the whole School Information Sheet to be loaded again. Type its name and website here and it joins the list. If you load the whole sheet later, schools added here stay on the list unless the sheet lists them itself.'),
      h('div', { class: 'addform' }, field('School name (required)', name), field('Website', site), field('Tier', tier), field('Region', region), field('Application portal link', portal)),
      h('div', { class: 'runbtns' }, add), msg, done);
  }

  // ------------------------------------- Ravenna, Niche and the review sites: pages a person saved by hand ---
  // The school's own website is read first. These pages only fill what the website did not answer. They are never fetched
  // by the dashboard (Niche blocks automatic readers, Private School Review's terms forbid them, Ravenna needs a login):
  // a person saves the page in their own browser and adds the file here.
  const SRC_HOST = { niche: 'niche.com', psr: 'privateschoolreview.com', bsr: 'boardingschoolreview.com' };
  const OTHER_LABEL = { ravenna: 'Ravenna', niche: 'Niche', psr: 'Private School Review', bsr: 'Boarding School Review' };
  async function viewSources(sourceKey) {
    if (STATIC) return;
    app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
    let d;
    try { d = await api('/api/sources'); } catch (e) { app.replaceChildren(h('div', { class: 'notice' }, e.message)); return; }
    if (!d.ready) { app.replaceChildren(h('div', { class: 'panel' }, h('h2', null, 'No school list yet'), h('p', null, 'Load your School Information Sheet first on the Start here page.'), h('a', { class: 'btn primary', href: '#/start' }, 'Go to Start here'))); return; }
    const key = d.sources.some((x) => x.key === sourceKey) ? sourceKey : 'ravenna';
    const src = d.sources.find((x) => x.key === key);
    const SS = S.src || (S.src = { q: '', show: 'all' });
    if (S.srcQ != null) { SS.q = S.srcQ; S.srcQ = null; }
    const results = h('ul', { class: 'savedlist droplog' });
    const tbody = h('tbody');
    const countEl = h('span', { class: 'muted small' });
    const summaryEl = h('p', { class: 'small muted' });

    const savedCount = (k) => Object.values(d.pages).filter((p) => p[k]).length;
    const tabCounts = new Map();
    const tabs = h('div', { class: 'srctabs', role: 'tablist', 'aria-label': 'Source' }, d.sources.map((x) => {
      const n = h('b', null, ` ${savedCount(x.key)}`);
      tabCounts.set(x.key, n);
      return h('button', { type: 'button', role: 'tab', 'aria-selected': String(x.key === key), class: 'chip tab' + (x.key === key ? ' on' : ''),
        title: 'Schools with saved pages', onclick: () => { location.hash = '#/sources/' + x.key; } }, x.label, n);
    }));

    const linkFor = (s) => {
      if (key === 'ravenna') {
        return s.portalLabel === 'Ravenna' && safeUrl(s.portal) ? ext(s.portal, 'Open in Ravenna') : h('span', { class: 'muted small' }, 'Not a Ravenna school in your list');
      }
      return ext('https://www.google.com/search?q=' + encodeURIComponent(`${s.name} ${SRC_HOST[key]}`), `Find on ${src.label}`);
    };

    async function upload(files, school, log) {
      let added = 0, filled = 0;
      for (const f of files) {
        const q = new URLSearchParams({ source: key, name: f.name });
        if (school) q.set('school', school.id); else q.set('auto', '1');
        try {
          const r = await (await checkedFetch('/api/sources/page?' + q, { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: f }, 'That page could not be added.')).json();
          added++; filled += r.filled || 0;
          log(`✓ “${f.name}”${school ? '' : ' → ' + r.school.name}: added` + (r.entry.warning ? ` (check: ${r.entry.warning})` : ''), false);
        } catch (e) { log(`✗ “${f.name}”: ${e.message}`, true); }
      }
      if (added) { try { d = await api('/api/sources'); } catch { /* the table keeps showing the old counts */ } drawTable(); }
      return { added, filled };
    }

    const logLine = (text, bad) => results.prepend(h('li', { class: bad ? 'bad' : 'good' }, text));
    const dropInput = h('input', { type: 'file', multiple: true, accept: '.html,.htm,.pdf', hidden: true, 'aria-label': 'Choose the pages you saved' });
    const drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': `Add several saved ${src.label} pages at once` },
      h('b', null, `Add many saved ${src.label} pages at once`),
      h('span', null, 'Drag the saved files here, or click to choose them. Each page is matched to its school by the school’s name on the page. Pages that cannot be matched are listed so you can add them from the school’s own row below.'));
    const run = async (files) => {
      if (!files.length) return;
      const tid = 'src-bulk';
      startTask(tid, `Adding ${files.length} saved ${src.label} page${files.length === 1 ? '' : 's'}…`);
      const r = await upload(files, null, logLine);
      endTask(tid, { title: `${r.added} of ${files.length} pages added`, message: r.added ? `${r.filled} answer${r.filled === 1 ? '' : 's'} filled in.` : 'None could be added. See the list on the page.', failed: !r.added });
    };
    drop.onclick = () => dropInput.click();
    drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dropInput.click(); } };
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); run([...e.dataTransfer.files]); };
    dropInput.onchange = () => { const fs = [...dropInput.files]; dropInput.value = ''; run(fs); };

    function rowFor(s) {
      const mine = (d.pages[s.id] || {})[key];
      const detail = h('div', { class: 'srcdetail', hidden: true });
      const msg = h('div', { class: 'small' });
      const input = h('input', { type: 'file', multiple: true, accept: '.html,.htm,.pdf', hidden: true, 'aria-label': `Choose ${src.label} pages for ${s.name}` });
      const addBtn = h('button', { class: 'btn small', type: 'button', onclick: () => input.click() }, mine ? 'Add another…' : 'Add page…');
      input.onchange = async () => {
        const files = [...input.files]; input.value = '';
        addBtn.disabled = true;
        const lines = [];
        const r = await upload(files, s, (t, bad) => lines.push([t, bad]));
        // the table was redrawn if something was added; show the outcome on the new row of the same school
        const again = tbody.querySelector(`[data-school="${s.id}"] .srcmsg`);
        const box = again || msg;
        setKids(box, lines.map(([t, bad]) => h('div', { class: bad ? 'bad' : 'good' }, t)), r.added ? h('div', { class: 'muted' }, `${r.filled} answer${r.filled === 1 ? '' : 's'} now come from this page.`) : null);
        addBtn.disabled = false;
      };
      const show = async () => {
        if (!detail.hidden) { detail.hidden = true; return; }
        detail.hidden = false; setKids(detail, 'Loading…');
        try {
          const l = await api(`/api/sources/pages?school=${encodeURIComponent(s.id)}&source=${key}`);
          setKids(detail, l.pages.length ? h('ul', { class: 'savedlist' }, l.pages.map((p) => h('li', null,
            h('b', null, p.title || p.name), ' ', h('span', { class: 'muted small' }, `(${p.kind === 'pdf' ? 'PDF' : 'web page'}, ${Math.max(1, Math.round(p.bytes / 1024)).toLocaleString()} KB, added ${ago(p.addedAt)})`),
            p.url ? h('span', { class: 'sub' }, safeUrl(p.url) ? ext(p.url) : p.url) : null,
            p.warning ? h('span', { class: 'sub warnline' }, p.warning) : null,
            h('button', { class: 'btn link small', type: 'button', onclick: async () => {
              try { await api('/api/sources/remove', { school: s.id, source: key, id: p.id }); d = await api('/api/sources'); drawTable(); } catch (e) { setKids(detail, h('span', { class: 'bad' }, e.message)); }
            } }, 'Remove'))) ) : h('span', { class: 'muted small' }, 'No saved pages.'));
        } catch (e) { setKids(detail, h('span', { class: 'bad' }, e.message)); }
      };
      const status = mine
        ? [h('span', { class: 'chip ' + (mine.filled > 0 ? 'ok' : 'warn'), title: key === 'ravenna' ? (mine.filled > 0 ? 'Admissions Portal answers read from these pages. They sit beside the website’s answers.' : 'No application steps were recognised on the saved page(s).') : (mine.filled > 0 ? 'Answers that now come from this source because the website did not give them' : 'Nothing was read from the saved page(s), or the website already answered everything the page holds.') },
          `${mine.pages} page${mine.pages === 1 ? '' : 's'} · ${mine.filled || 0} filled`),
        mine.facts === 0 ? h('span', { class: 'chip warn', title: 'No labelled facts were recognised on this page. Send an example to be set up.' }, 'nothing read') : null,
        mine.warning ? h('span', { class: 'chip warn', title: 'Open the pages to see the warning' }, 'check') : null,
        ' ', h('button', { class: 'btn link small', type: 'button', onclick: show }, 'Show / remove'), ' ', h('span', { class: 'muted small' }, ago(mine.at))]
        : h('span', { class: 'muted small' }, 'None yet');
      return h('tr', { 'data-school': s.id },
        h('td', { class: 'name' }, h('a', { href: '#/school/' + encodeURIComponent(s.id) }, s.name), h('span', { class: 'sub' }, [s.region, s.tier ? 'Tier ' + s.tier : ''].filter(Boolean).join(' · ')), s.addedByHand ? h('span', { class: 'sub' }, 'added by hand') : null),
        h('td', null, linkFor(s)),
        h('td', null, status, detail),
        h('td', null, addBtn, input, h('div', { class: 'srcmsg' }, msg)));
    }

    function drawTable() {
      const q = SS.q.trim().toLowerCase();
      const list = d.schools.filter((s) => {
        if (q && !`${s.name} ${s.region || ''}`.toLowerCase().includes(q)) return false;
        const has = !!(d.pages[s.id] || {})[key];
        if (SS.show === 'saved') return has;
        if (SS.show === 'missing') return !has;
        if (SS.show === 'ravenna') return s.portalLabel === 'Ravenna';
        if (SS.show === 'ravenna-missing') return s.portalLabel === 'Ravenna' && !has;
        return true;
      });
      countEl.textContent = `${list.length} of ${d.schools.length} schools`;
      for (const [k, el] of tabCounts) el.textContent = ` ${savedCount(k)}`;
      const withPages = d.schools.filter((s) => (d.pages[s.id] || {})[key]).length;
      const filled = d.schools.reduce((n, s) => n + (((d.pages[s.id] || {})[key] || {}).filled || 0), 0);
      summaryEl.textContent = withPages ? (key === 'ravenna' ? `${withPages} school${withPages === 1 ? '' : 's'} have saved Ravenna pages, which gave ${filled} Admissions Portal answer${filled === 1 ? '' : 's'}.` : `${withPages} school${withPages === 1 ? '' : 's'} have saved ${src.label} pages, which filled ${filled} answer${filled === 1 ? '' : 's'} the websites did not give.`) : `No ${src.label} pages saved yet.`;
      setKids(tbody, list.length ? list.slice(0, 400).map(rowFor) : h('tr', null, h('td', { colspan: 4, class: 'empty' }, 'No schools match.')));
    }

    const search = h('input', { type: 'search', placeholder: 'Search school or region', 'aria-label': 'Search school or region', value: SS.q, oninput: (e) => { SS.q = e.target.value; drawTable(); } });
    const showSel = h('select', { 'aria-label': 'Which schools' }, [
      ['all', 'All schools'], ['saved', `With ${src.label} pages`], ['missing', `Without ${src.label} pages`],
      ...(key === 'ravenna' ? [['ravenna', 'Ravenna schools only'], ['ravenna-missing', 'Ravenna schools still to add']] : [])].map(([v, t]) => h('option', { value: v }, t)));
    if ([...showSel.options].some((o) => o.value === SS.show)) showSel.value = SS.show; else SS.show = 'all';
    showSel.onchange = () => { SS.show = showSel.value; drawTable(); };

    const steps = key === 'ravenna'
      ? ['Press “Open in Ravenna” on the school’s row and sign in to Ravenna in your own browser.', 'Open the page that holds the application steps, dates and requirements and wait until it has fully loaded.']
      : [`Press “Find on ${src.label}” on the school’s row and open the school’s ${src.label} page in your own browser.`, 'Wait until the page has fully loaded.'];
    app.replaceChildren(
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Ravenna and other sources'),
        h('p', null, 'The school’s own website is always read first. For a question the website does not answer, the dashboard fills it from pages you saved by hand, in this order: ',
          h('b', null, '1. the school’s website, 2. Niche, 3. Private School Review and Boarding School Review'), '. Every answer shows which site it came from, and a later source never replaces an earlier one. ',
          h('b', null, 'Ravenna is different:'), ' the school’s application steps in Ravenna are its “Admissions Portal” answers. They sit beside the website’s answers (your sheet keeps them in column B, the website’s in column C) and never take their place.'),
        h('p', { class: 'muted small' }, 'Why saved by hand? Niche blocks automatic readers, Private School Review’s terms of use do not allow them, and Ravenna needs your login. So you open the page in your own browser, save it, and add the file here. The dashboard never contacts these sites. A saved Ravenna page is a family’s application, so the dashboard keeps only the school’s own steps and throws away the applicant’s name, birthdate, email and sign-in details.'))),
      tabs,
      h('p', { class: 'small muted' }, src.blurb),
      h('details', { class: 'panel' }, h('summary', null, `How to add ${src.label} pages`),
        h('ol', null,
          ...steps.map((t) => h('li', null, t)),
          h('li', null, 'Press ', h('b', null, 'Ctrl + S'), ' and save it as ', h('b', null, '“Webpage, HTML only”'), ' (or “Webpage, Complete”). The file ending in .html is the one to add; ignore the folder next to it. If a page will not save properly, print it to a PDF instead.'),
          h('li', null, 'Add the file on the school’s row below, or drop many files in the box. The answers appear on the school’s page, marked with where they came from.'))),
      saveButtonPanel(),
      drop, dropInput, results,
      summaryEl,
      h('div', { class: 'bar' }, search, showSel, countEl),
      h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['School', `Page on ${src.label}`, 'Saved pages', ''].map((t) => h('th', null, t)))), tbody)));
    drawTable();
  }

  // ------------------------------------------------------------------------- the one-click save button ---
  // A bookmark the person drags to their browser's bookmarks bar. Clicked on a Niche, Private School Review, Boarding School Review or Ravenna
  // page they are looking at, it opens this dashboard's #/receive page in a small window and hands the page over with postMessage (which a
  // website's own security rules do not stop). The person opened the page themselves; nothing is fetched by the dashboard. If the dashboard does
  // not answer, the bookmark saves the page as a file instead, which can be added the usual way.
  const SAVE_SITES = [['niche', /(^|\.)niche\.com$/i], ['psr', /(^|\.)privateschoolreview\.com$/i], ['bsr', /(^|\.)boardingschoolreview\.com$/i], ['ravenna', /(^|\.)ravenna-hub\.com$/i]];
  /** Which source a page's web address belongs to, or null: only these sites (over https) are ever accepted. */
  const sourceForOrigin = (origin) => {
    let u; try { u = new URL(origin); } catch { return null; }
    if (u.protocol !== 'https:') return null;
    const hit = SAVE_SITES.find(([, re]) => re.test(u.hostname));
    return hit ? hit[0] : null;
  };
  function bookmarkletCode(origin) {
    return [
      '(function(){',
      `var D=${JSON.stringify(origin)},H='<!DOCTYPE html>'+document.documentElement.outerHTML,U=location.href,T=document.title,done=0,ping,timer;`,
      'function file(why){if(done)return;done=1;clearInterval(ping);clearTimeout(timer);',
      'var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([H],{type:"text/html"}));',
      'a.download=(T||"page").replace(/[^A-Za-z0-9 ()._-]+/g," ").slice(0,80)+".html";document.body.appendChild(a);a.click();a.remove();',
      'alert(why+" The page was saved as a file in your Downloads folder instead. Add that file on the Ravenna & reviews page of the dashboard.");}',
      'var w=window.open(D+"/#/receive","sisSave","width=560,height=600");',
      'if(!w){file("Pop-ups are blocked for this site.");return;}',
      'window.addEventListener("message",function(e){if(e.origin!==D||!e.data||!e.data.sisReady||done)return;',
      'done=1;clearInterval(ping);clearTimeout(timer);w.postMessage({sis:1,html:H,url:U,title:T},D);});',
      'ping=setInterval(function(){try{w.postMessage({sisPing:1},D)}catch(x){}},400);',
      'timer=setTimeout(function(){file("The dashboard did not answer (is it open, and are you signed in?).")},15000);',
      '})();',
    ].join('');
  }

  function saveButtonPanel() {
    if (STATIC) return null;
    const code = 'javascript:' + encodeURIComponent(bookmarkletCode(location.origin));
    const link = h('a', { class: 'btn primary bookmarklet', href: code, draggable: 'true', title: 'Drag me to your bookmarks bar',
      onclick: (e) => { e.preventDefault(); alert('Do not click it here: drag it up to your browser’s bookmarks bar, then click it on a school’s page.'); } }, '★ Save to School Info');
    const copyBtn = h('button', { class: 'btn small', type: 'button', onclick: () => copyText(code, copyBtn) }, 'Copy the bookmark address');
    return h('details', { class: 'panel', open: true },
      h('summary', null, 'One-click save button: save a page you are looking at without saving a file'),
      h('p', null, 'Instead of pressing Ctrl + S and choosing the file, you click one bookmark. It sends the page you are looking at to this dashboard, which finds the school by its name, adds the page, and tells you how many answers it filled.'),
      h('ol', null,
        h('li', null, 'Show your browser’s bookmarks bar (in Chrome or Edge: ', h('kbd', null, 'Ctrl'), ' + ', h('kbd', null, 'Shift'), ' + ', h('kbd', null, 'B'), ').'),
        h('li', null, 'Drag this button up to the bookmarks bar: ', link, ' ', h('span', { class: 'muted small' }, '(Do not click it here.) Cannot drag? Make a new bookmark by hand named “Save to School Info” and paste the address: '), copyBtn),
        h('li', null, 'Open a school’s page on Niche, Private School Review, Boarding School Review or Ravenna (sign in first if needed) and wait until it has fully loaded.'),
        h('li', null, 'Click the bookmark. A small window opens and saves the page. If it cannot tell which school the page is for, it asks you to choose.')),
      h('p', { class: 'muted small' }, `This button works with the dashboard at ${location.origin}. The first time, your browser may ask to allow pop-ups from the site: allow them. The dashboard must be open and you must be signed in. If the dashboard does not answer, the page is saved as a file in your Downloads folder instead, and you can add that file below. The dashboard never opens these sites itself.`));
  }

  /** The small window the bookmark opens: waits for a page from an allowed site, adds it, and says what happened. */
  async function viewReceive() {
    if (STATIC) return;
    document.body.classList.add('receivemode');
    const box = h('div', { class: 'panel receivebox' });
    app.replaceChildren(box);
    const say = (title, text, kind, ...more) => setKids(box, h('h2', null, title), text ? h('p', { class: kind || '' }, text) : null, ...more);
    say('Ready', 'Waiting for a page. Open a school’s page on Niche, Private School Review, Boarding School Review or Ravenna, and click the “Save to School Info” bookmark there.');
    const post = async (q, html) => {
      const r = await fetch('/api/sources/page?' + q, { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: html });
      return { ok: r.ok, status: r.status, j: await r.json().catch(() => ({})) };
    };
    const choose = async (src, name, html, url, why, candidates) => {
      let all = [];
      try { all = (await api('/api/sources')).schools || []; } catch { /* the list below stays empty */ }
      const first = new Set((candidates || []).map((c) => c.id));
      const sorted = [...all.filter((s) => first.has(s.id)), ...all.filter((s) => !first.has(s.id))];
      const find = h('input', { type: 'search', placeholder: 'Type to find the school', 'aria-label': 'Find the school' });
      const sel = h('select', { size: '8', 'aria-label': 'School' });
      const draw = () => { const q = find.value.trim().toLowerCase(); setKids(sel, sorted.filter((s) => !q || s.name.toLowerCase().includes(q)).slice(0, 80).map((s) => h('option', { value: s.id }, s.name))); if (sel.options.length) sel.selectedIndex = 0; };
      find.oninput = draw; draw();
      const go = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
        if (!sel.value) return;
        go.disabled = true;
        await save(src, name, html, url, sel.value);
      } }, 'Save the page to this school');
      say('Which school is this?', why, 'bad', find, sel, h('div', { class: 'runbtns' }, go));
    };
    const save = async (src, name, html, url, schoolId) => {
      say('Saving…', name);
      const q = new URLSearchParams({ source: src, name });
      if (schoolId) q.set('school', schoolId); else q.set('auto', '1');
      if (safeUrl(url)) q.set('page', url);
      let r;
      try { r = await post(q, html); } catch (e) { say('Could not save the page', 'The dashboard could not be reached. Try again, or use the saved-file route on the Ravenna & reviews page.', 'bad'); return; }
      if (r.status === 401 && r.j.signIn) { say('Please sign in', 'Your sign-in has expired. Sign in to the dashboard in this window, then click the bookmark again.', 'bad', h('a', { class: 'btn', href: r.j.signIn }, 'Sign in')); return; }
      if (r.status === 409 && Array.isArray(r.j.candidates)) { await choose(src, name, html, url, r.j.error, r.j.candidates); return; }
      if (!r.ok) { say('That page was not added', r.j.error || 'Request failed (' + r.status + ')', 'bad'); return; }
      const n = r.j.filled || 0;
      say('Saved', `Added to ${r.j.school.name}. ${n ? `${n} answer${n === 1 ? '' : 's'} now come${n === 1 ? 's' : ''} from this page.` : 'The school’s website already answered everything this page holds, or no labelled facts were found on it.'}`, 'good',
        r.j.entry.warning ? h('p', { class: 'warnline' }, r.j.entry.warning) : null,
        h('div', { class: 'runbtns' }, h('a', { class: 'btn', href: '#/school/' + encodeURIComponent(r.j.school.id) }, 'Open the school'), h('button', { class: 'btn', type: 'button', onclick: () => window.close() }, 'Close this window')),
        h('p', { class: 'muted small' }, 'This window closes by itself in a few seconds.'));
      setTimeout(() => { if (box.isConnected && /^Saved/.test((box.querySelector('h2') || {}).textContent || '')) window.close(); }, 6000);
    };
    const onMessage = async (e) => {
      const src = sourceForOrigin(e.origin);
      if (!src || !e.data || typeof e.data !== 'object') return;     // only the review sites and Ravenna, over https
      if (e.data.sisPing) { try { e.source.postMessage({ sisReady: 1 }, e.origin); } catch { /* the page closed */ } return; }
      if (!e.data.sis || typeof e.data.html !== 'string') return;
      const title = String(e.data.title || 'page').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 100) || 'page';
      // the page's own text encoding no longer applies: what arrives is text, which is sent as UTF-8
      const html = e.data.html.replace(/<meta[^>]+charset=[^>]*>/ig, '<meta charset="utf-8">');
      await save(src, title + '.html', html, String(e.data.url || ''));
    };
    S.receiveHandler = onMessage;
    window.addEventListener('message', onMessage);
    if (window.opener) { try { window.opener.postMessage({ sisReady: 1 }, '*'); } catch { /* no opener to tell */ } }
  }

  /** On a school's page: what was saved from Ravenna and the review sites for it, and a way to add more. */
  function otherSourcesPanel(s, r) {
    if (STATIC) return null;
    const mine = (r && r.otherSources) || {};
    const keys = Object.keys(mine);
    const line = (k) => h('li', null, h('b', null, mine[k].label), `: ${mine[k].pages} saved page${mine[k].pages === 1 ? '' : 's'}, ${mine[k].filled.length} answer${mine[k].filled.length === 1 ? '' : 's'} filled in`);
    const go = (k) => h('a', { class: 'btn small', href: '#/sources/' + k, onclick: () => { S.srcQ = s.name; } }, k === 'ravenna' ? 'Ravenna' : k === 'niche' ? 'Niche' : k === 'psr' ? 'Private School Review' : 'Boarding School Review');
    return h('details', { class: 'panel', open: keys.length > 0 },
      h('summary', null, keys.length ? 'Answers from Ravenna, Niche or review sites: pages saved for this school' : 'Fill the gaps from Ravenna, Niche or the review sites'),
      h('p', null, 'The school’s website is read first. For anything it does not answer, you can add pages you saved by hand, and the answers will say which site they came from.'),
      keys.length ? h('ul', null, keys.map(line)) : null,
      h('div', { class: 'runbtns' }, h('span', { class: 'muted small' }, 'Add a page from: '), go('ravenna'), go('niche'), go('psr'), go('bsr')));
  }

  // ------------------------------------------------------------ school view ---
  async function viewSchool(id, tabIndex) {
    app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
    let d;
    try { d = await api(`/api/school?id=${encodeURIComponent(id)}&tab=${tabIndex || 0}`); } catch (e) {
      app.replaceChildren(h('a', { class: 'crumb', href: '#/' }, '← All schools'), h('div', { class: 'notice' }, e.message));
      return;
    }
    const s = d.school, r = d.result;
    document.title = s.name + ' · School Info Sheet';
    const tab = d.tabs[d.tabIndex];
    const running = !!(S.job && S.job.running);
    const rowsBox = h('div');
    const filterBox = h('div', { class: 'filters', role: 'group', 'aria-label': 'Show fields' });

    // ---- spot-checks: a person marks what was found as right or wrong; the Accuracy page turns the checks into rates ----
    let vmap = {};
    if (!STATIC && r && r.status === 'ok') { try { vmap = await api('/api/verify?school=' + encodeURIComponent(s.id)); } catch { vmap = {}; } }
    const VERDICT_TEXT = { correct: 'You marked it: right', wrong: 'You marked it: wrong', missed: 'You marked it: the website does have it', absent: 'You marked it: nothing on the website' };
    const vbtn = (text, fn) => h('button', { type: 'button', class: 'btn vbtn', onclick: fn }, text);
    const verifyControl = (row) => {
      if (STATIC || !r || r.status !== 'ok' || !row.hasRule) return null;
      const f = row.scraped, found = !!(f && f.status === 'found');
      const box = h('div', { class: 'verify' });
      const save = async (verdict, extra) => {
        try { vmap[row.key] = await api('/api/verify', { school_id: s.id, field: row.key, verdict, ...(extra || {}) }); } catch (e) { alert(e.message); }
        drawBox();
      };
      const undo = async () => {
        try { await api('/api/verify', { school_id: s.id, field: row.key, clear: true }); delete vmap[row.key]; } catch (e) { alert(e.message); }
        drawBox();
      };
      const askTruth = (verdict, prompt) => {   // wrong or missed: optionally say what the right value is
        const truth = h('input', { type: 'text', class: 'vtruth', placeholder: prompt, 'aria-label': prompt, maxlength: '500' });
        const link = h('input', { type: 'text', class: 'vlink', placeholder: 'Page link where you found it (optional)', 'aria-label': 'Page link where you found it', maxlength: '480' });
        box.replaceChildren(h('div', { class: 'vform' }, truth, link,
          h('div', { class: 'runbtns' }, h('button', { type: 'button', class: 'btn vbtn primary', onclick: () => save(verdict, { truth: truth.value, truthUrl: link.value }) }, 'Save'),
            h('button', { type: 'button', class: 'btn vbtn', onclick: () => drawBox() }, 'Cancel'))));
        truth.focus();
      };
      function drawBox() {
        const c = vmap[row.key];
        if (c && !c.stale) {
          setKids(box, h('span', { class: 'chip ' + (c.verdict === 'correct' || c.verdict === 'absent' ? 'ok' : 'bad') }, VERDICT_TEXT[c.verdict] || 'Checked'),
            c.truth ? h('span', { class: 'small' }, ' Right value: ', h('b', null, c.truth)) : null, ' ',
            h('button', { type: 'button', class: 'btn link small', onclick: undo }, 'Undo'));
          return;
        }
        setKids(box,
          h('span', { class: 'vlabel', title: 'Open the school’s website and compare. Your answer teaches the dashboard which kinds of answers to trust.' }, c && c.stale ? 'This answer changed since you marked it. Is it right now?' : 'Is this answer right?'),
          ...(found
            ? [vbtn('✓ Right', () => save('correct')), vbtn('✗ Wrong', () => askTruth('wrong', 'What is the right answer? (optional)'))]
            : [vbtn('Nothing on the website', () => save('absent')), vbtn('The website does have it', () => askTruth('missed', 'What is the answer? (optional)'))]));
      }
      drawBox();
      return box;
    };

    const sheetCell = (row) => {
      if (!row.sheet.length) return h('span', { class: 'nothing' }, tab ? 'Empty in your sheet' : 'This school has no tab in your sheet yet');
      const guide = tab && tab.guideCols && row.section === 'Guide to Applying';
      return row.sheet.map((c) => h('div', { class: 'part' },
        row.sheet.length > 1 || guide ? h('span', { class: 'tag' }, guide && tab.guideCols[c.col] ? tab.guideCols[c.col] : 'Column ' + c.col) : null,
        c.text ? clamped(c.text) : null,
        c.link ? h('div', { class: 'src' }, ext(c.link)) : null));
    };
    // how likely the value is right, worked out from the evidence, with the reasons behind the number
    const trustLine = (t) => h('div', { class: 'trustline' },
      h('span', { class: 'trust ' + t.level, title: 'How sure the dashboard is that this answer is right, out of 100. It looks at where the answer came from and how clearly the website says it. It never looks at your sheet.' }, `${TRUST_LABEL[t.level]} · ${t.score}/100`),
      t.needsReview ? h('span', { class: 'small muted' }, ' please check this one yourself') : null,
      h('details', { class: 'why' }, h('summary', null, 'Why this rating?'),
        h('ul', null, t.reasons.map((r) => h('li', { title: r.effect ? `${r.effect > 0 ? 'Raised' : 'Lowered'} the rating by about ${Math.abs(r.effect)} points` : null },
          r.effect ? h('b', { class: r.effect > 0 ? 'up' : 'down' }, r.effect > 0 ? '▲ ' : '▼ ') : '• ', r.text)))));
    const scrapedCell = (row) => {
      const f = row.scraped;
      if (!r) return h('span', { class: 'nothing' }, 'Not checked yet');
      if (r.status !== 'ok') return h('span', { class: 'nothing' }, 'The website could not be read');
      if (!f || f.status === 'none') return [h('span', { class: 'nothing' }, 'Not found on the website'), f && f.note ? h('div', { class: 'note' }, f.note) : null];
      if (f.status === 'manual') return h('span', { class: 'nothing' }, f.note);
      if (f.status !== 'found') return h('span', { class: 'nothing' }, f.note || 'No result');
      const srcs = (f.sources || []).filter((x) => safeUrl(x.url));
      const copyBtn = h('button', { type: 'button', class: 'btn copybtn', title: 'Copy this value to paste into your spreadsheet', onclick: () => copyText(f.value, copyBtn) }, 'Copy');
      return [
        clamped(f.value, copyBtn),
        // an answer the website did not give: say which other site it was read from
        f.source ? h('div', null, h('span', { class: 'chip info', title: 'The school’s website did not answer this. It was read from a page saved by hand from ' + f.source.label + '.' }, 'From ' + f.source.label + ' (saved page)')) : null,
        h('div', { class: 'src' }, 'From: ', srcs.map((x, i) => [i ? ', ' : '', ext(x.url, null, x.title)]),
          // the old match mark only says how the rule found the text, not whether it is true: key facts show the rating instead, copied text sections keep it
          row.trust ? null : h('span', { class: 'conf ' + f.confidence, title: 'Exact match: a clearly labelled figure. Probable match: a relevant sentence or section. Please double-check: found by a keyword only.' }, CONF_LABEL[f.confidence] || (f.confidence + ' confidence'))),
        f.note ? h('div', { class: 'note' }, f.note) : null,
        row.trust ? trustLine(row.trust) : null,
        h('details', null, h('summary', null, (f.source ? `Show the words from the ${f.source.label} page` : 'Show the words from the website') + (f.alts ? ` and ${f.alts.length} other possible answer${f.alts.length === 1 ? '' : 's'}` : '')),
          h('div', { class: 'evidence' }, f.snippet || ''),
          f.alts ? h('ul', { class: 'alts' }, f.alts.map((a) => h('li', null, a.value.length > 220 ? a.value.slice(0, 220) + '…' : a.value, ' — ', ext(a.url)))) : null),
      ];
    };
    // the admissions portal's (Ravenna) answer to the same question: its own block, because the sheet has a column for it next to the website's
    const portalBlock = (row) => {
      const f = row.portal;
      if (!f || f.status !== 'found') return null;
      const srcs = (f.sources || []).filter((x) => safeUrl(x.url));
      const copyBtn = h('button', { type: 'button', class: 'btn copybtn', title: 'Copy this value to paste into the Admissions Portal column of your sheet', onclick: () => copyText(f.value, copyBtn) }, 'Copy');
      return h('div', { class: 'portalblock' },
        h('div', null, h('span', { class: 'chip info', title: 'These are the school’s own application steps in Ravenna, read from a page saved by hand. In your sheet they go in column B (Admissions Portal), next to the website’s column C.' }, 'Admissions portal (Ravenna)')),
        clamped(f.value, copyBtn),
        srcs.length ? h('div', { class: 'src' }, 'From: ', srcs.map((x, i) => [i ? ', ' : '', ext(x.url, null, x.title)])) : null,
        h('details', null, h('summary', null, 'Show the words from the Ravenna page'), h('div', { class: 'evidence' }, f.snippet || '')));
    };
    const drawRows = () => {
      const kids = [];
      let any = false;
      let lastSection = null;
      for (const row of d.rows) {
        if (row.kind !== 'field') continue;
        if (S.verdict === 'look') { if (!row.trust || row.trust.triage === 'ready') continue; }
        else if (S.verdict === 'ready') { if (!row.trust || row.trust.triage !== 'ready') continue; }
        else if (S.verdict !== 'all' && row.verdict !== S.verdict) continue;
        any = true;
        if (row.section !== lastSection) {
          lastSection = row.section;
          kids.push(h('h2', { class: 'section' }, row.section),
            h('div', { class: 'colhead' }, h('span', null, 'Question'), h('span', null, 'What your sheet says now'), h('span', null, 'What the school’s website says')));
        }
        kids.push(h('div', { class: 'frow' },
          h('div', { class: 'label' }, h('b', null, row.label), h('span', { class: 'rownum' }, 'Row ' + row.row + ' in your sheet'), chip(VERDICT[row.verdict])),
          h('div', { class: 'cell', 'data-title': 'What your sheet says now' }, sheetCell(row)),
          h('div', { class: 'cell', 'data-title': 'What the school’s website says' }, scrapedCell(row), portalBlock(row), verifyControl(row))));
      }
      if (!any) kids.push(h('p', { class: 'empty' }, 'No questions in this group.'));
      rowsBox.replaceChildren(...kids);
      settleClamps();
    };
    const drawFilters = () => {
      const tc = d.trustCounts || { ready: 0, check: 0, doubtful: 0 };
      const opts = [['all', 'All questions', d.rows.filter((x) => x.kind === 'field').length],
        ...(d.trustCounts ? [['look', 'Needs checking', tc.check + tc.doubtful], ['ready', 'Safe to use', tc.ready]] : []),
        ['fills', 'Website can fill a blank', d.counts.fills], ['differs', 'Different from your sheet', d.counts.differs],
        ['match', 'Same as your sheet', d.counts.match], ['both', 'Both have an answer', d.counts.both], ['sheet-only', 'Only your sheet has it', d.counts['sheet-only']], ['none', 'Not found on the website', d.counts.none]];
      filterBox.replaceChildren(...opts.map(([k, label, n]) => h('button', { type: 'button', 'aria-pressed': String(S.verdict === k), onclick: () => { S.verdict = k; drawFilters(); drawRows(); } }, label, h('b', null, n))));
    };

    // ---- export to the Google Sheet copy (not in the read-only copy) ----
    const exportBox = h('div');
    const showExport = (x) => {
      const sm = x.summary || {};
      exportBox.replaceChildren(h('div', { class: 'notice ok' },
        h('b', null, 'Sent to the Google Sheet. '),
        `${sm.filled || 0} blank cells filled (yellow), ${sm.flagged || 0} cells with updated info to check (orange, the existing text was not changed), ${sm.unchanged || 0} already matched`,
        sm.noRow ? `, ${sm.noRow} rows not found in the tab` : '', '. ',
        x.created ? 'A new tab was made from the Master Template. ' : '',
        safeUrl(x.tabUrl) ? ext(x.tabUrl, 'Open the tab') : null,
        h('span', { class: 'muted' }, ` Sent ${ago(x.at)}${x.by ? ' by ' + x.by : ''}.`)));
    };
    if (d.exported) showExport(d.exported);
    const exportBtn = STATIC ? null : h('button', { class: 'btn', type: 'button', disabled: !r || r.status !== 'ok', title: !r || r.status !== 'ok' ? 'Check this school’s website first' : null, onclick: async () => {
      try {
        const cfgState = await api('/api/export-config');
        if (!cfgState.configured) { alert('Sending straight to the sheet is not set up. Use “Download file for Google Sheet” instead, or see the Start here page.'); return; }
      } catch (e) { return alert(e.message); }
      if (!confirm(`Send what the website gave for “${s.name}” to the Google Sheet copy?\n\nBlank cells are filled. Cells that already have text are never overwritten: they get a note with the website’s value instead.`)) return;
      exportBtn.disabled = true; exportBtn.textContent = 'Sending…';
      const tid = 'sheet-send-' + s.id;
      startTask(tid, `Sending ${s.name} to your Google Sheet…`, { message: 'You can open other pages meanwhile.' });
      try {
        const sent = await api('/api/export', { id: s.id, tab: d.tabIndex });
        showExport(sent); exportBtn.textContent = 'Send to Google Sheet again';
        endTask(tid, { title: 'Sent to your Google Sheet', message: s.name, link: safeUrl(sent.tabUrl), linkText: 'Open the tab' });
      } catch (e) {
        endTask(tid, { failed: true, title: 'Sending to the Google Sheet did not go through', message: e.message });
        exportBox.replaceChildren(h('div', { class: 'notice' }, h('b', null, 'Sending did not go through. '), e.message));
        exportBtn.textContent = d.exported ? 'Send to Google Sheet again' : 'Send to Google Sheet';
      }
      exportBtn.disabled = false;
    } }, d.exported ? 'Send to Google Sheet again' : 'Send to Google Sheet');

    // Plain Excel download + Google Sheet menu file
    const canExport = r && r.status === 'ok';
    const xlsxSchoolBtn = STATIC
      ? h('button', { class: 'btn', type: 'button', disabled: !canExport, onclick: () => downloadStaticCsv(d) }, 'Download CSV')
      : h('button', { class: 'btn', type: 'button', disabled: !canExport, title: canExport ? 'Download an Excel file comparing your sheet with the website for this school' : 'Check this school’s website first', onclick: async () => {
        xlsxSchoolBtn.disabled = true;
        try { await downloadSpreadsheet({ id: s.id, tab: d.tabIndex, format: 'xlsx' }); } catch (e) { alert(e.message); }
        xlsxSchoolBtn.disabled = false;
      } }, 'Download Excel (.xlsx)');

    const fileBtn = STATIC ? null : h('button', { class: 'btn', type: 'button', disabled: !canExport, title: canExport ? 'Makes a file for your Google Sheet’s School Info → Load export file menu.' : 'Check this school’s website first', onclick: async () => {
      fileBtn.disabled = true;
      try {
        const f = await downloadExportFile(`id=${encodeURIComponent(s.id)}&tab=${d.tabIndex}`);
        exportBox.replaceChildren(h('div', { class: 'notice ok' }, h('b', null, 'Google Sheet file saved. '),
          `“${f.name}” is in your Downloads folder. In Google Sheets open School Info → Load export file... and pick it. `,
          h('a', { href: '#/sheet-setup' }, 'The School Info menu is not there yet? Set it up step by step'), '.'));
      } catch (e) { exportBox.replaceChildren(h('div', { class: 'notice' }, h('b', null, 'The file could not be made. '), e.message)); }
      fileBtn.disabled = false;
    } }, 'File for Google Sheet');

    const openSiteLink = safeUrl(s.website) ? [' ', ext(s.website, 'Open school website ↗')] : null;
    const notice = !r ? h('div', { class: 'notice info' }, STATIC ? 'This school had not been checked when this copy was made, so only what your sheet says is shown below.' : 'This school’s website has not been checked yet. Press “Check this school’s website” to read it.')
      : r.status !== 'ok' ? h('div', { class: 'notice' }, h('b', null, (STATUS[r.status] || [r.status])[0] + '. '),
        STATUS_HELP[r.status] || r.detail || 'Nothing could be read from this website, so only your sheet is shown below.', openSiteLink)
      : null;

    // the website in the list may belong to another school: everything below would then be about someone else
    const wrongSite = r && r.identity && r.identity.ok === false
      ? h('div', { class: 'notice' }, h('b', null, 'Please check this website link. '),
        `The website (${r.identity.host || 'link above'}) never mentions “${s.name}”, so the link in your sheet may point to a different school. Please check the Website column in your sheet before using these answers.${STATIC ? '' : ' This school is left out of the all-schools Google Sheet file automatically.'}`,
        openSiteLink)
      : null;

    const urlChangedNotice = d.urlChanged && r
      ? h('div', { class: 'notice' }, h('b', null, 'The website link in your sheet changed. '),
        `These answers came from ${shortUrl(r.start)} (${ago(r.scrapedAt)}), but your sheet now points to ${shortUrl(s.website)}. `,
        STATIC ? null : 'Press “Check this website again” above to read the new link.')
      : null;

    // answers read from pages a person saved by hand (the website does not let the dashboard read it)
    const savedNotice = r && r.source === 'saved-pages' && r.savedPages
      ? h('div', { class: 'notice info' }, h('b', null, 'Read from pages saved by hand. '),
        `These answers come from ${r.savedPages.count} page${r.savedPages.count === 1 ? '' : 's'} that someone saved from the school’s website on ${new Date(r.savedPages.at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. `,
        r.lastAttempt ? `The website refused an automatic check again ${ago(r.lastAttempt.at)}, so these answers were kept. ` : '',
        'Save the pages again and press “Read these pages” to update them.')
      : null;
    // the website could not be read, but pages saved from Ravenna, Niche or a review site still answered some questions
    const websiteDown = !!(r && r.websiteStatus && r.websiteStatus.status !== 'ok');
    const otherNotice = r && r.source === 'other-sources'
      ? h('div', { class: 'notice info' }, h('b', null, 'The school’s website could not be read, so these answers come only from pages saved by hand. '),
        `They were read from ${Object.values(r.otherSources || {}).map((o) => o.label).join(', ') || 'other sites'}. `,
        'Each answer says which site it came from. Anything not shown has no answer yet.')
      : null;
    const savedPanel = !STATIC && s.website && (!r || r.status !== 'ok' || r.source === 'saved-pages' || websiteDown) ? savedPagesPanel(s, r, () => viewSchool(id, tabIndex)) : null;
    const otherPanel = otherSourcesPanel(s, r);

    // a plain-words guide to reading the page, with this school's own numbers
    const fieldRows = d.rows.filter((x) => x.kind === 'field');
    const foundN = fieldRows.filter((x) => x.scraped && x.scraped.status === 'found').length;
    const tcs = d.trustCounts;
    const guideBox = r && r.status === 'ok' ? h('details', { class: 'guide', open: true },
      h('summary', null, `How to read this page: the website answered ${foundN} of ${fieldRows.length} questions`),
      h('ul', null,
        h('li', null, 'Each question from your sheet is a row. The ', h('b', null, 'middle'), ' column is what your sheet says now. The ', h('b', null, 'right'), ' column is what the school’s own website says.'),
        tcs ? h('li', null, h('span', { class: 'trust high' }, 'Safe to use'), ` (${tcs.ready} here): the answer came from a very reliable page and is stated clearly. You can copy it without checking.`) : null,
        tcs ? h('li', null, h('span', { class: 'trust medium' }, 'Quick look'), ' and ', h('span', { class: 'trust low' }, 'Check this'), ` (${tcs.check + tcs.doubtful} here): open the school’s page and make sure it is right before you copy it.`) : null,
        h('li', null, 'Press ', h('b', null, 'Copy'), ' to copy an answer, then paste it into your sheet. Press ', h('b', null, '✓ Right'), ' or ', h('b', null, '✗ Wrong'), ' after you check an answer: it helps the dashboard learn which answers to trust.'),
        h('li', null, 'A different answer from your sheet does not mean the website is wrong. Your sheet may simply be out of date.'),
        h('li', null, 'Not sure what a label or colour means? ', helpLink('labels', 'Open the Help page'), '.'))) : null;

    const labelByKey = new Map(d.rows.filter((x) => x.kind === 'field').map((x) => [x.key, String(x.label || x.key).replace(/:$/, '')]));
    const siteChanges = r && r.changes && r.changes.length
      ? h('div', { class: 'notice info' },
        h('b', null, `The school changed its website (${r.changes.length} answer${r.changes.length === 1 ? '' : 's'} different from the last check):`),
        h('ul', { class: 'changes' }, r.changes.map((c) => {
          const fname = labelByKey.get(c.key) || c.key;
          if (c.kind === 'changed') return h('li', null, h('b', null, fname + ': '), c.before, ' → ', h('b', null, c.after));
          if (c.kind === 'added') return h('li', null, h('b', null, fname + ': '), 'newly found — ', h('b', null, c.after));
          return h('li', null, h('b', null, fname + ': '), 'no longer on the website (it used to say “' + c.before + '”)');
        })))
      : null;

    setKids(
      app,
      h('a', { class: 'crumb', href: '#/' }, '← All schools'),
      h('div', { class: 'pagehead' },
        h('div', { class: 'grow' }, h('h1', null, s.name),
          h('div', { class: 'meta' },
            s.tier != null ? h('span', null, 'Tier ' + s.tier) : null,
            s.region ? h('span', null, s.region) : null,
            s.website ? h('span', null, 'Website: ', ext(s.website)) : h('span', null, 'No website link in the list'),
            s.portal ? h('span', null, 'Application portal: ', ext(s.portal, s.portalLabel && !/^https?:/i.test(s.portalLabel) ? s.portalLabel : null)) : null,
            r ? h('span', null, `Last checked ${ago(r.scrapedAt)}; read ${r.pages.filter((p) => !p.fromSource).length} pages of the website`) : null),
          h('div', { class: 'meta' },
            tab ? h('span', null, `Tab in your sheet: “${tab.tab.trim()}”` + (tab.matchedBy !== 'exact' ? ` (found by ${tab.matchedBy}; please make sure it is the right tab)` : '')) : h('span', null, 'This school has no tab in your sheet yet'),
            d.tabs.length > 1 ? (() => {
              const el = h('select', { 'aria-label': 'Workbook tab to compare', onchange: (e) => viewSchool(id, Number(e.target.value)) }, d.tabs.map((t, i) => h('option', { value: i }, t.tab.trim())));
              el.value = String(d.tabIndex);
              return h('label', null, 'Compare with: ', el);
            })() : null)),
        h('div', { class: 'actions' }, xlsxSchoolBtn, fileBtn, d.exportConfigured ? exportBtn : null, d.exportFailing ? h('span', { class: 'muted small' }, 'One-click send is off because its last test failed (see Start here). The file download works.') : null,
          STATIC ? null : h('button', { class: 'btn primary', type: 'button', disabled: running || !s.website, title: running ? 'A check is already running' : null,
            onclick: () => startRun({ scope: 'schools', ids: [s.id] }) }, r ? 'Check this website again' : 'Check this school’s website'))),
      wrongSite, urlChangedNotice, notice, savedNotice, otherNotice, savedPanel, otherPanel, siteChanges, exportBox, canExport && !STATIC ? colourDetails() : null, guideBox, filterBox, rowsBox,
      r && r.pages.length ? h('details', { class: 'panel' }, h('summary', null, `Pages read (${r.pages.length})`),
        h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Page'), h('th', null, 'Looks like a page about'), h('th', { class: 'num' }, 'Amount of text'))),
          h('tbody', null, r.pages.map((p) => h('tr', null,
            h('td', null, p.title || '(untitled)', p.fromSource ? h('span', { class: 'chip info' }, 'saved from ' + (OTHER_LABEL[p.fromSource] || p.fromSource)) : null, h('span', { class: 'sub' }, ext(p.url))),
            h('td', { class: 'small' }, p.fromSource ? 'a page you saved by hand' : (p.topics || []).join(', ') + (p.kind === 'pdf' ? ' (PDF)' : '')),
            h('td', { class: 'num small' }, (p.chars || 0).toLocaleString() + ' characters'))))))) : null,
      r && r.skipped && r.skipped.length ? h('details', { class: 'panel' }, h('summary', null, `Pages it tried but could not read (${r.skipped.length})`),
        h('ul', null, r.skipped.map((x) => h('li', { class: 'small' }, ext(x.url), ' — ', x.reason)))) : null);
    drawFilters();
    drawRows();
  }

  // ------------------------------------------------- Google Sheet export setup ---
  function exportPanel() {
    const status = h('p', null, 'Checking…');
    const url = h('input', { type: 'text', class: 'wide', placeholder: 'https://script.google.com/macros/s/…/exec', 'aria-label': 'Web app address', autocomplete: 'off', spellcheck: 'false' });
    const token = h('input', { type: 'password', class: 'wide', placeholder: 'Secret (the same text as the EXPORT_TOKEN property in Apps Script)', 'aria-label': 'Secret', autocomplete: 'off', spellcheck: 'false' });
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const remove = h('button', { class: 'btn danger', type: 'button', hidden: true }, 'Remove saved address');
    // what is said here comes from what the last call to the address actually did, not from the address merely being saved
    const show = (c) => {
      if (!c.configured) status.textContent = 'Not set up yet. Follow the steps in docs/GOOGLE-SHEET-EXPORT.md, then fill in the two boxes below.';
      else if (c.health === 'working') status.textContent = `Working (last checked ${ago(c.lastCheckAt)}). The secret is never shown again.`;
      else if (c.health === 'failing') status.textContent = `Saved, but NOT working: ${c.lastError || 'Google did not answer correctly.'} Use “Download file for Google Sheet” instead, or remove the saved address.`;
      else status.textContent = 'Saved on this computer but not tested yet. Press “Test the connection”. The secret is never shown again.';
      status.className = c.configured && c.health === 'failing' ? 'bad' : '';
      remove.hidden = !c.configured;
      if (c.url) url.value = c.url;
    };
    api('/api/export-config').then(show).catch((e) => { status.textContent = e.message; });
    const guard = (btn, label, fn) => async () => {
      btn.disabled = true;
      try { await fn(); } catch (e) { say(e.message, true); }
      btn.disabled = false; btn.textContent = label;
    };
    remove.onclick = guard(remove, 'Remove saved address', async () => {
      if (!confirm('Remove the saved one-click address and secret from this computer?\n\nDownloading the file for the Google Sheet menu will still work.')) return;
      show(await api('/api/export-config', { clear: true }));
      url.value = ''; token.value = ''; say('Removed.');
    });
    const make = h('button', { class: 'btn', type: 'button' }, 'Make a secret');
    make.onclick = guard(make, 'Make a secret', async () => {
      const r = await api('/api/export-secret', {});
      token.type = 'text'; token.value = r.token;
      say('Copy this secret into the Apps Script property named EXPORT_TOKEN (Project Settings, Script properties), then press Save.');
    });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    save.onclick = guard(save, 'Save', async () => {
      const c = await api('/api/export-config', { url: url.value, token: token.value });
      token.value = ''; token.type = 'password'; show(c); say('Saved. Press "Test the connection" to check it.');
    });
    const test = h('button', { class: 'btn', type: 'button' }, 'Test the connection');
    test.onclick = guard(test, 'Test the connection', async () => {
      test.textContent = 'Testing…';
      try {
        const r = await api('/api/export-test', {});
        say(`Connected to “${r.sheet}” (${r.tabs} tabs). ${r.hasTemplate ? '' : 'There is no Master Template tab, so a school without a tab cannot get one. '}${r.emailConfigured ? 'Daily email recipients are set.' : 'No email recipients are set yet, so the daily email will not be sent.'}`);
      } finally { api('/api/export-config').then(show).catch(() => {}); }   // pass or fail, the status line above follows the result
    });
    return h('details', { class: 'direct' }, h('summary', null, 'Advanced: send straight to the sheet with one click'),
      h('p', { class: 'muted small' }, 'Only works if your company lets an Apps Script web app be open to “Anyone”. If the deploy screen only offers your organization, use the file above instead.'),
      status,
      h('label', { class: 'field' }, h('span', null, 'Web app address'), url),
      h('label', { class: 'field' }, h('span', null, 'Secret'), token),
      h('div', { class: 'runbtns' }, make, save, test, remove), out);
  }

  /** Downloads the file the Google Sheet's School Info menu loads. Resolves to { name, count, skipped }. */
  async function downloadExportFile(query) {
    const id = 'file-' + (++taskSeq);
    startTask(id, 'Making the file for your Google Sheet…');
    try {
      const r = await checkedFetch('/api/export-file?' + query, undefined, 'The file could not be made.');
      const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'school-info-export.json';
      triggerBlobDownload(await r.blob(), name);
      endTask(id, { title: `Saved ${name}`, message: 'It is in your Downloads folder. In your Google Sheet open School Info → Load export file… and pick it.' });
      return { name, count: Number(r.headers.get('X-Export-Count')) || 0, skipped: Number(r.headers.get('X-Export-Skipped')) || 0, wrongSite: Number(r.headers.get('X-Export-Wrong-Site')) || 0 };
    } catch (e) { dismissTask(id); throw e; }
  }

  /** Step-by-step Google Sheet menu tools and optional direct sync, kept out of the main flow. */
  function sheetFilePanel() {
    const scraped = S.ov && S.ov.ready ? S.ov.schools.filter((s) => s.status === 'ok').length : 0;
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const dlBtn = h('button', { class: 'btn', type: 'button', disabled: !scraped, title: scraped ? null : 'Scrape some schools first' },
      scraped ? `Download Google Sheet file (.json) for ${scraped} schools` : 'Scrape some schools first');
    dlBtn.onclick = async () => {
      dlBtn.disabled = true;
      try {
        const f = await downloadExportFile('all=1');
        say(`Saved “${f.name}” with ${f.count} school${f.count === 1 ? '' : 's'}${f.skipped ? ` (${f.skipped} left out: not checked yet, nothing found${f.wrongSite ? `, or ${f.wrongSite} whose website looks like a different school` : ''})` : ''}. Open your Google Sheet → School Info → Load export file…`);
      } catch (e) { say(e.message, true); }
      dlBtn.disabled = false;
    };
    const copyCodeBtn = h('button', { class: 'btn', type: 'button' }, 'Copy Apps Script code');
    copyCodeBtn.onclick = async () => {
      copyCodeBtn.disabled = true;
      try {
        const doc = await api('/api/code?file=' + encodeURIComponent('google-sheet/Code.gs'));
        const ok = await copyText(doc.content, copyCodeBtn);
        say(ok
          ? 'Copied! In your Google Sheet click Extensions → Apps Script, paste the code into a script file, Save, and reload the sheet.'
          : 'Could not copy automatically — open “View source files” below to copy manually.', !ok);
      } catch (e) { say(e.message, true); }
      copyCodeBtn.disabled = false;
    };
    return h('details', { class: 'panel' },
      h('summary', null, 'Advanced: Google Sheet “School Info” menu & direct sync'),
      h('p', { class: 'muted small' }, 'Most people can simply use the Excel (.xlsx) or CSV downloads above. If your team wants the special “School Info” menu inside Google Sheets (which highlights new cells yellow and puts suggestions in comments), follow this one-time setup:'),
      colourDetails(),
      h('p', { class: 'small' }, h('b', null, 'Set up once in your Google Sheet copy: '), 'the steps, with the script to copy, are on their own page: ', h('a', { href: '#/sheet-setup' }, 'Set up the Google Sheet menu, step by step'), '.'),
      h('div', { class: 'runbtns' }, copyCodeBtn, dlBtn), out,
      exportPanel(),
      h('p', { class: 'muted small' }, 'Want to inspect how extraction rules work? ', h('a', { href: '#/script' }, 'View source files & extraction rules'), '.'));
  }

  // ------------------------------------------------------------- start view ---
  /** Step 1: Choose or drop the .xlsx workbook. */
  function workbookPanel(onDone, canReread) {
    const out = h('p', { class: 'small' });
    const detail = h('pre', { class: 'cmd', hidden: true });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const input = h('input', { type: 'file', accept: '.xlsx', 'aria-label': 'Choose your School Information Sheet (.xlsx)', hidden: true });
    const zone = h('div', { class: 'drop', tabindex: '0', role: 'button' }, h('b', null, canReread ? 'Replace sheet (.xlsx)' : 'Choose your sheet'), h('span', null, ' or drop the .xlsx file here'));
    async function send(file) {
      if (!file) return;
      if (!/\.xlsx$/i.test(file.name)) { say('Please choose an Excel file ending in .xlsx.', true); return; }
      if (taskRunning('workbook')) { say('A sheet is already being read. It finishes in a moment.', true); return; }
      zone.classList.add('busy'); detail.hidden = true;
      say(`Reading “${file.name}”. This takes about 30 seconds. You do not have to wait here: open any other page and it keeps going.`);
      startTask('workbook', 'Loading your school sheet…', { message: file.name + '. You can keep using the dashboard.' });
      try {
        const r = await checkedFetch('/api/workbook', { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: file }, 'The upload did not work.');
        const j = await r.json().catch(() => ({}));
        await loadOverview();
        endTask('workbook', { title: 'Your school sheet is loaded', message: (S.ov && S.ov.schools ? S.ov.schools.length : 0) + ' schools are ready.', link: '#/', linkText: 'Open the school list' });
        say('Done. Your school list is ready.');
        detail.textContent = j.output || ''; detail.hidden = !j.output;
        refreshIfOn('start', 'schools', 'review', 'run');   // only the page the person is on, and only if it was waiting for the sheet
      } catch (e) {
        endTask('workbook', { failed: true, title: 'The school sheet could not be loaded', message: e.message, link: '#/start', linkText: 'Go to Start here' });
        say(e.message, true);
      } finally { zone.classList.remove('busy'); input.value = ''; }
    }
    zone.onclick = () => input.click();
    zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    input.onchange = () => send(input.files[0]);
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); send(e.dataTransfer.files[0]); };
    const reread = h('button', { class: 'btn link small', type: 'button' }, 'Re-read the file that is already loaded');
    reread.onclick = async () => {
      if (taskRunning('workbook')) return;
      reread.disabled = true; say('Reading the file again. This takes about 30 seconds. You can open other pages meanwhile.');
      startTask('workbook', 'Reading your school sheet again…', { message: 'You can keep using the dashboard.' });
      try {
        const j = await api('/api/import', {}); await loadOverview(); say('Done.'); detail.textContent = j.output || ''; detail.hidden = !j.output;
        endTask('workbook', { title: 'Your school sheet is loaded', message: (S.ov && S.ov.schools ? S.ov.schools.length : 0) + ' schools are ready.', link: '#/', linkText: 'Open the school list' });
        refreshIfOn('start', 'schools', 'review', 'run');
      } catch (e) { endTask('workbook', { failed: true, title: 'The school sheet could not be read', message: e.message }); say(e.message, true); }
      reread.disabled = false;
    };
    // coming back to this page while the sheet is still being read: show that, instead of an empty box
    const reading = taskRunning('workbook');
    if (reading) { zone.classList.add('busy'); say('Your sheet is being read. This takes about 30 seconds. You can open other pages: it keeps going, and a message appears when it is ready.'); }
    return h('div', { class: 'panel stepcard' },
      h('div', { class: 'stephead' },
        h('span', { class: 'stepnum' }, '1'),
        h('h2', null, 'Load your school sheet'),
        reading ? chip(['Reading…', 'info']) : canReread ? chip(['Done', 'ok']) : chip(['Waiting for your file', 'warn'])),
      h('p', null, 'This is the list of schools the dashboard works from. In Google Sheets click File, then Download, then Microsoft Excel (.xlsx). Then choose that file below or drag it onto the box. Your own sheet is only read. It is never changed.'),
      zone, input, out, detail, canReread ? h('p', { class: 'muted small' }, reread) : null);
  }

  /** Teammate results import dropzone (used inside Step 2). */
  function teammateImportBox() {
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const input = h('input', { type: 'file', accept: '.zip', hidden: true, 'aria-label': 'Choose a teammate’s results file' });
    const zone = h('div', { class: 'drop compact', tabindex: '0', role: 'button' }, h('b', null, 'Or add a teammate’s results file'), h('span', null, ' (.zip). Use this if a teammate has already checked the websites, so you do not have to wait.'));
    async function add(file) {
      if (!file) return;
      if (!/\.zip$/i.test(file.name)) { say('Please choose a results file (its name ends in .zip).', true); return; }
      if (taskRunning('results-import')) { say('A results file is already being added.', true); return; }
      zone.classList.add('busy');
      say(`Adding the results in “${file.name}”… You can open other pages meanwhile.`);
      startTask('results-import', 'Adding your teammate’s results…', { message: file.name });
      try {
        const r = await checkedFetch('/api/results-package', { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: file }, 'That did not work.');
        const j = await r.json().catch(() => ({}));
        const parts = [`${j.added} new`, `${j.updated} updated with newer results`];
        if (j.keptNewer) parts.push(`${j.keptNewer} left alone because yours were newer`);
        if (j.same) parts.push(`${j.same} already the same`);
        if (j.unknown) parts.push(`${j.unknown} not in your school list (${j.unknownNames.join(', ')}${j.unknown > j.unknownNames.length ? ', …' : ''})`);
        if (j.invalid) parts.push(`${j.invalid} skipped as damaged`);
        say('Added: ' + parts.join(', ') + '.' + (j.from && j.from.by ? ` From ${j.from.by}.` : ''));
        await loadOverview();
        endTask('results-import', { title: 'Your teammate’s results were added', message: parts.join(', ') + '.', link: '#/', linkText: 'Open the school list' });
        refreshIfOn('start', 'schools', 'review');
      } catch (e) {
        endTask('results-import', { failed: true, title: 'The results file was not added', message: e.message });
        say(e.message, true);
      } finally { zone.classList.remove('busy'); input.value = ''; }
    }
    zone.onclick = () => input.click();
    zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    input.onchange = () => add(input.files[0]);
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); add(e.dataTransfer.files[0]); };
    return h('div', null, zone, input, out);
  }

  /** Step 2: Check the websites, or load results shared by a teammate. */
  function gatherPanel() {
    const ov = S.ov;
    const scraped = ov && ov.ready ? ov.schools.filter((s) => s.status === 'ok').length : 0;
    const total = ov && ov.ready ? ov.schools.length : 0;
    return h('div', { class: 'panel stepcard' },
      h('div', { class: 'stephead' },
        h('span', { class: 'stepnum' }, '2'),
        h('h2', null, 'Check the school websites'),
        scraped ? chip([`${scraped} of ${total} schools checked`, 'ok']) : null),
      h('p', null, 'The dashboard opens each school’s own website, finds the answers to the questions in your sheet (tuition, class sizes, deadlines and so on), and saves them. Press the button to choose which schools to check. A teammate can also share their results with you instead.'),
      h('div', { class: 'runbtns' }, h('a', { class: 'btn primary', href: '#/run' }, scraped ? 'Check more websites' : 'Start checking websites')),
      teammateImportBox());
  }

  /** Step 3: Review findings, download plain Excel/CSV, or save a shareable results package. */
  function exportStepPanel() {
    const ov = S.ov;
    const ready = !!(ov && ov.ready);
    const scraped = ready ? ov.schools.filter((s) => s.status === 'ok').length : 0;
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const xlsxBtn = h('button', { class: 'btn', type: 'button', disabled: !ready, title: 'One Excel file with every school: your sheet next to what the websites say' }, 'Download Excel (.xlsx)');
    xlsxBtn.onclick = async () => {
      xlsxBtn.disabled = true;
      try { await downloadSpreadsheet({ format: 'xlsx', all: '1' }); say('Saved the Excel file in your Downloads folder. Open it in Excel, or upload it to Google Drive.'); }
      catch (e) { say(e.message, true); }
      xlsxBtn.disabled = false;
    };
    const csvBtn = h('button', { class: 'btn', type: 'button', disabled: !ready, title: 'The same information as a plain table that opens in any spreadsheet program' }, 'Download CSV');
    csvBtn.onclick = async () => {
      csvBtn.disabled = true;
      try { await downloadSpreadsheet({ format: 'csv', all: '1' }); say('Saved the CSV file in your Downloads folder. Open it in Excel, or import it into Google Sheets.'); }
      catch (e) { say(e.message, true); }
      csvBtn.disabled = false;
    };
    const saveZip = h('button', { class: 'btn', type: 'button', disabled: !scraped }, 'Save results for teammates (.zip)');
    saveZip.title = 'Makes one file you can send to a teammate so they do not have to check the websites again';
    saveZip.onclick = async () => {
      saveZip.disabled = true;
      try {
        const r = await checkedFetch('/api/results-package', undefined, 'The file could not be made.');
        const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'school-results.zip';
        triggerBlobDownload(await r.blob(), name);
        say(`Saved “${name}” in your Downloads folder. Send it to a teammate. It only contains what the websites said, never your sheet.`);
      } catch (e) { say(e.message, true); }
      saveZip.disabled = false;
    };
    return h('div', { class: 'panel stepcard' },
      h('div', { class: 'stephead' },
        h('span', { class: 'stepnum' }, '3'),
        h('h2', null, 'Look at the answers and use them')),
      h('p', null, 'Open any school to see what its website says next to what your sheet says, and copy answers with one click. Or download everything as a spreadsheet.'),
      h('div', { class: 'runbtns' },
        h('a', { class: 'btn primary', href: '#/' }, ready ? `Open the list of ${ov.schools.length} schools` : 'Open the list of schools'),
        xlsxBtn, csvBtn, saveZip),
      out,
      STATIC ? null : h('p', { class: 'small' }, h('b', null, 'Want the answers inside your Google Sheet? '), h('a', { href: '#/sheet-setup' }, 'Set up the Google Sheet menu, step by step'), ' (about 5 minutes, once).'),
      STATIC ? null : colourDetails());
  }

  async function viewStart() {
    app.replaceChildren(h('p', { class: 'loading' }, 'Checking…'));
    const setup = await api('/api/setup');
    const items = setup.items || [];
    const LABEL = { ok: ['Ready', 'ok'], todo: ['To do', 'warn'], optional: ['Optional', ''], info: ['Note', 'info'] };
    const todo = items.filter((i) => i.status === 'todo');
    const row = (i) => h('li', { class: 'check-item' },
      h('span', { class: 'chip ' + LABEL[i.status][1] }, LABEL[i.status][0]),
      h('div', null, h('b', null, i.title), h('span', { class: 'sub' }, i.detail), i.action && i.status !== 'ok' ? h('span', { class: 'next' }, '→ ' + i.action) : null));
    const checklistBlock = todo.length
      ? h('ul', { class: 'checklist' }, items.map(row))
      : h('details', { class: 'panel' },
          h('summary', null, 'Is everything set up? Yes, everything is ready.'),
          h('p', { class: 'muted small' }, setup.dataDir ? `Your saved results are kept on this computer in: ${setup.dataDir}` : null),
          h('ul', { class: 'checklist' }, items.map(row)));
    app.replaceChildren(
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Start here'),
        h('p', null, todo.length ? `${todo.length} thing${todo.length === 1 ? '' : 's'} left to set up. Then follow the 3 steps below.` : 'This dashboard reads private schools’ own websites and fills in the answers to the questions in your School Information Sheet. Follow the 3 steps below. New here? Open the Help page at the top for a short guide.'))),
      nextStepCard(),
      checklistBlock,
      workbookPanel(() => viewStart(), !!(S.ov && S.ov.ready)),
      gatherPanel(),
      exportStepPanel(),
      sheetFilePanel());
  }

  // --------------------------------------------------------------- run view ---
  let runUi = null;
  function formatEta(j) {
    if (!j || !j.running || !j.schools) return '';
    if (!j.done || !j.startedAt) return 'Estimating time remaining after the first school finishes…';
    if (j.done >= j.schools) return 'Finishing up the last school…';
    const elapsed = Date.now() - j.startedAt;
    if (elapsed < 10000) return 'Estimating time remaining…';
    const remMs = Math.max(0, Math.round((elapsed / j.done) * (j.schools - j.done)));
    const mins = Math.round(remMs / 60000);
    if (mins < 1) return 'Less than a minute remaining';
    if (mins < 60) return `About ${mins} minute${mins === 1 ? '' : 's'} remaining`;
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    return `About ${hrs} hour${hrs === 1 ? '' : 's'}${remM ? ` ${remM}m` : ''} remaining`;
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function schedulePanel() {
    const badge = h('span', null, chip(['Loading…', '']));
    const enabled = h('input', { type: 'checkbox' });
    const scopeSel = h('select', { 'aria-label': 'Which schools' }, [
      ['tier1', 'Tier 1 schools'],
      ['tier2', 'Tier 2 schools'],
      ['tier3', 'Tier 3 schools'],
      ['pending', 'Schools not checked yet'],
      ['all', 'All schools'],
    ].map(([v, t]) => h('option', { value: v }, t)));
    const freqSel = h('select', { 'aria-label': 'How often' }, [
      ['daily', 'Every day'],
      ['weekly', 'Every week'],
      ['biweekly', 'Every 2 weeks'],
      ['monthly', 'Every month'],
    ].map(([v, t]) => h('option', { value: v }, t)));
    const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dowSel = h('select', { 'aria-label': 'Day of week' }, DAYS.map((d, i) => h('option', { value: String(i) }, d)));
    const domSel = h('select', { 'aria-label': 'Day of month' }, Array.from({ length: 28 }, (_, i) => h('option', { value: String(i + 1) }, `Day ${i + 1}`)));
    const dayField = h('label', { class: 'field' });
    const fmtHour = (hr) => (hr === 0 ? '12:00 AM' : hr < 12 ? `${hr}:00 AM` : hr === 12 ? '12:00 PM' : `${hr - 12}:00 PM`);
    const hourSel = h('select', { 'aria-label': 'Time of day' }, Array.from({ length: 24 }, (_, hr) => h('option', { value: String(hr) }, fmtHour(hr))));
    const missedSel = h('select', { 'aria-label': 'If missed while PC was off' }, [
      ['ask', 'Ask me when the dashboard opens'],
      ['run', 'Check straight away'],
      ['skip', 'Skip it and wait for the next time'],
    ].map(([v, t]) => h('option', { value: v }, t)));
    const refreshOpt = h('input', { type: 'checkbox', checked: true });
    const overdueBox = h('div', { class: 'notice', hidden: true });
    const winTaskBox = h('div', { class: 'sched-task', hidden: true });
    const summaryLine = h('p', { class: 'small muted' });
    const out = h('p', { class: 'small' });
    const say = (m, bad) => { out.textContent = m; out.className = 'small ' + (bad ? 'bad' : 'good'); };

    function syncDayPicker() {
      const f = freqSel.value;
      if (f === 'daily') {
        dayField.hidden = true;
      } else if (f === 'monthly') {
        dayField.hidden = false;
        dayField.replaceChildren(h('span', null, 'Day of month'), domSel);
      } else {
        dayField.hidden = false;
        dayField.replaceChildren(h('span', null, 'Day of week'), dowSel);
      }
    }
    freqSel.onchange = syncDayPicker;

    function applyState(st) {
      badge.replaceChildren(st.enabled ? chip(['Active', 'ok']) : chip(['Off', '']));
      enabled.checked = !!st.enabled;
      scopeSel.value = st.scope || 'tier1';
      freqSel.value = st.frequency || 'weekly';
      dowSel.value = String(st.dayOfWeek ?? 0);
      domSel.value = String(st.dayOfMonth ?? 1);
      hourSel.value = String(st.hour ?? 2);
      missedSel.value = st.missedPolicy || 'ask';
      refreshOpt.checked = st.refresh !== false;
      syncDayPicker();
      const parts = [];
      if (st.enabled && st.nextRunAt) parts.push(`Next scheduled check: ${fmtWhen(st.nextRunAt)}`);
      else parts.push('Automatic checking is turned off.');
      if (st.lastRunAt && st.lastSummary) {
        const sm = st.lastSummary;
        parts.push(`Last automatic check (${ago(st.lastRunAt)}): ${sm.schools || 0} schools checked, ${sm.updatedSchools || 0} had changes on their website.`);
      }
      summaryLine.textContent = parts.join(' ');

      if (st.overdue) {
        const runMissed = h('button', { class: 'btn primary', type: 'button' }, 'Run missed check now');
        const skipMissed = h('button', { class: 'btn', type: 'button' }, 'Skip until next schedule');
        runMissed.onclick = async () => {
          runMissed.disabled = true; skipMissed.disabled = true;
          try {
            const next = await api('/api/schedule/missed', { action: 'run' });
            applyState(next);
            S.log = []; poll(true);
            say('Started overdue scheduled check.');
          } catch (e) { say(e.message, true); runMissed.disabled = false; skipMissed.disabled = false; }
        };
        skipMissed.onclick = async () => {
          runMissed.disabled = true; skipMissed.disabled = true;
          try {
            const next = await api('/api/schedule/missed', { action: 'skip' });
            applyState(next);
            say(next.nextRunAt ? `Skipped missed slot. Next check: ${fmtWhen(next.nextRunAt)}.` : 'Skipped.');
          } catch (e) { say(e.message, true); runMissed.disabled = false; skipMissed.disabled = false; }
        };
        setKids(overdueBox, h('b', null, `Missed scheduled check (${fmtWhen(st.nextRunAt)}). `),
          'The computer or the dashboard was off at that time.', h('div', { class: 'runbtns' }, runMissed, skipMissed));
        overdueBox.hidden = false;
      } else {
        overdueBox.hidden = true;
      }

      if (st.windowsTask && st.windowsTask.supported) {
        const installed = !!st.windowsTask.installed;
        const tBtn = h('button', { class: 'btn', type: 'button' }, installed ? 'Remove Windows background task' : 'Let Windows run the checks in the background');
        tBtn.onclick = async () => {
          tBtn.disabled = true;
          try {
            const wt = await api('/api/schedule/windows-task', { action: installed ? 'remove' : 'install' });
            applyState({ ...st, windowsTask: wt });
            say(wt.installed ? 'Done. Windows will now run the scheduled checks quietly, even when the dashboard is closed (while you are signed in).' : 'The Windows background option is turned off.');
          } catch (e) { say(e.message, true); tBtn.disabled = false; }
        };
        setKids(winTaskBox,
          chip([installed ? 'Runs in the background' : 'Only while the dashboard is open', installed ? 'ok' : '']),
          h('span', { class: 'small muted' }, installed ? 'Windows runs the checks quietly even when the dashboard is closed.' : 'Optional: let Windows run the checks even when the dashboard is closed.'),
          tBtn);
        winTaskBox.hidden = false;
      } else {
        winTaskBox.hidden = true;
      }
    }

    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save schedule');
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const st = await api('/api/schedule', {
          enabled: enabled.checked,
          scope: scopeSel.value,
          frequency: freqSel.value,
          dayOfWeek: Number(dowSel.value),
          dayOfMonth: Number(domSel.value),
          hour: Number(hourSel.value),
          minute: 0,
          missedPolicy: missedSel.value,
          refresh: refreshOpt.checked,
        });
        applyState(st);
        say(st.enabled && st.nextRunAt ? `Saved! Next check is set for ${fmtWhen(st.nextRunAt)}.` : 'Schedule saved (turned off).');
      } catch (e) { say(e.message, true); }
      saveBtn.disabled = false;
    };

    syncDayPicker();
    api('/api/schedule').then(applyState).catch((e) => { summaryLine.textContent = e.message; });

    return h('div', { class: 'panel' },
      h('div', { class: 'stephead' }, h('h2', null, 'Auto-check schedule'), badge),
      h('p', null, 'Let the dashboard check the websites by itself on a schedule, and point out any school whose website answers changed since the last check. This only works while this dashboard is open on this computer.'),
      overdueBox,
      h('label', { class: 'check' }, enabled, 'Check the websites automatically'),
      h('div', { class: 'formrow' },
        h('label', { class: 'field' }, h('span', null, 'Which schools'), scopeSel),
        h('label', { class: 'field' }, h('span', null, 'How often'), freqSel),
        dayField,
        h('label', { class: 'field' }, h('span', null, 'Time'), hourSel),
        h('label', { class: 'field' }, h('span', null, 'If the computer was off at that time'), missedSel)),
      h('label', { class: 'check' }, refreshOpt, 'Always read the websites again from scratch, so changes are never missed (recommended)'),
      summaryLine,
      h('div', { class: 'runbtns' }, saveBtn),
      out,
      winTaskBox,
      h('p', { class: 'muted small' }, 'Checks happen while this dashboard is open. To let Windows run them even when the dashboard is closed, use the background option above (if shown).'));
  }

  function slackPanel() {
    const badge = h('span', null, chip(['Checking…', '']));
    const webhook = h('input', { type: 'password', class: 'wide', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Slack webhook URL' });
    const modeSel = h('select', { 'aria-label': 'When to notify Slack' }, [
      ['scheduled', 'Only the automatic checks'],
      ['all', 'Every check (automatic and manual)'],
      ['off', 'Off (paused)'],
    ].map(([v, t]) => h('option', { value: v }, t)));
    const onlyChanges = h('input', { type: 'checkbox', checked: true });
    const metaLine = h('p', { class: 'small muted' });
    const out = h('p', { class: 'small' });
    const say = (m, bad) => { out.textContent = m; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save Slack settings');
    const testBtn = h('button', { class: 'btn', type: 'button' }, 'Send test message');
    const clearBtn = h('button', { class: 'btn', type: 'button', hidden: true }, 'Remove webhook');

    function applyState(st) {
      badge.replaceChildren(st.configured ? chip(['Connected', 'ok']) : chip(['Not connected', '']));
      webhook.disabled = !!st.locked;
      webhook.placeholder = st.locked
        ? 'Configured on the server (SLACK_WEBHOOK_URL)'
        : st.configured
          ? `Saved (${st.maskedUrl}). Paste a new link to replace it.`
          : 'https://hooks.slack.com/services/...';
      modeSel.value = st.notifyOn || 'scheduled';
      onlyChanges.checked = st.onlyIfChanges !== false;
      testBtn.disabled = !st.configured;
      clearBtn.hidden = !st.configured || !!st.locked;
      const notes = [];
      if (st.lastSentAt) notes.push(`Last alert sent ${ago(st.lastSentAt)}.`);
      if (st.lastError) notes.push(`Last error: ${st.lastError}`);
      metaLine.textContent = notes.join(' ');
    }

    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const body = { notifyOn: modeSel.value, onlyIfChanges: onlyChanges.checked };
        if (webhook.value.trim()) body.webhookUrl = webhook.value.trim();
        const st = await api('/api/slack-config', body);
        webhook.value = '';
        applyState(st);
        say(st.configured ? 'Slack settings saved. Click “Send test message” to verify your channel receives it.' : 'Settings saved (paste a Slack webhook link above when ready).');
      } catch (e) { say(e.message, true); }
      saveBtn.disabled = false;
    };

    testBtn.onclick = async () => {
      testBtn.disabled = true;
      try {
        const st = await api('/api/slack-test', {});
        applyState(st);
        say('Test message sent! Check your Slack channel.');
      } catch (e) { say(e.message, true); }
      testBtn.disabled = false;
    };

    clearBtn.onclick = async () => {
      if (!confirm('Remove the saved Slack webhook URL?')) return;
      clearBtn.disabled = true;
      try {
        const st = await api('/api/slack-config', { clearWebhook: true });
        webhook.value = '';
        applyState(st);
        say('Slack webhook removed.');
      } catch (e) { say(e.message, true); }
      clearBtn.disabled = false;
    };

    api('/api/slack-config').then(applyState).catch((e) => { metaLine.textContent = e.message; });

    return h('div', { class: 'panel' },
      h('div', { class: 'stephead' }, h('h2', null, 'Slack notifications'), badge),
      h('p', null, 'Get a Slack message listing every school whose website answers changed. Someone who manages your Slack needs to create a “webhook link” for the channel (it is a private web address that lets this dashboard post there). Paste that link below. Never share it in chat or email.'),
      h('label', { class: 'field' }, h('span', null, 'Slack webhook link'), webhook),
      h('div', { class: 'formrow' },
        h('label', { class: 'field' }, h('span', null, 'When to send a Slack message'), modeSel)),
      h('label', { class: 'check' }, onlyChanges, 'Only send a message when at least one school’s website really changed'),
      metaLine,
      h('div', { class: 'runbtns' }, saveBtn, testBtn, clearBtn),
      out);
  }

  function viewRun() {
    const ov = S.ov;
    const n = (f) => (ov.ready ? ov.schools.filter(f).length : 0);
    const refresh = h('input', { type: 'checkbox', id: 'refresh' });
    // Choosing a group only selects it. Nothing starts until "Start checking" is pressed.
    const SCOPES = [
      { key: 'tier1', label: 'Tier 1', count: n((s) => s.tier === 1), body: { scope: 'tier', tier: 1 } },
      { key: 'tier2', label: 'Tier 2', count: n((s) => s.tier === 2), body: { scope: 'tier', tier: 2 } },
      { key: 'tier3', label: 'Tier 3', count: n((s) => s.tier === 3), body: { scope: 'tier', tier: 3 } },
      { key: 'pending', label: 'Not checked yet', count: n((s) => s.status === 'not-scraped'), body: { scope: 'pending' } },
      { key: 'all', label: 'All schools', count: ov.ready ? ov.schools.length : 0, body: { scope: 'all' } },
    ];
    const pickOf = () => SCOPES.find((sc) => sc.key === S.runPick && sc.count > 0) || null;
    const pickSummary = h('p', { class: 'pick-summary' });
    const startBtn = h('button', { class: 'btn primary', type: 'button', 'data-run': '1', 'data-empty': '1', disabled: true }, 'Start checking');
    const pills = SCOPES.map((sc) => h('button', {
      class: 'scope-pill', type: 'button', 'data-run': '1', 'data-empty': !sc.count ? '1' : null, disabled: !sc.count,
      'aria-pressed': String(S.runPick === sc.key),
      onclick: () => { S.runPick = S.runPick === sc.key ? null : sc.key; drawPick(); },
    }, `${sc.label} (${sc.count})`));
    const drawPick = () => {
      const p = pickOf();
      SCOPES.forEach((sc, i) => pills[i].setAttribute('aria-pressed', String(!!p && p.key === sc.key)));
      const running = !!(S.job && S.job.running);
      startBtn.dataset.empty = p ? '0' : '1';
      startBtn.disabled = running || !p;
      startBtn.textContent = p ? `Start checking ${p.label} (${p.count})` : 'Start checking';
      pickSummary.textContent = p
        ? `You chose: ${p.label}, ${p.count} school${p.count === 1 ? '' : 's'}. Nothing has started yet. Press Start checking when you are ready.`
        : 'Pick a group above, then press Start checking. Nothing starts until you do.';
    };
    startBtn.onclick = () => {
      const p = pickOf();
      if (!p) return;
      startRun({ ...p.body, refresh: refresh.checked });
      S.runPick = null; drawPick();   // the choice is used up, so a second press cannot start the same run again by accident
    };
    const status = h('p', null);
    const eta = h('p', { class: 'eta', hidden: true });
    const bar = h('i');
    const active = h('ul', { class: 'active' });
    const logBox = h('div', { class: 'log', role: 'log', 'aria-live': 'off' });
    const stop = h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Stop checking websites? Schools that are already finished stay saved.')) { await api('/api/stop', {}); poll(true); } } }, 'Stop');
    runUi = { status, eta, bar, active, logBox, stop, shown: 0 };

    app.replaceChildren(
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Check websites'),
        h('p', null, 'The dashboard opens each school’s own public website, one page at a time and politely, and saves the answers it finds. Then you can look at them, copy them, or download them.'))),
      h('div', { class: 'panel' }, h('h2', null, 'Choose which schools to check, then start'),
        h('p', { class: 'muted small' }, 'Tier is the priority group from your sheet (Tier 1 is the most important). A big group can take an hour or more, and the time shown below gets more accurate as schools finish. Keep this computer awake while it works. ', helpLink('status', 'What does Tier mean?')),
        ov.ready ? [
          h('div', { class: 'pickrow', role: 'group', 'aria-label': 'Which schools to check' }, pills),
          h('label', { class: 'check', for: 'refresh' }, refresh, 'Read every website again from scratch (slower). Leave this unticked to reuse pages read in the last 7 days.'),
          pickSummary,
          h('div', { class: 'runbtns' }, startBtn),
          h('p', { class: 'muted small' }, 'The dashboard works on several schools at the same time, but only opens one page at a time from each school, so it never overloads a website. You can keep looking at schools in another tab while it works. Press Stop at any time: schools that are already finished stay saved.'),
        ] : taskRunning('workbook') ? h('p', null, 'Your school sheet is loading. This page is ready as soon as it finishes: you can stay here.')
          : h('p', null, 'Load your sheet first on the ', h('a', { href: '#/start' }, 'Start here'), ' page.')),
      h('div', { class: 'panel' },
        h('h2', null, 'Progress'),
        status, eta,
        h('div', { class: 'progress' }, bar),
        stop, active,
        h('details', { class: 'direct' }, h('summary', null, 'Show the detailed activity log (only needed if something goes wrong)'), logBox)),
      schedulePanel(),
      slackPanel(),
      h('details', { class: 'panel' }, h('summary', null, 'What does the dashboard do when it checks a website?'),
        h('ul', null,
          h('li', null, 'It reads only the school’s own public website and the PDFs that website links to (fact sheets, school profiles). It never uses other sites such as Niche.'),
          h('li', null, 'It follows fixed, clear rules. It does not guess, and it does not use AI to make up answers. Every answer shows the page and the exact words it came from.'),
          h('li', null, 'It follows each website’s rules and waits politely between pages. Websites that stop automatic visits are marked “Website blocked us”, so you can open them yourself.'),
          h('li', null, 'It cannot log in to application portals (such as Ravenna or Gateway), so details behind a login stay blank unless your sheet already has them.'),
          h('li', null, 'It never changes your Google Sheet or your Excel file.'))));
    drawPick();
    drawJob();
  }

  function drawJob() {
    if (!runUi || S.view !== 'run') return;
    const j = S.job || { running: false };
    // while a check runs (or when a group has no schools, or nothing is chosen) the group buttons and the Start button are off
    document.querySelectorAll('[data-run]').forEach((b) => { b.disabled = !!j.running || b.dataset.empty === '1'; });
    runUi.stop.hidden = !j.running;
    if (j.running) runUi.status.textContent = `Checking ${j.label}: ${j.done} of ${j.schools || '?'} schools finished (${j.sitesDone} of ${j.sites || '?'} websites).`;
    else if (j.label) runUi.status.textContent = `${j.stopped ? 'Stopped' : j.exitCode ? 'Ended with an error' : 'Finished'}: ${j.label} (${j.done} of ${j.schools} schools finished).`;
    else runUi.status.textContent = 'Nothing is running right now.';
    const etaText = formatEta(j);
    runUi.eta.textContent = etaText;
    runUi.eta.hidden = !etaText;
    runUi.bar.style.width = j.schools ? Math.round((j.done / j.schools) * 100) + '%' : '0%';
    runUi.active.replaceChildren(...(j.active || []).map((a) =>
      h('li', null, h('b', null, a.schools.join(', ')), ` — reading ${shortUrl(a.start)} (${a.pages} page${a.pages === 1 ? '' : 's'} read so far)`)));
    const fresh = S.log.filter((l) => l.n > runUi.shown);
    if (runUi.shown && S.log.length && S.log[0].n > runUi.shown + 1 && !fresh.length) runUi.logBox.replaceChildren();
    const atEnd = runUi.logBox.scrollTop + runUi.logBox.clientHeight >= runUi.logBox.scrollHeight - 30;
    if (fresh.length) { const ph = runUi.logBox.querySelector('.placeholder'); if (ph) ph.remove(); }
    for (const l of fresh) {
      runUi.logBox.append(h('div', { class: l.kind }, h('time', null, clock(l.t)), l.text));
      runUi.shown = l.n;
    }
    if (!S.log.length) runUi.logBox.replaceChildren(h('div', { class: 'muted placeholder' }, 'The log of the latest run appears here.'));
    else if (fresh.length && atEnd) runUi.logBox.scrollTop = runUi.logBox.scrollHeight;
  }

  // ------------------------------------------------------------ script view ---
  async function viewScript(file) {
    app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
    const list = await api('/api/code');
    const current = list.files.some((f) => f.file === file) ? file : (list.files.find((f) => f.file === 'src/scrape.js') || list.files[0]).file;
    const doc = await api('/api/code?file=' + encodeURIComponent(current));
    const info = list.files.find((f) => f.file === current);
    const groups = [];
    for (const f of list.files) {
      const name = f.group || 'Files';
      let g = groups.find((x) => x.name === name);
      if (!g) groups.push(g = { name, files: [] });
      g.files.push(f);
    }
    const copy = h('button', { class: 'btn', type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(doc.content); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy this file'; }, 1500);
    } }, 'Copy this file');
    app.replaceChildren(
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'The script'),
        h('p', null, STATIC ? 'The exact code that gathered these results. It is plain JavaScript (Node.js) and runs on the computer that holds the workbook, not on this page.'
          : 'The exact code that runs when you press a button on the Check websites page. This page is for IT staff: you never need it to use the dashboard.'))),
      h('div', { class: 'panel' }, h('h2', null, STATIC ? 'How it is run' : 'Run it without the dashboard'),
        h('p', { class: 'muted small' }, 'From a terminal opened in the school-info-scraper folder:'),
        h('pre', { class: 'cmd' }, 'node src/scrape.js --tier 1\nnode src/scrape.js --school "Castilleja (Upper) School"\nnode src/scrape.js --pending\nnode src/scrape.js --all\nnode src/import-workbook.js     (after the workbook changes)\nnode src/setup-check.js         (what is ready and what is not)\nnode src/server.js              (the live dashboard)\nnode deploy/build-static.js     (a read-only copy like this one)'),
        h('p', { class: 'muted small' }, `Current settings: ${list.config.crawl.parallelSites} websites at a time, ${list.config.crawl.delayMs / 1000}s pause between pages, up to ${list.config.crawl.maxPagesPerSite} pages and ${list.config.crawl.maxPdfsPerSite} PDFs per website, pages kept for ${list.config.crawl.cacheDays} days. Change them in config.json.`)),
      h('div', { class: 'codewrap' },
        h('ul', { class: 'files' }, groups.map((g) => [
          h('li', { class: 'grouphead' }, g.name),
          g.files.map((f) => h('li', null, h('button', { type: 'button', 'aria-current': String(f.file === current), onclick: () => { location.hash = '#/script/' + f.file; } }, f.file, h('span', null, f.lines + ' lines')))),
        ])),
        h('div', null,
          h('div', { class: 'codehead' }, h('p', null, h('b', null, current), ' — ', info.note), copy),
          h('pre', { class: 'code', tabindex: '0' }, doc.content.replace(/\n$/, '').split('\n').map((line) => h('span', null, line || ' '))))));
  }

  // ----------------------------------------------------------------- ask view ---
  // A chat that answers from the saved school data. The AI only reads: anything that would change something
  // arrives as a button that the person presses. Replies are inserted as text, never as HTML, and only
  // http(s) links and links to a school page in this dashboard are made clickable.
  const ASK = { id: null, items: [], memories: [], sessions: [], loadedOnce: false, busy: false, status: null, ctrl: null, draft: '', effort: null };
  let askUi = null;
  const SUGGESTIONS = [
    { tag: 'Differences', q: 'Which schools differ most from my sheet?' },
    { tag: 'Fill blanks', q: 'What can the websites fill into blank sheet cells?' },
    { tag: 'Coverage', q: 'How many Tier 1 schools have not been checked yet?' },
    { tag: 'Check links', q: 'Which school websites in the list look wrong?' },
  ];

  function inlineMd(text) {
    const out = [];
    const re = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1] != null) out.push(h('b', null, m[1]));
      else if (m[2] != null) out.push(h('code', null, m[2]));
      else if (/^#\/school\/[\w.%-]+$/.test(m[4])) out.push(h('a', { href: m[4] }, m[3]));
      else if (safeUrl(m[4])) out.push(ext(m[4], m[3]));
      else out.push(m[3]);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  /** A small, safe subset of Markdown: paragraphs, lists, tables, headings, code, bold and links. */
  function renderMd(src) {
    const lines = String(src).replace(/\r/g, '').split('\n');
    const out = [];
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));   // "\|" is a pipe inside a cell
    const blockStart = /^(```|#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/;
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (/^```/.test(line)) {
        const code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        i++; out.push(h('pre', { class: 'cmd' }, code.join('\n'))); continue;
      }
      if (isRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const head = cells(line), rows = [];
        for (i += 2; i < lines.length && isRow(lines[i]); i++) rows.push(cells(lines[i]));
        out.push(h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, head.map((c) => h('th', null, inlineMd(c))))),
          h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, inlineMd(c)))))))));
        continue;
      }
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      if (heading) { out.push(h('h3', null, inlineMd(heading[1]))); i++; continue; }
      const bullet = /^\s*[-*]\s+/, numbered = /^\s*\d+[.)]\s+/;
      if (bullet.test(line) || numbered.test(line)) {
        const re = bullet.test(line) ? bullet : numbered, items = [];
        for (; i < lines.length && re.test(lines[i]); i++) items.push(lines[i].replace(re, ''));
        out.push(h(re === bullet ? 'ul' : 'ol', null, items.map((t) => h('li', null, inlineMd(t))))); continue;
      }
      const para = [line];
      for (i++; i < lines.length && lines[i].trim() && !blockStart.test(lines[i]); i++) para.push(lines[i]);
      out.push(h('p', null, inlineMd(para.join(' '))));
    }
    return out;
  }

  const money = (n) => '$' + (n > 0 && n < 0.01 ? '0.01' : n.toFixed(2));
  function usageLine(u) {
    const lookups = u.steps - (u.searches || 0);
    const parts = [lookups > 0 ? `${lookups} lookup${lookups === 1 ? '' : 's'}` : (u.searches ? '' : 'direct answer')];
    if (u.searches) parts.push(`${u.searches} web search${u.searches === 1 ? '' : 'es'}`);
    if (u.effort && u.tracked && !(ASK.status && ASK.status.locked && ASK.status.locked.effort)) parts.push(`${u.effort} effort`);
    parts.push(u.tracked ? `~${money(u.cost)}` : `${(u.inputTokens + u.outputTokens).toLocaleString()} tokens (untracked)`);
    return parts.filter(Boolean).join(' · ');
  }

  function proposalCard(p) {
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: p.state && p.state !== 'idle' }, p.state === 'working' ? 'Working…' : p.state === 'done' ? 'Done' : p.button);
    btn.onclick = async () => {
      if (p.state === 'working' || p.state === 'done') return;
      p.state = 'working'; p.message = null; drawChat();
      try {
        if (p.kind === 'scrape') {
          await api('/api/run', p.body);
          p.state = 'done'; p.message = 'Started. Watch it on the Check websites page.';
          S.log = []; location.hash = '#/run'; poll(true);
        } else if (p.kind === 'add-school') {
          // the same route as the Add a school panel, with the same checks: the server refuses a duplicate or a bad address
          const r = await api('/api/schools/add', p.body);
          await loadOverview();
          p.state = 'done'; p.message = `Added “${r.school.name}” to the Schools list.`; p.link = '#/school/' + encodeURIComponent(r.school.id);
        } else if (p.kind === 'spreadsheet') {
          const f = await downloadSpreadsheet(Object.fromEntries(new URLSearchParams(p.query || '')));
          p.state = 'done'; p.message = `Downloaded “${f.name}” (${f.count} school${f.count === 1 ? '' : 's'}).`;
        } else {
          const f = await downloadExportFile(p.query);
          p.state = 'done'; p.message = `Saved “${f.name}” with ${f.count} school${f.count === 1 ? '' : 's'}. Now open your Google Sheet, School Info menu, Load export file...`;
        }
      } catch (e) { p.state = 'idle'; p.message = e.message; p.bad = true; }
      drawChat();
    };
    return h('div', { class: 'proposal' }, h('b', null, p.title), h('p', { class: 'small muted' }, p.detail),
      h('div', { class: 'runbtns' }, btn), p.message ? h('p', { class: 'small ' + (p.bad ? 'bad' : 'good') }, p.message, p.link ? [' ', h('a', { href: p.link }, 'Open the school')] : null) : null);
  }

  function memoryBadgeText(m) {
    if (!m || !Array.isArray(m.items)) return '';
    if (m.action === 'added' && m.items[0]) {
      const prefix = m.auto ? 'Auto-learned for future chats: ' : (m.duplicate ? 'Already in memory: ' : 'Saved to memory: ');
      return prefix + m.items[0].note;
    }
    if (m.action === 'removed') return m.items.length ? `Removed ${m.items.length} note${m.items.length === 1 ? '' : 's'} from memory` : 'No matching saved notes found';
    return '';
  }

  function pinToMemoryInput(rawText) {
    if (!askUi || !askUi.memPanel) return;
    const lines = String(rawText || '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').split(/\r?\n/)
      .map((l) => l.replace(/^[\s>*#|-]+/, '').replace(/[*`]/g, '').trim())
      .filter((l) => l.length > 8 && !/^[-:|]+$/.test(l));
    const summary = (lines[0] || String(rawText || '')).replace(/\s+/g, ' ').trim().slice(0, 280);
    askUi.memPanel.open = true;
    drawBar();
    const inp = askUi.memPanel.querySelector('.memadd input[type=text]');
    if (inp) { inp.value = summary; inp.focus(); }
  }

  function turnView(t) {
    const memTags = Array.isArray(t.memory) ? t.memory.map(memoryBadgeText).filter(Boolean) : [];
    const doneOk = !!(t.text && !t.pending && !t.error);
    const copyAnsBtn = doneOk ? h('button', { class: 'btn copybtn', type: 'button', title: 'Copy answer as plain text' }, 'Copy') : null;
    if (copyAnsBtn) copyAnsBtn.onclick = () => copyText(t.text, copyAnsBtn);
    const pinBtn = doneOk
      ? h('button', { class: 'btn copybtn', type: 'button', title: 'Review and save a takeaway from this answer to Ask memory', onclick: () => pinToMemoryInput(t.text) }, 'Pin note')
      : null;
    const stepsEl = t.steps.length
      ? (t.pending
        ? h('ul', { class: 'steps' }, t.steps.map((s) => h('li', { class: s.done ? (s.ok ? 'done' : 'failed') : 'running' }, s.label)))
        : h('details', { class: 'steps-summary' },
            h('summary', null, `Checked ${t.steps.length} source${t.steps.length === 1 ? '' : 's'}`),
            h('ul', { class: 'steps' }, t.steps.map((s) => h('li', { class: s.done ? (s.ok ? 'done' : 'failed') : 'running' }, s.label)))))
      : null;
    return h('div', { class: 'msg bot' },
      memTags.map((txt) => h('p', { class: 'memtag' }, txt)),
      stepsEl,
      t.note ? h('p', { class: 'small muted' }, t.note) : null,
      t.text ? h('div', { class: 'answer' }, renderMd(t.text)) : (t.pending && !t.error ? h('p', { class: 'muted small' }, t.steps.length ? 'Working it out…' : 'Thinking…') : null),
      t.sources && t.sources.length ? h('div', { class: 'sources' }, h('p', { class: 'small muted' }, 'Web sources (not the school’s own site):'),
        h('ul', null, t.sources.map((s) => h('li', null, ext(s.url, s.title || null))))) : null,
      (t.proposals || []).map(proposalCard),
      t.error ? h('div', { class: 'notice' }, t.error) : null,
      (t.usage || copyAnsBtn || pinBtn) ? h('div', { class: 'usage-row' },
        t.usage ? h('p', { class: 'usage small muted' }, usageLine(t.usage)) : null,
        copyAnsBtn, pinBtn) : null);
  }

  const EFFORT_INFO = {
    low: ['Low', 'Low — fastest, light thinking'],
    medium: ['Medium', 'Medium — balanced (locked default)'],
    high: ['High', 'High — deeper thinking on hard questions'],
    xhigh: ['XHigh', 'XHigh — extra-deep thinking'],
    max: ['Max', 'Max — deepest thinking, slowest and costliest'],
  };

  function effortOptions(selected, long) {
    const ids = (ASK.status && ASK.status.efforts) || Object.keys(EFFORT_INFO);
    return ids.map((id) => {
      const info = EFFORT_INFO[id];
      return h('option', { value: id, selected: id === selected }, info ? info[long ? 1 : 0] : id);
    });
  }

  function syncEffort() {
    if (!askUi || !ASK.status) return;
    const st = ASK.status;
    const isClaude = st.provider === 'anthropic';
    const ids = st.efforts || Object.keys(EFFORT_INFO);
    const locked = !!(st.locked && (st.locked.effort || st.locked.costPolicy));
    if (locked || !ASK.effort || !ids.includes(ASK.effort)) ASK.effort = st.effort || 'medium';
    askUi.effortWrap.hidden = !isClaude || locked;
    if (locked) {
      askUi.effort.disabled = true;
      return;
    }
    if (Array.from(askUi.effort.options, (o) => o.value).join(',') !== ids.join(',')) {
      askUi.effort.replaceChildren(...effortOptions(ASK.effort, false));
    }
    if (askUi.effort.value !== ASK.effort) askUi.effort.value = ASK.effort;
    askUi.effort.disabled = ASK.busy || !isClaude;
    askUi.effortWrap.title = 'How long Claude thinks before answering.';
  }

  function drawChat() {
    if (!askUi || S.view !== 'ask') return;
    const st = ASK.status;
    const items = ASK.items.map((it) => (it.role === 'user' ? h('div', { class: 'msg user' }, it.text) : turnView(it)));
    if (!items.length) {
      items.push(h('div', { class: 'ask-welcome' },
        h('h2', null, st && st.ready ? 'Ask about your schools & sheet' : 'Connect Claude in Settings to enable Ask'),
        h('p', { class: 'small muted' }, st && st.ready
          ? (st.webSearchOn
            ? 'Answers come from your School Information Sheet and the school websites the dashboard has checked (with a web search when needed).'
            : 'Answers come from your School Information Sheet and the school websites the dashboard has checked.')
          : 'All dashboard features work without AI. Open Settings above to paste an API key when your team is ready for school Q&A.'),
        h('div', { class: 'ask-cards' }, SUGGESTIONS.map((item) => h('button', {
          class: 'ask-card', type: 'button',
          onclick: () => { askUi.input.value = item.q; ASK.draft = item.q; submit(); },
        }, h('b', null, item.tag), h('span', null, item.q))))));
    }
    askUi.chat.replaceChildren(...items);
    askUi.send.hidden = ASK.busy; askUi.stop.hidden = !ASK.busy;
    askUi.input.disabled = ASK.busy;
    syncEffort();
    if (ASK.busy) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  }

  async function selectSession(id) {
    if (!id || ASK.busy) return;
    try {
      const s = await api('/api/ask/session?id=' + encodeURIComponent(id));
      ASK.id = s.id;
      ASK.items = Array.isArray(s.items) ? s.items : [];
      drawSide(); drawBar(); drawChat();
    } catch { /* session expired or removed */ }
  }

  async function renameSession(targetId) {
    const id = targetId || ASK.id;
    if (!id || ASK.busy) return;
    const cur = ASK.sessions.find((x) => x.id === id);
    const next = prompt('Rename this saved chat:', (cur && cur.title) || 'School chat');
    if (!next || !next.trim()) return;
    try {
      const r = await api('/api/ask/session-rename', { id, title: next.trim() });
      if (cur) cur.title = r.title;
      drawSide(); drawBar();
    } catch (e) { alert(e.message); }
  }

  async function deleteSession(targetId) {
    const id = targetId || ASK.id;
    if (!id || ASK.busy) return;
    try { await api('/api/ask/reset', { conversationId: id }); } catch { /* ignore */ }
    ASK.sessions = ASK.sessions.filter((x) => x.id !== id);
    if (ASK.id === id) { ASK.id = null; ASK.items = []; }
    drawSide(); drawBar(); drawChat();
  }

  function drawSide() {
    if (!askUi || !askUi.sideList || S.view !== 'ask') return;
    if (!ASK.sessions.length) {
      askUi.sideList.replaceChildren(h('li', { class: 'small muted' }, 'Recent school chats appear here.'));
      return;
    }
    askUi.sideList.replaceChildren(...ASK.sessions.map((s) => {
      const active = s.id === ASK.id;
      const meta = [s.turns ? `${s.turns}t` : '', s.updatedAt ? ago(s.updatedAt) : ''].filter(Boolean).join(' · ');
      return h('li', { class: 'ask-thread' + (active ? ' on' : '') },
        h('button', { class: 'ask-thread-go', type: 'button', disabled: ASK.busy, onclick: () => selectSession(s.id) },
          h('span', { class: 'ask-thread-title' }, s.title || 'School chat'),
          meta ? h('span', { class: 'ask-thread-meta' }, meta) : null),
        h('button', { class: 'ask-thread-act', type: 'button', title: 'Rename chat', 'aria-label': 'Rename chat', disabled: ASK.busy, onclick: () => renameSession(s.id) }, '✎'),
        h('button', { class: 'ask-thread-act', type: 'button', title: 'Delete chat', 'aria-label': 'Delete chat', disabled: ASK.busy, onclick: () => deleteSession(s.id) }, '×'));
    }));
  }

  function askMemoryPanel(message, badMsg, open) {
    const kbCount = (ASK.status && ASK.status.kbCount) || 0;
    const box = h('details', { class: 'panel asksettings askmem', open: !!open });
    box.append(h('summary', null, `Saved memory (${ASK.memories.length}) · Auto-learned Q&As (${kbCount})`));
    box.append(h('p', { class: 'muted small' }, 'Ask automatically saves verified school Q&As and preferences as you chat, and reuses them across restarts without extra steps.'));
    const status = h('p', { class: 'small ' + (badMsg ? 'bad' : 'good'), hidden: !message }, message || '');
    const refreshMemPanel = (msg, bad) => {
      askUi.memPanel = askMemoryPanel(msg, bad, true);
      askUi.memWrap.replaceChildren(askUi.memPanel);
      askUi.memWrap.hidden = false;
      drawBar();
    };
    const list = h('ul', { class: 'memlist', hidden: !ASK.memories.length },
      ASK.memories.map((m) => {
        const li = h('li', null);
        const drawView = () => {
          const editBtn = h('button', { class: 'btn copybtn', type: 'button', onclick: () => drawEdit() }, 'Edit');
          const delBtn = h('button', { class: 'btn copybtn', type: 'button', onclick: async () => {
            try {
              const r = await api('/api/ask/memory', { action: 'delete', id: m.id });
              ASK.memories = r.notes || [];
              refreshMemPanel('Removed note.', false);
            } catch (e) { status.textContent = e.message; status.className = 'small bad'; status.hidden = false; }
          } }, 'Remove');
          setKids(li, h('span', null, m.note), editBtn, delBtn);
        };
        const drawEdit = () => {
          const eInp = h('input', { type: 'text', maxlength: '320', value: m.note, 'aria-label': 'Edit memory note' });
          const saveE = h('button', { class: 'btn primary copybtn', type: 'button' }, 'Save');
          const cancelE = h('button', { class: 'btn copybtn', type: 'button', onclick: drawView }, 'Cancel');
          const save = async () => {
            const val = eInp.value.trim();
            if (!val) return;
            saveE.disabled = true;
            try {
              const r = await api('/api/ask/memory', { action: 'edit', id: m.id, note: val });
              ASK.memories = r.notes || [];
              refreshMemPanel('Updated note.', false);
            } catch (e) { status.textContent = e.message; status.className = 'small bad'; status.hidden = false; saveE.disabled = false; }
          };
          saveE.onclick = save;
          eInp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') drawView(); };
          setKids(li, h('div', { class: 'memedit' }, eInp, saveE, cancelE));
          eInp.focus();
        };
        drawView();
        return li;
      }));
    const inp = h('input', { type: 'text', maxlength: '320', placeholder: 'Optional: add a note manually (Ask also auto-learns as you chat)', 'aria-label': 'Add memory note' });
    const addBtn = h('button', { class: 'btn primary', type: 'button' }, 'Add memory');
    const clearBtn = ASK.memories.length
      ? h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!confirm('Clear all saved Ask memory notes?')) return;
        const r = await api('/api/ask/memory', { action: 'clear' });
        ASK.memories = r.notes || [];
        refreshMemPanel('Cleared saved memory.', false);
      } }, 'Clear all')
      : null;
    const submitNote = async () => {
      const note = inp.value.trim();
      if (!note) return;
      addBtn.disabled = true;
      try {
        const r = await api('/api/ask/memory', { action: 'add', note });
        ASK.memories = r.notes || [];
        refreshMemPanel('Saved to memory.', false);
      } catch (e) {
        status.textContent = e.message; status.className = 'small bad'; status.hidden = false;
      }
      addBtn.disabled = false;
    };
    addBtn.onclick = submitNote;
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submitNote(); } };

    const dlKbBtn = kbCount
      ? h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          const r = await checkedFetch('/api/ask/dataset', undefined, 'Could not export dataset.');
          const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'school-ask-dataset.jsonl';
          triggerBlobDownload(await r.blob(), name);
        } catch (e) { status.textContent = e.message; status.className = 'small bad'; status.hidden = false; }
      } }, 'Download training dataset (.jsonl)')
      : null;
    const clearKbBtn = kbCount
      ? h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!confirm('Clear automatically learned Q&A history?')) return;
        const r = await api('/api/ask/kb', { action: 'clear' });
        if (ASK.status) ASK.status.kbCount = r.count || 0;
        refreshMemPanel('Cleared learned Q&A knowledge.', false);
      } }, 'Clear learned Q&As')
      : null;

    box.append(list, h('div', { class: 'memadd' }, inp, addBtn, clearBtn), status);
    if (kbCount) box.append(h('div', { class: 'sched-task' }, h('span', { class: 'small muted' }, `${kbCount} learned Q&A${kbCount === 1 ? '' : 's'} active across sessions`), dlKbBtn, clearKbBtn));
    return box;
  }

  function drawBar() {
    if (!askUi || S.view !== 'ask') return;
    const st = ASK.status;
    const groq = st.provider === 'groq';
    const cfg = groq ? st.groq : st.anthropic;
    const locked = st.locked || {};
    const showModel = !(groq ? locked.groqModel : (locked.model || locked.costPolicy));
    const model = groq ? cfg.model : ((st.anthropic.models.find((m) => m.id === cfg.model) || {}).label || cfg.model);
    const used = st.spentThisMonth || 0, pct = Math.min(100, Math.round(used / st.monthlyCapUsd * 100));
    const kbCount = st.kbCount || 0;
    const memOpen = !!(askUi.memWrap && !askUi.memWrap.hidden && askUi.memPanel && askUi.memPanel.open);
    const setDetails = askUi.settings && askUi.settings.querySelector('details');
    const setOpen = !!(askUi.settings && !askUi.settings.hidden && setDetails && setDetails.open);
    const memToggle = h('button', {
      class: 'btn ask-pillbtn', type: 'button', 'aria-expanded': String(memOpen),
      onclick: () => {
        const next = !(askUi.memPanel && askUi.memPanel.open && !askUi.memWrap.hidden);
        if (askUi.memPanel) askUi.memPanel.open = next;
        askUi.memWrap.hidden = !next;
        drawBar();
      },
    }, `Saved notes (${ASK.memories.length}) · Learned answers (${kbCount})`);
    const canShowSettings = !!(st.canEditSettings || !st.ready);
    const setToggle = canShowSettings ? h('button', {
      class: 'btn ask-pillbtn', type: 'button', 'aria-expanded': String(setOpen),
      onclick: () => {
        const cur = askUi.settings.querySelector('details');
        const next = !(cur && cur.open && !askUi.settings.hidden);
        if (cur) cur.open = next;
        askUi.settings.hidden = !next;
        drawBar();
      },
    }, 'Settings') : null;
    setKids(
      askUi.bar,
      st.ready ? chip([groq ? 'Test model (Groq)' : 'Claude', groq ? 'warn' : 'ok'], groq ? 'Only for trying the page out. Claude is the one meant for real use.' : null) : chip(['Not connected (optional)', ''], 'Ask is optional — loading sheets, scraping websites, and Excel/CSV exports all work without AI.'),
      st.webSearchOn ? chip(['Web search on', 'info'], 'The assistant may search the web for school facts when the saved results cannot answer. Web answers are labelled and never go into your sheet.') : null,
      showModel ? h('span', { class: 'small muted' }, model) : null,
      groq ? h('span', { class: 'small muted' }, 'spend not tracked') : h('span', { class: 'small', title: 'An estimate from list prices. The cap stops new questions once it is reached.' },
        h('span', { class: 'meter' }, h('i', { style: null })), `${money(used)} / $${st.monthlyCapUsd}`),
      h('span', { class: 'spacer' }),
      memToggle,
      setToggle,
      h('button', { class: 'btn', type: 'button', onclick: newChat }, 'New chat'));
    const bar = askUi.bar.querySelector('.meter i');
    if (bar) bar.style.width = pct + '%';   // a style property set from script is allowed; an inline style attribute is not
    syncEffort();
  }

  function askSettings(message) {
    const st = ASK.status;
    if (!st.canEditSettings) {
      if (st.ready && !message) return h('span', { hidden: true });
      const box = h('details', { class: 'panel asksettings', open: true });
      box.append(h('summary', null, 'AI assistant status'));
      box.append(h('p', { class: 'muted small' }, message || (st.sharedServer
        ? 'Ask is not connected yet. Only the AI administrator can connect it. The administrator signs in with their own email and adds the API key here.' + (st.adminsSet ? '' : ' Nobody is set up as administrator yet: whoever runs the server adds the administrator’s email to the ASK_ADMIN_EMAILS setting.')
        : 'Ask is not connected yet.')));
      return box;
    }
    const locked = st.locked || {};
    const box = h('details', { class: 'panel asksettings', open: !!message });
    box.append(h('summary', null, (st.ready ? 'AI settings' : 'Optional AI settings (not connected yet)') + (st.sharedServer ? ' · administrator only' : '')));
    if (st.sharedServer) {
      box.append(h('p', { class: 'small' }, h('b', null, 'Only you can see this. '), 'You are signed in as the AI administrator. Other people on this dashboard cannot see or change these settings. The key you paste is saved on the server, never shown again (only its last four characters), and used only to answer questions on the Ask page.'));
    }
    if (!st.ready) {
      box.append(h('p', { class: 'muted small' }, 'You do not need an AI key to load your sheet, check school websites, or download spreadsheets. Only fill this in if your team wants to ask questions on this page.'));
    }
    const out = h('p', { class: 'small' });
    const say = (m, bad) => { out.textContent = m; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    if (message) say(message);
    const form = { provider: st.provider };
    const fields = h('div');
    const radio = (value, label, hint) => {
      const input = h('input', { type: 'radio', name: 'askprov', value, checked: st.provider === value });
      input.onchange = () => { form.provider = value; draw(); };
      return h('label', { class: 'radio' }, input, h('span', null, h('b', null, label), ' ', h('span', { class: 'muted small' }, hint)));
    };
    let key, model, effort, cap, web;
    let hasEditableFields = false;
    function draw() {
      const g = form.provider === 'groq';
      const k = g ? st.groq : st.anthropic;
      const lockedKey = !!(g ? locked.groqKey : locked.anthropicKey);
      const modelLocked = !!(g ? locked.groqModel : (locked.model || locked.costPolicy));
      const effortLocked = !!(locked.effort || locked.costPolicy);
      const capLocked = !!locked.cap;
      const webLocked = !!locked.webSearch;

      key = lockedKey ? null : h('input', { type: 'password', class: 'wide', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'API key',
        placeholder: k.configured ? `Saved (${k.keyHint}). Paste a new key to replace it.` : g ? 'Groq API key (starts with gsk_)' : 'Anthropic API key (starts with sk-ant-)' });
      const baseIds = g ? k.models : k.models.map((m) => m.id);
      const ids = baseIds.includes(k.model) ? baseIds : [k.model, ...baseIds];
      model = modelLocked ? null : h('select', { 'aria-label': 'Model' }, ids.map((id) => h('option', { value: id, selected: id === k.model }, g ? id : ((k.models.find((m) => m.id === id) || {}).label || id))));
      effort = (g || effortLocked) ? null : h('select', { 'aria-label': 'Default thinking effort' }, effortOptions(st.effort || 'medium', true));
      cap = (g || capLocked) ? null : h('input', { type: 'number', min: '1', max: '10000', step: '1', value: String(st.monthlyCapUsd), class: 'cap', 'aria-label': 'Monthly cap in dollars' });
      web = (g || webLocked) ? null : h('input', { type: 'checkbox', checked: !!st.webSearch, 'aria-label': 'Let the assistant search the web' });

      const nodes = [
        key ? h('label', { class: 'field' }, h('span', null, g ? 'Groq API key' : 'Anthropic API key'), key) : null,
        model ? h('label', { class: 'field' }, h('span', null, 'Model'), model) : null,
        ...(g ? [
          h('p', { class: 'muted small' }, 'Groq is a different company with open models, for trying this page out cheaply. Your questions and the school data the tools return are sent to Groq. Its free plan allows only a few thousand tokens a minute, so a long answer may pause and retry. Claude is the one meant for real use.'),
          h('p', { class: 'muted small' }, 'Web search is only available with Claude.'),
        ] : [
          effort ? h('label', { class: 'field' }, h('span', null, 'Default thinking effort'), effort) : null,
          cap ? h('label', { class: 'field' }, h('span', null, 'Monthly spending cap (US dollars)'), cap) : null,
          web ? h('label', { class: 'check field' }, web, h('span', null, 'Let the assistant search the web')) : null,
          web ? h('p', { class: 'muted small' }, 'Off unless you switch it on. When on, Claude can search the web strictly for school and admissions questions (general non-school questions remain off). About $0.01 a search on top of the usual cost. Web results are not the school’s own website: they are labelled, listed as sources, and never go into the Google Sheet file. Your organization may need to allow web search in the Anthropic console first.') : null,
        ]),
      ].filter(Boolean);
      hasEditableFields = !!(key || model || effort || cap || web || !locked.provider);
      fields.replaceChildren(...nodes);
    }
    async function save() {
      const g = form.provider === 'groq';
      const body = { provider: form.provider };
      if (g) {
        if (key && key.value.trim()) body.groqKey = key.value;
        if (model) body.groqModel = model.value;
      } else {
        if (key && key.value.trim()) body.apiKey = key.value;
        if (model) body.model = model.value;
        if (effort) body.effort = effort.value;
        if (cap) body.monthlyCapUsd = cap.value;
        if (web) body.webSearch = web.checked;
      }
      ASK.status = await api('/api/ask/settings', body);
      if (ASK.status && (!g || (ASK.status.locked && ASK.status.locked.effort))) ASK.effort = ASK.status.effort || 'medium';
    }
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    const testBtn = h('button', { class: 'btn', type: 'button' }, 'Save and test the connection');
    const run = (btn, label, fn) => async () => {
      btn.disabled = true;
      try { await fn(); } catch (e) { say(e.message, true); }
      btn.disabled = false; btn.textContent = label;
    };
    saveBtn.onclick = run(saveBtn, 'Save', async () => { await save(); askUi.settings.replaceChildren(askSettings('Saved on this computer. The key is never shown again.')); askUi.settings.hidden = false; drawBar(); drawChat(); });
    testBtn.onclick = run(testBtn, 'Save and test the connection', async () => {
      testBtn.textContent = 'Testing…';
      await save();
      const r = await api('/api/ask/test', {});
      if (r.models) {
        if (r.provider === 'groq') ASK.status.groq.models = r.models;
        else if (!ASK.status.locked || !ASK.status.locked.costPolicy) ASK.status.anthropic.models = r.models;
      }
      askUi.settings.replaceChildren(askSettings(r.message)); askUi.settings.hidden = false; drawBar(); drawChat();
    });
    draw();
    if (!hasEditableFields && st.ready && !message) return h('span', { hidden: true });
    appendKids(box, [
      !(locked.anthropicKey && locked.groqKey) ? h('p', { class: 'muted small' }, 'The key is saved only on this computer (in the data folder) and is never sent back to the page. Make one in the Anthropic console (Settings, API keys) or, for the test model, at console.groq.com.') : null,
      locked.provider ? null : h('div', { class: 'radios' }, radio('anthropic', 'Claude', '(Anthropic): the real one'), radio('groq', 'Groq', '(test only): free to try')),
      fields, h('div', { class: 'runbtns' }, saveBtn, testBtn), out,
    ]);
    return box;
  }

  async function refreshAskMemoryAndSessions() {
    try {
      const [memRes, sesRes, stRes] = await Promise.all([api('/api/ask/memory'), api('/api/ask/sessions'), api('/api/ask/status')]);
      ASK.memories = memRes.notes || [];
      ASK.sessions = sesRes.sessions || [];
      if (stRes) ASK.status = stRes;
      if (askUi && askUi.memWrap) askUi.memWrap.replaceChildren(askUi.memPanel = askMemoryPanel('', false, askUi.memPanel && askUi.memPanel.open));
      drawSide();
      drawBar();
    } catch { /* ignore background refresh errors */ }
  }

  function onAskEvent(turn, ev) {
    if (ev.type === 'conversation') { ASK.id = ev.id; if (ev.fresh) turn.note = 'The earlier conversation was no longer there (the dashboard was restarted), so this started a new one.'; }
    else if (ev.type === 'step') turn.steps.push({ id: ev.id, label: ev.label, done: false, ok: true });
    else if (ev.type === 'step-done') { const s = turn.steps.find((x) => x.id === ev.id); if (s) { s.label = ev.label; s.done = true; s.ok = ev.ok; } }
    else if (ev.type === 'proposal') turn.proposals.push({ ...ev.proposal, state: 'idle' });
    else if (ev.type === 'sources') turn.sources = ev.sources;
    else if (ev.type === 'memory') { turn.memory = turn.memory || []; turn.memory.push(ev); }
    else if (ev.type === 'text-reset') turn.text = '';
    else if (ev.type === 'text-delta') turn.text += ev.text || '';
    else if (ev.type === 'answer') turn.text = ev.text;
    else if (ev.type === 'usage') {
      turn.usage = ev;
      if (ASK.status) {
        if (ev.month) ASK.status.spentThisMonth = ev.month.spent;
        if (ev.kbCount != null) ASK.status.kbCount = ev.kbCount;
      }
    }
    else if (ev.type === 'error') turn.error = ev.message;
  }

  async function askStream(message) {
    const turn = { role: 'assistant', steps: [], proposals: [], sources: [], memory: [], text: '', usage: null, error: null, note: null, pending: true };
    ASK.items.push({ role: 'user', text: message }, turn);
    ASK.busy = true; ASK.ctrl = new AbortController();
    startTask('ask', 'Ask is writing an answer…', { message: 'It keeps going if you open another page.', hideOnView: 'ask' });
    drawChat();
    try {
      const reqBody = { conversationId: ASK.id, message };
      if (ASK.status && ASK.status.provider === 'anthropic' && (!ASK.status.locked || !ASK.status.locked.effort) && ASK.effort) {
        reqBody.effort = ASK.effort;
      }
      const r = await checkedFetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' }, body: JSON.stringify(reqBody), signal: ASK.ctrl.signal });
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          buf += dec.decode();
          if (buf.trim()) { try { onAskEvent(turn, JSON.parse(buf.trim())); } catch { /* ignore trailing partial line */ } }
          break;
        }
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.indexOf('\n')) >= 0;) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) { try { onAskEvent(turn, JSON.parse(line)); } catch { /* a damaged line is skipped */ } }
        }
        drawChat(); drawBar();
      }
      if (!turn.text && !turn.error) turn.error = 'The connection ended before an answer arrived. Try again.';
    } catch (e) { turn.error = e.name === 'AbortError' ? 'Stopped.' : e.message; }
    turn.pending = false; ASK.busy = false; ASK.ctrl = null;
    if (S.view === 'ask') dismissTask('ask');   // the person is looking at it: no message needed
    else endTask('ask', { failed: !!turn.error && turn.error !== 'Stopped.', title: turn.error ? (turn.error === 'Stopped.' ? 'Ask was stopped' : 'Ask could not answer') : 'Ask has an answer', message: turn.error || 'Your question was answered.', link: '#/ask', linkText: 'Open Ask', hideOnView: 'ask' });
    await refreshAskMemoryAndSessions();
    drawChat(); drawBar();
  }

  function submit() {
    if (!askUi || ASK.busy) return;
    const text = askUi.input.value.trim();
    if (!text) return;
    if (!ASK.status.ready) {
      askUi.settings.replaceChildren(askSettings('Connect the AI first, then ask again.'));
      askUi.settings.hidden = false;
      drawBar();
      return;
    }
    askUi.input.value = ''; ASK.draft = '';
    if (askUi.input.style) askUi.input.style.height = 'auto';
    const panel = askUi.settings.querySelector('details');
    if (panel) panel.open = false;                 // the settings are out of the way once a question is on its way
    askUi.settings.hidden = true;
    drawBar();
    askStream(text);
  }

  function newChat() {
    if (ASK.ctrl) ASK.ctrl.abort();
    ASK.id = null; ASK.items = []; ASK.busy = false;
    drawSide(); drawBar(); drawChat();
  }

  async function viewAsk() {
    const [st, memRes, sesRes] = await Promise.all([
      api('/api/ask/status'),
      api('/api/ask/memory').catch(() => ({ notes: [] })),
      api('/api/ask/sessions').catch(() => ({ sessions: [] })),
    ]);
    ASK.status = st;
    ASK.memories = memRes.notes || [];
    ASK.sessions = sesRes.sessions || [];
    if (!ASK.loadedOnce) {
      ASK.loadedOnce = true;
      if (!ASK.id && ASK.sessions.length) {
        try {
          const latest = await api('/api/ask/session?id=' + encodeURIComponent(ASK.sessions[0].id));
          ASK.id = latest.id;
          ASK.items = Array.isArray(latest.items) ? latest.items : [];
        } catch { /* ignore */ }
      }
    }
    const input = h('textarea', { class: 'askinput', rows: '2', placeholder: 'Ask a question about a school or your sheet (schools only)…', 'aria-label': 'Your question', maxlength: '4000' });
    const fitInput = () => {
      if (!input.style) return;
      input.style.height = 'auto';
      if (input.scrollHeight) input.style.height = Math.min(180, Math.max(46, input.scrollHeight)) + 'px';
    };
    input.value = ASK.draft;
    input.oninput = () => { ASK.draft = input.value; fitInput(); };
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } };
    const effort = h('select', { class: 'effort-sel', 'aria-label': 'Thinking effort' });
    effort.onchange = () => { ASK.effort = effort.value; };
    const effortWrap = h('label', { class: 'effort-wrap', hidden: true }, h('span', null, 'Effort'), effort);
    const schoolsList = S.ov && S.ov.ready && Array.isArray(S.ov.schools)
      ? [...S.ov.schools].sort((a, b) => a.name.localeCompare(b.name))
      : [];
    const schoolPick = schoolsList.length ? h('select', {
      class: 'school-pick', 'aria-label': 'Insert school name',
      onchange: (e) => {
        const name = e.target.value;
        if (!name) return;
        const cur = input.value;
        input.value = cur + (cur && !/\s$/.test(cur) ? ' ' : '') + name + ' ';
        ASK.draft = input.value;
        e.target.value = '';
        fitInput();
        input.focus();
      },
    }, [h('option', { value: '' }, 'Insert school…'), ...schoolsList.map((sc) => h('option', { value: sc.name }, sc.name))]) : null;
    const send = h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Ask');
    const stop = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => ASK.ctrl && ASK.ctrl.abort() }, 'Stop');
    const memWrap = h('div', { hidden: true });
    const memPanel = askMemoryPanel('', false, false);
    memWrap.append(memPanel);
    const settingsWrap = h('div', { hidden: !!st.ready });
    const settingsPanel = askSettings(!st.ready ? '' : null);
    if (!st.ready && settingsPanel.tagName === 'DETAILS') settingsPanel.open = true;
    settingsWrap.append(settingsPanel);
    const sideList = h('ul', { class: 'ask-threads' });
    askUi = { bar: h('div', { class: 'askbar' }), sideList, chat: h('div', { class: 'chat', 'aria-live': 'polite' }), settings: settingsWrap, memWrap, memPanel, input, effort, effortWrap, send, stop };
    const sidebar = h('aside', { class: 'ask-side', 'aria-label': 'Saved chats' },
      h('div', { class: 'ask-sidehead' }, h('h2', null, 'Saved chats'),
        h('button', { class: 'btn copybtn', type: 'button', onclick: newChat }, '+ New')),
      sideList);
    const composer = h('div', { class: 'composer' },
      h('div', { class: 'composer-card' },
        input,
        h('div', { class: 'composer-foot' },
          schoolPick,
          h('span', { class: 'small muted' }, 'Enter sends · Shift+Enter new line'),
          h('span', { class: 'spacer' }),
          h('div', { class: 'runbtns' }, effortWrap, send, stop))));
    app.replaceChildren(
      h('div', { class: 'ask' },
        h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Ask'),
          h('p', null, 'Ask a question in plain English about the private schools, your School Information Sheet, or the website results. Your saved chats stay private on this computer.'))),
        h('div', { class: 'askshell' },
          sidebar,
          h('div', { class: 'ask-main' }, askUi.bar, askUi.memWrap, askUi.settings, askUi.chat, composer))));
    drawSide(); drawBar(); drawChat();
    if (ASK.status.ready && !ASK.busy) input.focus();
  }

  // ------------------------------------------------------------ review view ---
  // The researcher's work list: only the main facts the rating is not sure about, least certain first.
  const TRUST_LABEL = { high: 'Safe to use', medium: 'Quick look', low: 'Check this' };
  async function viewReview() {
    S.rv = S.rv || { tier: '', field: '', level: '' };
    app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
    const qs = new URLSearchParams(Object.entries(S.rv).filter(([, v]) => v)).toString();
    const q = await api('/api/review-queue' + (qs ? '?' + qs : ''));
    if (!q.ready) { setKids(app, h('div', { class: 'notice' }, taskRunning('workbook') ? 'Your school sheet is loading. This page fills in by itself when it is ready.' : 'Load your sheet and check some school websites first.')); return; }
    const set = (k, v) => { S.rv[k] = v; viewReview(); };
    const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '—');
    const tier = h('select', { 'aria-label': 'Tier', onchange: (e) => set('tier', e.target.value) }, [['', 'All tiers'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3']].map(([v, t]) => h('option', { value: v, selected: S.rv.tier === v }, t)));
    const level = h('select', { 'aria-label': 'How sure', onchange: (e) => set('level', e.target.value) }, [['', '“Check this” and “Quick look”'], ['doubtful', 'Only “Check this”'], ['check', 'Only “Quick look”']].map(([v, t]) => h('option', { value: v, selected: S.rv.level === v }, t)));
    const chips = [h('button', { type: 'button', 'aria-pressed': String(!S.rv.field), onclick: () => set('field', '') }, 'All questions', h('b', null, q.needLook)),
      ...q.byField.map((f) => h('button', { type: 'button', 'aria-pressed': String(S.rv.field === f.key), onclick: () => set('field', S.rv.field === f.key ? '' : f.key) }, f.label.length > 26 ? f.label.slice(0, 25) + '…' : f.label, h('b', null, f.n)))];
    const rows = q.items.map((i) => h('tr', { class: 'click', onclick: () => { location.hash = '#/school/' + encodeURIComponent(i.schoolId); } },
      h('td', null, h('span', { class: 'trust ' + i.level }, `${TRUST_LABEL[i.level]} · ${i.score}/100`)),
      h('td', { class: 'name' }, h('a', { href: '#/school/' + encodeURIComponent(i.schoolId) }, i.school), h('span', { class: 'sub' }, i.tier ? 'Tier ' + i.tier : '')),
      h('td', null, i.label), h('td', { class: 'val' }, i.value),
      h('td', { class: 'small' }, safeUrl(i.source) ? h('a', { href: i.source, target: '_blank', rel: 'noopener noreferrer', title: i.source, onclick: (e) => e.stopPropagation() }, shortUrl(i.source)) : h('span', { class: 'muted' }, 'none')),
      h('td', { class: 'small whycol' }, i.why.map((w) => h('div', null, w)))));
    setKids(app,
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Answers to check'),
        h('p', null, 'These are the answers the dashboard is least sure about, the least certain first. Its rating looks at where an answer came from (the school’s own fact sheet, or its page on that topic, is the most reliable) and how clearly the website says it. It never looks at your sheet. Answers it is sure about are left out, so you only spend time where a person is needed. Open a school and press ✓ Right or ✗ Wrong: answers you check disappear from this list. ', helpLink('ratings', 'What do the ratings mean?')))),
      h('div', { class: 'stats', role: 'group', 'aria-label': 'Summary' },
        h('div', { class: 'stat' }, h('b', null, String(q.facts)), h('span', null, 'main facts rated')),
        h('div', { class: 'stat' }, h('b', null, pct(q.readyToUse, q.facts)), h('span', null, `safe to use (${q.readyToUse}): no need to check`)),
        h('div', { class: 'stat' }, h('b', null, String(q.needLook)), h('span', null, 'need your check')),
        h('div', { class: 'stat' }, h('b', null, String(q.checked)), h('span', null, 'you have already checked'))),
      q.byField.some((f) => ['counselors', 'enrollment'].includes(f.key)) ? h('div', { class: 'notice info' }, 'Some questions, such as the number of counselors and total enrollment, show up here a lot. That is normal: those answers are harder for the dashboard to read. Use the question buttons below to work through one question at a time.') : null,
      q.skippedWrongSite ? h('div', { class: 'notice info' }, `${q.skippedWrongSite} school${q.skippedWrongSite === 1 ? ' is' : 's are'} left out because the website link in your sheet looks like a different school. Fix the link first and check that school again: nothing read from the wrong website can be trusted.`) : null,
      h('div', { class: 'bar' }, tier, level, h('span', { class: 'spacer' }), h('a', { class: 'btn link small', href: '#/accuracy' }, 'Can I trust the ratings?')),
      h('div', { class: 'filters', role: 'group', 'aria-label': 'Questions' }, chips),
      q.items.length
        ? h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, h('tr', null, ['Rating', 'School', 'Question', 'What the dashboard found', 'Page it came from', 'Why'].map((t) => h('th', null, t)))), h('tbody', null, rows)))
        : h('p', { class: 'empty' }, 'Nothing to check with these filters. Every answer the dashboard found is either safe to use or already checked by you.'),
      q.truncated ? h('p', { class: 'muted small' }, 'Showing the 500 least certain answers. Use the filters above to narrow the list.') : null);
  }

  // ---------------------------------------------------------- accuracy view ---
  // Accuracy is measured against checks a person makes on each school's own website (the Right / Wrong buttons on a school page).
  // Agreement with the sheet, shown elsewhere, is only a hint about where to look first.
  const pctText = (x) => (x == null ? '—' : Math.round(x * 100) + '%');
  const ACC_STATUS = { trust: ['Reliable', 'ok'], review: ['Check before using', 'warn'], 'always-review': ['Always check', 'bad'], few: ['Not enough checks yet', ''] };

  async function viewAccuracy() {
    app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
    const a = await api('/api/accuracy');
    const rep = a.report, smp = a.sample, o = rep.overall;
    const act = async (path, body) => { try { await api(path, body || {}); } catch (e) { alert(e.message); } viewAccuracy(); };
    const rangeOf = (m) => (m.range && m.rightWhenItAnswers != null ? `${Math.round(m.range.low * 100)}–${Math.round(m.range.high * 100)}%` : '');
    const metricRow = (label, m) => h('tr', null,
      h('td', null, label), h('td', { class: 'num' }, String(m.checks)),
      h('td', { class: 'num' }, pctText(m.rightWhenItAnswers)), h('td', { class: 'num small muted' }, rangeOf(m)),
      h('td', { class: 'num' }, pctText(m.findsWhatIsThere)), h('td', null, chip(ACC_STATUS[m.status])));
    const head = h('tr', null, h('th', null, ''), h('th', { class: 'num' }, 'Answers checked'), h('th', { class: 'num' }, 'How often it was right'), h('th', { class: 'num' }, 'Likely range'),
      h('th', { class: 'num' }, 'How often it finds an answer that exists'), h('th', null, 'Can you rely on it?'));
    const table = (rows) => h('div', { class: 'tablewrap' }, h('table', null, h('thead', null, head), h('tbody', null, rows)));

    const samplePanel = h('div', { class: 'panel' }, h('h2', null, 'A list of schools to check by hand'),
      !smp
        ? [h('p', null, `The dashboard can pick 30 schools it read successfully, spread across the tiers. For each school you check the ${rep.keyFields.length} most important questions (${rep.keyFields.map((f) => f.label.replace(/:$/, '')).join(', ')}) against the school’s own website. `
          + 'That is roughly 6 to 8 hours of work in total, so do it a little at a time: every check counts right away.'),
        h('div', { class: 'runbtns' }, h('button', { class: 'btn primary', type: 'button', onclick: () => act('/api/accuracy/sample', { schools: 30 }) }, 'Pick 30 schools for me'))]
        : [h('p', null, h('b', null, `${smp.done} of ${smp.total} answers checked`), ` in the list of ${smp.schools.length} schools picked ${ago(smp.drawnAt)}. Open a school and mark each answer Right or Wrong. Where the dashboard found nothing, say whether the website really has nothing.`),
          h('div', { class: 'tablewrap' }, h('table', null, h('tbody', null, smp.schools.map((x) => h('tr', null,
            h('td', { class: 'name' }, h('a', { href: '#/school/' + encodeURIComponent(x.id) }, x.name)), h('td', { class: 'small muted' }, x.tier ? 'Tier ' + x.tier : ''),
            h('td', { class: 'num' }, h('span', { class: 'meter' }, (() => { const i = h('i'); i.style.width = Math.round((x.done / x.total) * 100) + '%'; return i; })()), `${x.done} / ${x.total}`),
            h('td', null, h('a', { href: '#/school/' + encodeURIComponent(x.id) }, x.done >= x.total ? 'Done' : 'Open and check'))))))),
          h('div', { class: 'runbtns' },
            h('button', { class: 'btn', type: 'button', onclick: () => { if (confirm('Pick different schools? The list is replaced. Checks you already made are kept.')) act('/api/accuracy/sample', { schools: smp.schools.length }); } }, 'Pick different schools'),
            h('button', { class: 'btn', type: 'button', onclick: () => act('/api/accuracy/sample-clear') }, 'Clear the list'))]);

    const tiles = h('div', { class: 'stats', role: 'group', 'aria-label': 'Overall' },
      h('div', { class: 'stat' }, h('b', null, String(o.checks)), h('span', null, 'answers checked by you')),
      h('div', { class: 'stat' }, h('b', null, pctText(o.rightWhenItAnswers)), h('span', null, `of the answers it found were right${rangeOf(o) ? ' (likely ' + rangeOf(o) + ')' : ''}`)),
      h('div', { class: 'stat' }, h('b', null, pctText(o.findsWhatIsThere)), h('span', null, 'of the answers that exist on the websites were found')),
      h('div', { class: 'stat' }, h('b', null, String(o.wrong + o.missed)), h('span', null, o.wrong + o.missed === 1 ? 'mistake to look at' : 'mistakes to look at')));

    const resultPanel = h('div', { class: 'panel' }, h('h2', null, 'The results so far'),
      o.checks ? [tiles,
        rep.staleChecks ? h('div', { class: 'notice info' }, `${rep.staleChecks} answer${rep.staleChecks === 1 ? ' has' : 's have'} changed since you checked ${rep.staleChecks === 1 ? 'it' : 'them'}, so ${rep.staleChecks === 1 ? 'it is' : 'they are'} left out of the numbers until you check again.`) : null,
        h('p', { class: 'muted small' }, `A simple guide: 95% or more right means you can rely on that question, 85 to 95% means check before using, and under 85% means always check. When a question has fewer than ${rep.minChecks} checks, the percentage is only a hint, so the likely range is shown too.`),
        table([metricRow('All checked fields', o), ...rep.fields.map((f) => metricRow(f.label, f))])]
        : h('p', { class: 'muted' }, 'No checks yet. Open a school and press ✓ Right or ✗ Wrong under an answer the dashboard found, and the results appear here.'));

    const confPanel = rep.trust && rep.trust.length ? h('div', { class: 'panel' }, h('h2', null, 'Can you trust the “Safe to use” rating?'),
      h('p', { class: 'muted small' }, 'Answers rated Safe to use should be right far more often than the ones rated Check this. If they are not, the rating needs to be improved. (Only answers you checked after the ratings appeared count here.)'),
      table(rep.trust.map((c) => metricRow(TRUST_LABEL[c.level] || c.level, c)))) : null;

    const errPanel = rep.errors.length ? h('div', { class: 'panel' }, h('h2', null, `Wrong or missed answers (${rep.errors.length})`),
      h('ul', { class: 'errlist' }, rep.errors.map((e) => h('li', null,
        h('a', { href: '#/school/' + encodeURIComponent(e.schoolId) }, e.school), ' — ', h('b', null, e.label), ': ',
        e.verdict === 'missed' ? 'the dashboard found nothing' : [`the dashboard said “${e.found || ''}”`],
        e.truth ? [' · the right answer: ', h('b', null, e.truth)] : null, e.truthUrl ? [' · ', ext(e.truthUrl, 'source')] : null)))) : null;

    const exportBtn = h('button', { class: 'btn', type: 'button', disabled: !o.checks && !rep.staleChecks, onclick: async () => {
      try {
        const r = await checkedFetch('/api/accuracy/export', undefined, 'The file could not be made.');
        triggerBlobDownload(await r.blob(), (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'answer-key.json');
      } catch (e) { alert(e.message); }
    } }, 'Download your checked answers (.json)');

    setKids(   // (not replaceChildren: an empty panel is null, and the browser would print the word "null")
      app,
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'How accurate are the answers?'),
        h('p', null, 'Are the answers the dashboard finds actually right? The best way to find out is for a person to open the school’s own website and compare. Every time you press ✓ Right or ✗ Wrong on a school page, the numbers below update. Matching your sheet is only a hint, because your sheet can be out of date.'))),
      samplePanel, resultPanel, confPanel, errPanel,
      h('div', { class: 'runbtns' }, exportBtn));
  }

  // ------------------------------------------- Google Sheet menu: step-by-step setup ---
  // The script (google-sheet/Code.gs) adds a "School Info" menu to a copy of the Google Sheet. This page has the script to copy
  // and the steps to put it in the sheet and to use it, so nobody has to find a document.
  async function viewSheetSetup() {
    const key = (...keys) => keys.flatMap((k, i) => [i ? ' + ' : null, h('kbd', null, k)]);
    let code = null;
    const loadCode = async () => { if (code == null) code = (await api('/api/code?file=' + encodeURIComponent('google-sheet/Code.gs'))).content; return code; };
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const out2 = h('p', { class: 'small' });
    const say2 = (msg, bad) => { out2.textContent = msg; out2.className = 'small ' + (bad ? 'bad' : 'good'); };

    const copyBtn = h('button', { class: 'btn primary', type: 'button' }, 'Copy the script');
    copyBtn.onclick = async () => {
      copyBtn.disabled = true;
      try {
        const ok = await copyText(await loadCode(), copyBtn);
        say(ok ? 'Copied. Now go to your Apps Script tab, click in the empty file, and press Ctrl + V to paste it.'
          : 'Your browser would not let the dashboard copy it. Open “Show the script” below, select all of it, and copy it by hand.', !ok);
      } catch (e) { say(e.message, true); }
      copyBtn.disabled = false;
    };
    const scraped = S.ov && S.ov.ready ? S.ov.schools.filter((s) => s.status === 'ok').length : 0;
    const dlBtn = h('button', { class: 'btn', type: 'button', disabled: !scraped }, scraped ? `Download the file for ${scraped} checked school${scraped === 1 ? '' : 's'}` : 'Check some school websites first');
    dlBtn.onclick = async () => {
      dlBtn.disabled = true;
      try {
        const f = await downloadExportFile('all=1');
        say2(`Saved “${f.name}” with ${f.count} school${f.count === 1 ? '' : 's'} in your Downloads folder.` + (f.skipped ? ` (${f.skipped} left out: not checked yet, nothing found, or a website that may be a different school.)` : ''));
      } catch (e) { say2(e.message, true); }
      dlBtn.disabled = false;
    };
    const version = h('span', { class: 'muted small' });
    const codeBox = h('pre', { class: 'code', hidden: true });
    const showCode = h('details', { class: 'panel' }, h('summary', null, 'Show the script (to copy by hand)'), codeBox);
    showCode.addEventListener('toggle', async () => {
      if (!showCode.open || codeBox.textContent) return;
      try { const c = await loadCode(); setKids(codeBox, c.split('\n').map((l) => h('span', null, l || ' '))); codeBox.hidden = false; } catch (e) { codeBox.textContent = e.message; codeBox.hidden = false; }
    });
    loadCode().then((c) => {
      const m = /var VERSION = '([^']+)'/.exec(c);
      version.textContent = m ? `The script in this dashboard is version ${m[1]}.` : '';
    }).catch(() => {});

    const problem = (q, ...a) => h('details', null, h('summary', null, q), h('p', null, ...a));
    setKids(app,
      h('a', { class: 'crumb', href: '#/start' }, '← Start here'),
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Set up the Google Sheet menu, step by step'),
        h('p', null, 'This adds a ', h('b', null, 'School Info'), ' menu to a copy of your Google Sheet. The menu loads what the dashboard found into each school’s tab: blank cells are filled in (yellow), and where the website says something different your answer is left alone and a note is added (orange). It never overwrites anything a person typed.'),
        h('p', null, 'You set it up once for each Google Sheet. It takes about 5 minutes, and you do not need your company’s Google administrator: the script only runs when a person opens the menu, as that person.'))),

      h('div', { class: 'panel' }, h('h2', null, 'Before you start'),
        h('ul', null,
          h('li', null, 'Use a ', h('b', null, 'copy'), ' of your School Information Sheet, so your original is untouched. In Google Sheets: ', h('b', null, 'File → Make a copy'), '.'),
          h('li', null, 'You need permission to edit that sheet.'),
          h('li', null, 'Keep this dashboard open in one browser tab and the Google Sheet in another.'))),

      h('div', { class: 'panel' }, h('h2', null, 'Part 1: put the script in your Google Sheet (once)'),
        h('ol', { class: 'stepslist' },
          h('li', null, h('b', null, 'Open your Google Sheet copy'), ' in your browser.'),
          h('li', null, 'In the top menu click ', h('b', null, 'Extensions'), ', then ', h('b', null, 'Apps Script'), '. A new browser tab opens. This is the script editor.'),
          h('li', null, 'In the left column, next to the word ', h('b', null, 'Files'), ', click the ', h('b', null, '+'), ' button and choose ', h('b', null, 'Script'), '. Type the name ', h('b', null, 'School Info Export'), ' and press Enter. ',
            h('b', null, 'Add a new file: '), 'do not paste over a file that is already there. If the project already has other scripts, leave them alone.'),
          h('li', null, 'Press the button below to copy the script.', h('div', { class: 'runbtns' }, copyBtn), out, version),
          h('li', null, 'Click inside the empty file in the editor and press ', ...key('Ctrl', 'A'), ' and then ', ...key('Ctrl', 'V'), ' to paste the script. You should see a long list of code.'),
          h('li', null, h('b', null, 'Optional: '), 'near the top of the code find the line ', h('code', null, 'NOTIFY_EMAILS: \'\','), ' and type the email addresses between the two quote marks, separated by commas. Those people get one email a day listing the schools that were loaded. You can do this later.'),
          h('li', null, 'Click the ', h('b', null, 'Save'), ' button (the disk icon) or press ', ...key('Ctrl', 'S'), '.'),
          h('li', null, 'Go back to your Google Sheet tab and ', h('b', null, 'reload the page'), ' (press ', ...key('F5'), '). After a few seconds a new menu called ', h('b', null, 'School Info'), ' appears after Help. If it does not, see “I do not see the School Info menu” below.'),
          h('li', null, h('b', null, 'The first time'), ' you use the menu, Google asks you to allow the script. Click ', h('b', null, 'School Info → Load export file…'), ', then ', h('b', null, 'Continue'), ' and choose your Google account. If it says “Google hasn’t verified this app”, click ', h('b', null, 'Advanced'), ', then ', h('b', null, 'Go to School Info Export (unsafe)'), ', then ', h('b', null, 'Allow'), '. It is your own script. It asks to see and edit this spreadsheet (to fill in the cells), to show its window, and to send the daily email.')),
        showCode),

      h('div', { class: 'panel' }, h('h2', null, 'Part 2: load the answers into your sheet (every time)'),
        h('ol', { class: 'stepslist' },
          h('li', null, h('b', null, 'Make the file in this dashboard. '), 'Open one school and press ', h('b', null, 'File for Google Sheet'), ', or press the button below for every checked school.', h('div', { class: 'runbtns' }, dlBtn), out2,
            h('span', { class: 'muted small' }, 'The file is named school-info-export-….json and goes to your Downloads folder. It holds only what was found on the school websites: nothing from your sheet, and no keys.')),
          h('li', null, 'In your Google Sheet click ', h('b', null, 'School Info → Load export file…'), '.'),
          h('li', null, 'Click ', h('b', null, 'Choose file'), ', pick the file you just downloaded, then click ', h('b', null, 'Load into this sheet'), '.'),
          h('li', null, h('b', null, 'Keep that window open until it says Done. '), 'It loads one school at a time, a few seconds each, so a file with every school takes a while. If it stops or a school fails, load the same file again: that is safe, because nothing already written is changed.'),
          h('li', null, 'Open a school’s tab and look at the colours. Point at a coloured cell to read its note. When a school has been checked, tick ', h('b', null, 'Reviewed?'), ' on the ', h('b', null, 'Export Log'), ' tab.')),
        colourKey(true)),

      h('div', { class: 'panel' }, h('h2', null, 'Optional: a daily email'),
        h('p', null, 'In the sheet click ', h('b', null, 'School Info → Start the daily email'), '. Each day at about 5 pm (the sheet’s time zone) the people listed in ', h('code', null, 'NOTIFY_EMAILS'), ' get one email listing the schools that were loaded since the last one, so someone can fact check them. Loading works without it.')),

      h('div', { class: 'panel' }, h('h2', null, 'Updating the script later'),
        h('p', null, 'When this dashboard gets a newer script, open ', h('b', null, 'Extensions → Apps Script'), ' in your sheet, click the ', h('b', null, 'School Info Export'), ' file, press ', ...key('Ctrl', 'A'), ', press the ', h('b', null, 'Copy the script'), ' button above, paste with ', ...key('Ctrl', 'V'), ', and save. You do not need to allow it again. The version of the script in your sheet is on the line ', h('code', null, 'var VERSION'), ' near the top of the file.')),

      h('div', { class: 'panel' }, h('h2', null, 'If something goes wrong'),
        problem('I do not see the School Info menu.', 'Reload the sheet and wait a few seconds. If it is still missing, go to the Apps Script tab, choose ', h('b', null, 'onOpen'), ' in the function list at the top (next to Run) and press ', h('b', null, 'Run'), ' once, answer Google’s permission questions, then reload the sheet.'),
        problem('Google says “Authorization required” or “hasn’t verified this app”.', 'This is expected for your own script. Click Continue and choose your account. Then click Advanced, then Go to School Info Export (unsafe), then Allow.'),
        problem('Nothing happens, or it says a function cannot be found.', 'The pasted code is probably incomplete. In the editor press Ctrl + A, press Delete, use Copy the script again, paste with Ctrl + V, and Save.'),
        problem('It stopped halfway, or one school failed.', 'Load the same file again. Loading the same file twice is safe: notes do not pile up and nothing already written is changed.'),
        problem('A cell did not turn yellow.', 'Yellow is only for cells that were blank. A cell that already had text is left alone (orange with a note if the website says something different), and a cell that already has a colour of its own keeps it.'),
        problem('A school has no tab in my sheet.', 'The script makes a new tab for it from your Master Template.'),
        problem('My project already has a function called onOpen.', 'A project can have only one onOpen. Ask whoever looks after those scripts to join the two, or run the School Info menu from the other script’s onOpen.')),
      h('p', { class: 'muted small' }, 'Google sometimes changes the wording of its menus a little. The steps stay the same. There is also an advanced “send with one click” option for companies that allow it: see ', h('a', { href: '#/start' }, 'Start here'), ', under Advanced.'));
  }

  // ------------------------------------------------------------- help view ---
  // The plain-words guide: what the dashboard is, how to use it, and what every word and colour means.
  function viewHelp(section) {
    const chipOf = (pair) => chip(pair);
    const term = (label, text) => [h('dt', null, label), h('dd', null, text)];
    const TOC = [['what', 'What it is for'], ['guide', 'Quick guide'], ['ratings', 'Ratings (Safe to use…)'], ['colours', 'Colours in your sheet and Excel files'], ['labels', 'Labels on a school page'], ['status', 'Status and Tier'], ['blocked', 'A website will not let us in'], ['questions', 'Common questions']];
    // a link such as #/help/colours opens the page already scrolled to that section
    requestAnimationFrame(() => {
      const el = section ? document.getElementById('help-' + section) : null;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start' });
      else if (!section) window.scrollTo(0, 0);
    });
    setKids(app,
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Help: what everything means'),
        h('p', null, 'A short guide in plain words. You do not need any technical knowledge to use this dashboard.'))),
      h('nav', { class: 'toc', 'aria-label': 'Jump to a section' }, h('b', null, 'Jump to: '), TOC.map(([id, text]) => h('a', { href: '#/help/' + id }, text))),
      h('div', { class: 'panel', id: 'help-what' }, h('h2', null, 'What is this dashboard for?'),
        h('p', null, 'Your School Information Sheet has a long list of questions about each private school: tuition, class sizes, deadlines, and so on. Finding the answers means reading every school’s website. This dashboard does the reading for you. It opens each school’s own website, finds the answers, and shows them next to what your sheet says now, so you can copy the answers you want.'),
        h('p', null, 'It never changes your sheet. It only shows you answers and lets you copy them.')),
      h('div', { class: 'panel', id: 'help-guide' }, h('h2', null, 'The quick guide'),
        h('ol', null,
          h('li', null, h('b', null, 'Start here: '), 'load your School Information Sheet once. Then press “Start checking websites”.'),
          h('li', null, h('b', null, 'Check websites: '), 'choose a group of schools (a “tier”) and press Start checking. A big group can take an hour or more, so keep the computer awake.'),
          h('li', null, h('b', null, 'Schools: '), 'open a school to see its answers. The right-hand column is what the school’s own website says. Press Copy to copy an answer.'),
          h('li', null, h('b', null, 'To check: '), 'this list shows only the answers the dashboard is not sure about, so you do not have to look at everything.'),
          h('li', null, h('b', null, 'Download: '), 'get everything as an Excel file from the Start here page or from any school.'))),
      h('div', { class: 'panel', id: 'help-ratings' }, h('h2', null, 'How sure is the dashboard? (the colour tags)'),
        h('p', null, 'Every important answer has a rating out of 100 and one of three tags:'),
        h('dl', { class: 'glossary' },
          ...term(h('span', { class: 'trust high' }, 'Safe to use'), 'The answer came from a very reliable page (the school’s own fact sheet or its page about that topic) and the page states it clearly. You can copy it without checking.'),
          ...term(h('span', { class: 'trust medium' }, 'Quick look'), 'Probably right, but open the school’s page and check it before you copy it.'),
          ...term(h('span', { class: 'trust low' }, 'Check this'), 'The dashboard is not sure. For example the page does not say which school year the number is for, or the number may cover the whole school and not just one division. A person should look.')),
        h('p', null, h('b', null, 'How is the rating worked out? '), 'From where the answer came from (the school’s own fact sheet is the most reliable, a news post the least), how clearly the website says it, whether the same answer appears on several pages, and whether the answer looks reasonable. Click “Why this rating?” under any answer to see the exact reasons.'),
        h('p', null, h('b', null, 'Why does it ignore my sheet? '), 'Because your sheet can be out of date or have mistakes. An answer is trusted for where it came from, not for matching a spreadsheet.'),
        h('p', null, h('b', null, 'Is “Safe to use” always right? '), 'No. It means the evidence is strong, not that it is certain. The ✓ Right and ✗ Wrong buttons let you check, and the Accuracy page shows how often the ratings turn out to be right.')),
      h('div', { class: 'panel', id: 'help-colours' }, h('h2', null, 'What the colours mean in your Google Sheet and Excel files'),
        h('p', null, 'When you send answers to your Google Sheet (open the sheet, then ', h('b', null, 'School Info → Load export file…'), ') or download the Excel file, some cells are coloured to show what happened to them. The dashboard never changes your own sheet file. The School Info menu needs a one-time setup: ', h('a', { href: '#/sheet-setup' }, 'step by step'), '. Here is the key:'),
        colourKey(false),
        h('h3', null, 'The colours inside this dashboard'),
        h('dl', { class: 'glossary' },
          ...term(chip(['Green', 'ok']), 'Good news: safe to use, checked, or the same as your sheet.'),
          ...term(chip(['Amber', 'warn']), 'Take a quick look: a different answer, a website that blocked us, or an answer to check.'),
          ...term(chip(['Red', 'bad']), 'Needs a person: the dashboard is not sure, or a website would not open.'),
          ...term(chip(['Blue', 'info']), 'Information: for example, the website can fill a blank in your sheet, or an answer changed on the school’s website.'))),
      h('div', { class: 'panel', id: 'help-labels' }, h('h2', null, 'What the labels on a school page mean'),
        h('dl', { class: 'glossary' },
          ...term(chipOf(VERDICT.match), 'The website and your sheet say the same thing.'),
          ...term(chipOf(VERDICT.differs), 'They say different things. The website may be right and your sheet out of date, so open the school’s page and see.'),
          ...term(chipOf(VERDICT.fills), 'Your sheet is empty here, and the website has an answer you can copy in.'),
          ...term(chipOf(VERDICT.both), 'Both have an answer, but the wording is different so the dashboard cannot say whether they agree. Compare them yourself.'),
          ...term(chipOf(VERDICT['sheet-only']), 'The website did not give an answer, but your sheet already has one. Nothing to do.'),
          ...term(chipOf(VERDICT.none), 'Neither your sheet nor the website has an answer.'),
          ...term(chipOf(VERDICT.manual), 'This question is never answered by a website (for example, things people have to find out by phone), so fill it in by hand.'))),
      h('div', { class: 'panel', id: 'help-status' }, h('h2', null, 'The status of a school'),
        h('dl', { class: 'glossary' },
          ...term(chipOf(STATUS.ok), 'The dashboard has read this school’s website.'),
          ...term(chipOf(STATUS['not-scraped']), 'Nobody has checked this school’s website yet.'),
          ...term(chipOf(STATUS.blocked), ['The school’s website stops automatic readers. You can save its pages in your own browser and add them on the school’s page. ', helpLink('blocked', 'How?')]),
          ...term(chipOf(STATUS.error), 'The website did not open. The link in your sheet may be old or wrong.'),
          ...term(chipOf(STATUS.thin), 'The website shows its text in a way the dashboard cannot read. Open it yourself.'),
          ...term(chipOf(STATUS.robots), 'The website asks automatic programs not to read it, and the dashboard respects that.'),
          ...term(chipOf(STATUS['no-website']), 'Your sheet has no website link for this school.'),
          ...term('Tier', 'The priority group from your sheet. Tier 1 is the most important schools.'),
          ...term('check link?', 'The website never mentions the school’s name, so the link in your sheet may belong to a different school.'))),
      h('div', { class: 'panel', id: 'help-blocked' }, h('h2', null, 'A school’s website will not let the dashboard in'),
        h('p', null, 'A few schools protect their website with a security check (a page that says “Just a moment…”), so the dashboard shows ', chipOf(STATUS.blocked), '. The dashboard respects that and never tries to get around it. There are two good ways forward:'),
        h('ol', null,
          h('li', null, h('b', null, 'Save the pages yourself. '), 'This works today. Open the school’s pages in your own browser, press Ctrl + S and save it as “Webpage, Complete”, then add the .html files on the school’s page (the box says “add pages you saved yourself”). The dashboard reads them like any website, and marks the answers as read from saved pages. Do it again whenever you want fresh answers.'),
          h('li', null, h('b', null, 'Ask the school to let the dashboard in. '), 'This fixes it for good. Send the school’s website or admissions team a note like the one below.')),
        h('blockquote', { class: 'letter' },
          'Hello, we are Cardinal Education. We keep a School Information Sheet for families, using only facts that are public on schools’ own websites. Our small program reads one page at a time, follows your robots.txt, and names itself “SchoolInfoSheetBot/1.0 (polite research crawler; reads public school pages only)”. Your website’s security check currently stops it. Could your web team allow that name, or send us your current fact sheet (tuition, dates, enrollment, class sizes)? Thank you.')),
      h('div', { class: 'panel', id: 'help-questions' }, h('h2', null, 'Common questions'),
        h('details', null, h('summary', null, 'Do I have to wait while the sheet loads, or while websites are checked?'), h('p', null, 'No. Loading your sheet, checking websites, making a file, adding a teammate’s results and waiting for an Ask answer all keep going while you open other pages. A small card at the bottom right of every page shows what is running, and tells you when it is done with a link to the result. Checking websites also shows in the bar at the top. Just do not turn the dashboard off or close the browser window while something is running.')),
        h('details', null, h('summary', null, 'How do I install the Google Sheet script (the School Info menu)?'), h('p', null, 'It takes about 5 minutes and you do it once for each Google Sheet. The dashboard has the script to copy and every step on its own page: ', h('a', { href: '#/sheet-setup' }, 'Set up the Google Sheet menu, step by step'), '.')),
        h('details', null, h('summary', null, 'What do the yellow and orange cells in my Google Sheet mean?'), h('p', null, 'Yellow: a blank cell the dashboard filled in from the school’s website. Orange: your sheet already had a different answer, so nothing was overwritten and the website’s answer is in the cell’s note. Point at a cell to read its note. ', helpLink('colours', 'See the full colour key'), '.')),
        h('details', null, h('summary', null, 'Does the dashboard change my Google Sheet?'), h('p', null, 'No. It only reads the file you give it. You copy the answers yourself, or use the buttons to send answers to a copy of your sheet.')),
        h('details', null, h('summary', null, 'Why is an answer missing?'), h('p', null, 'Either the school does not publish it, or it is behind a login (such as an application portal), or the website is built in a way the dashboard cannot read. These are filled in by hand.')),
        h('details', null, h('summary', null, 'How do I know the answer came from the right website?'), h('p', null, 'Under every answer, “From:” shows the page it was found on. Press “Show the words from the website” to see the exact sentence. If a school is marked “check link?”, the website in your sheet may belong to a different school, so fix the link first.')),
        h('details', null, h('summary', null, 'What is the “Ask” page?'), h('p', null, 'An optional AI assistant. You type a question in plain English, such as “Which Tier 1 schools have not been checked yet?”, and it answers from the saved results. You do not need it to use the rest of the dashboard.')),
        h('details', null, h('summary', null, 'What does “Check this website again” do?'), h('p', null, 'It reads that school’s website again and shows you anything that changed since the last time. It does not erase your ✓ Right and ✗ Wrong marks unless an answer has changed.')),
        h('details', null, h('summary', null, 'Something looks wrong. Who do I tell?'), h('p', null, 'Press ✗ Wrong on the answer and type the right one if you know it. Then tell whoever looks after this dashboard. Those marks help them fix the problem.'))));
  }

  // ----------------------------------------------------------------- router ---
  async function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    let view = hash.split('/')[0];
    if (STATIC && (view === 'run' || view === 'start' || view === 'ask' || view === 'sheet-setup' || view === 'sources' || view === 'receive')) { view = 'schools'; history.replaceState(null, '', '#/'); }
    if (STATIC && (view === 'accuracy' || view === 'review')) { view = 'schools'; history.replaceState(null, '', '#/'); }
    runUi = null; askUi = null;
    if (S.receiveHandler) { window.removeEventListener('message', S.receiveHandler); S.receiveHandler = null; }   // the save window listens only while it is shown
    document.body.classList.toggle('receivemode', view === 'receive' && !STATIC);
    try {
      if (!S.ov) { app.replaceChildren(h('p', { class: 'loading' }, 'Loading…')); await loadOverview(); }
      // with no page chosen, open Start here until a sheet has been loaded, then the school list
      if (!view) view = !STATIC && S.ov && !S.ov.ready ? 'start' : 'schools';
      S.view = view;
      for (const t of [...TASKS.values()]) if (t.hideOnView === view && t.state !== 'running') TASKS.delete(t.id);   // already seen on its own page
      drawTasks();   // a card meant for another page (such as Ask's) hides itself on that page
      const TITLES = { start: 'Start here', run: 'Check websites', sources: 'Ravenna and other sources', ask: 'Ask', accuracy: 'Accuracy', review: 'To check', help: 'Help', script: 'Technical details', 'sheet-setup': 'Google Sheet setup' };
      document.title = (view === 'school' ? 'School' : TITLES[view] || 'Schools') + ' · School Info Sheet';   // tells browser tabs apart
      document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === (view === 'school' ? 'schools' : view)));
      if (view === 'start') return await viewStart();
      if (view === 'school') return await viewSchool(decodeURIComponent(hash.slice('school/'.length)));
      if (view === 'run') return viewRun();
      if (view === 'sources') return await viewSources(hash.split('/')[1]);
      if (view === 'receive') return await viewReceive();
      if (view === 'ask') return await viewAsk();
      if (view === 'accuracy') return await viewAccuracy();
      if (view === 'review') return await viewReview();
      if (view === 'help') return viewHelp(hash.split('/')[1]);
      if (view === 'sheet-setup') return await viewSheetSetup();
      if (view === 'script') return await viewScript(hash.slice('script/'.length));
      return viewSchools();
    } catch (e) {
      app.replaceChildren(h('div', { class: 'notice' }, 'Something went wrong: ' + e.message));
    }
  }

  // ------------------------------------------------------------ job polling ---
  let timer = null;
  async function poll(now) {
    clearTimeout(timer);
    if (now !== true && document.hidden && !(S.job && S.job.running)) { timer = setTimeout(poll, 5000); return; }
    try {
      const j = await api('/api/job?since=' + S.since);
      if (j.log && j.log.length) {
        S.log.push(...j.log);
        S.since = j.log[j.log.length - 1].n;
        if (S.log.length > 500) S.log.splice(0, S.log.length - 500);
      }
      const was = !!(S.job && S.job.running);
      S.job = j;
      pill.hidden = !j.running;
      if (j.running) pill.textContent = `Checking websites: ${j.done} of ${j.schools || '?'} schools`;
      drawJob();
      if (was && !j.running) {
        await loadOverview();
        if (S.view !== 'run') {
          // say it is finished wherever the person is, and only refresh pages that show the results (never the Ask page or a school they are reading)
          const bad = !!j.exitCode && !j.stopped;
          endTask('checking', {
            failed: bad, title: j.stopped ? 'Checking was stopped' : bad ? 'Checking stopped early' : 'Checking the websites is finished',
            message: `${j.done || 0} of ${j.schools || '?'} schools checked.`, link: '#/', linkText: 'Open the school list',
          });
          refreshIfOn('schools', 'review', 'start');
        }
      } else if (j.running && S.view === 'schools' && Date.now() - lastOverview > 30000 && !(document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName))) {
        // while a check runs, the list fills in as schools finish
        await loadOverview();
        if (S.view === 'schools') { const y = window.scrollY; viewSchools(); window.scrollTo(0, y); }
      }
    } catch { /* the server may be restarting; try again */ }
    timer = setTimeout(poll, S.job && S.job.running ? 1500 : 5000);
  }

  // who is signed in (hosted) and local footer controls (data folder + Turn off dashboard)
  async function initControls() {
    const el = document.getElementById('who');
    const quit = document.getElementById('quitbtn');
    const loc = document.getElementById('dataloc');
    try {
      const me = await api('/api/me');
      if (me.email && el) { el.replaceChildren(`Signed in as ${me.email}`, h('a', { href: '/auth/logout' }, 'Sign out')); el.hidden = false; }
      if (me.local && quit) {
        quit.hidden = false;
        quit.onclick = async () => {
          const msg = S.job && S.job.running
            ? 'A website check is still running. Stop it and turn off the dashboard?'
            : 'Turn off the dashboard? Your saved sheets and website results will be kept.';
          if (!confirm(msg)) return;
          quit.disabled = true;
          clearTimeout(timer);
          try { await api('/api/shutdown', {}); } catch { /* connection closes as server exits */ }
          pill.hidden = true;
          quit.hidden = true;
          app.replaceChildren(h('div', { class: 'panel' },
            h('h2', null, 'Dashboard turned off'),
            h('p', null, 'Your saved data is safe. Double-click “Start Dashboard” whenever you want to open it again — you can close this browser tab now.')));
        };
      }
      if (me.local && loc) {
        api('/api/setup').then((st) => {
          if (st && st.dataDir) { loc.textContent = 'Private to this PC · Data folder: ' + st.dataDir; loc.hidden = false; }
        }).catch(() => {});
      }
    } catch { /* not signed in: the page is about to move to the sign-in */ }
  }

  // Reading comfort: bigger text and a light / dark switch, remembered on this computer.
  function initViewOptions() {
    const box = document.getElementById('viewopts');
    const root = document.documentElement;
    if (!box || !root) return;
    const store = {
      get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* it just will not be remembered */ } },
    };
    const SIZES = [1, 1.12, 1.25, 1.4];
    let size = Math.max(0, Math.min(SIZES.length - 1, Math.trunc(Number(store.get('sis-size')) || 0)));
    const saved = store.get('sis-theme');
    if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
    const isDark = () => (root.dataset.theme ? root.dataset.theme === 'dark' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
    const smaller = h('button', { type: 'button', class: 'btn small', title: 'Make the text smaller', 'aria-label': 'Make the text smaller' }, 'A−');
    const bigger = h('button', { type: 'button', class: 'btn small', title: 'Make the text bigger', 'aria-label': 'Make the text bigger' }, 'A+');
    const theme = h('button', { type: 'button', class: 'btn small', title: 'Switch between a light and a dark page' });
    const apply = () => {
      document.body.style.zoom = size ? String(SIZES[size]) : '';
      smaller.disabled = size === 0; bigger.disabled = size === SIZES.length - 1;
      theme.textContent = isDark() ? '☀ Light' : '☾ Dark';
    };
    smaller.onclick = () => { size = Math.max(0, size - 1); store.set('sis-size', String(size)); apply(); };
    bigger.onclick = () => { size = Math.min(SIZES.length - 1, size + 1); store.set('sis-size', String(size)); apply(); };
    theme.onclick = () => { root.dataset.theme = isDark() ? 'light' : 'dark'; store.set('sis-theme', root.dataset.theme); apply(); };
    setKids(box, smaller, bigger, theme);
    apply();
  }

  window.addEventListener('hashchange', route);
  initViewOptions();
  route().then(() => { if (!STATIC) { poll(true); initControls(); } });
})();
