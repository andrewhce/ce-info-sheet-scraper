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

  async function downloadSpreadsheet(params) {
    const q = new URLSearchParams(params).toString();
    const r = await checkedFetch('/api/export-spreadsheet?' + q, undefined, 'Could not create spreadsheet.');
    const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || ('school-info.' + (params.format || 'xlsx'));
    triggerBlobDownload(await r.blob(), name);
    return { name, count: Number(r.headers.get('X-Export-Count')) || 0 };
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
    blocked: 'This website stops automatic readers. Open the school’s website yourself to fill in the missing answers.',
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
      ['differs', 'Different from sheet', 'num'], ['look', 'Needs checking', 'num'], ['scrapedAt', 'Last checked'], ...(STATIC ? [] : [['exportedAt', 'Sent to Google Sheet']]), [null, 'Website'],
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
          h('td', { class: 'name' }, h('a', { href }, s.name), h('span', { class: 'sub' }, s.region || '')),
          h('td', null, s.tier == null ? '' : s.tier),
          h('td', null, chip(STATUS[s.status] || [s.status, ''], tip || null),
            s.changesCount > 0 ? [' ', h('span', { class: 'chip info', title: `${s.changesCount} answer${s.changesCount === 1 ? '' : 's'} on the school’s website changed since the last check: ${chSummary}` }, `${s.changesCount} changed`)] : null,
            chSummary ? h('span', { class: 'sub' }, chSummary) : null),
          h('td', { class: 'num' }, s.status === 'ok' ? [h('span', { class: 'meter' }, (() => { const i = h('i'); i.style.width = Math.min(100, Math.max(0, Math.round((found / total) * 100))) + '%'; return i; })()), `${found} / ${total}`] : ''),
          h('td', { class: 'num' }, s.status === 'ok' ? (s.fills ?? 0) : ''),
          h('td', { class: 'num' }, s.status === 'ok' ? (s.differs ?? 0) : ''),
          h('td', { class: 'num' }, s.status === 'ok' && s.look != null
            ? h('span', { class: 'chip ' + (s.look ? (s.doubtful ? 'bad' : 'warn') : 'ok'), title: `Main facts: ${s.ready} safe to use, ${s.check} need a quick look, ${s.doubtful} need checking` }, s.look ? String(s.look) : 'all safe') : ''),
          h('td', { class: 'small muted' }, ago(s.scrapedAt)),
          STATIC ? null : h('td', { class: 'small muted' }, s.exportedAt ? ago(s.exportedAt) : ''),
          h('td', { class: 'small' }, s.website ? ext(s.website, shortUrl(s.website).split('/')[0]) : h('span', { class: 'muted' }, 'none'),
            s.urlChanged ? [' ', h('span', { class: 'chip warn', title: 'The website link in your sheet changed since this school was last checked, so check it again.' }, 'link changed')] : null,
            s.wrongSite ? [' ', h('span', { class: 'chip warn', title: 'This website never mentions the school’s name, so the link in your sheet may point to the wrong school. Please check it.' }, 'check link?')] : null));
      }));
    };
    const search = h('input', { type: 'search', placeholder: 'Search school or region', 'aria-label': 'Search school or region', value: S.q, oninput: (e) => { S.q = e.target.value; draw(); } });
    const tierSel = h('select', { 'aria-label': 'Tier', onchange: (e) => { S.tier = e.target.value; draw(); } }, [['', 'All tiers'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3']].map(([v, t]) => h('option', { value: v }, t)));
    tierSel.value = S.tier;
    setKids(
      app,
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Schools'),
        h('p', null, 'Every school in your sheet. The dashboard reads each school’s own website and shows what it found next to what your sheet says. Click a number card to show only those schools, or click a school to see its answers and copy them.'),
        STATIC && ov.generatedAt ? h('p', { class: 'snapshot' }, `Read-only copy of the results as of ${new Date(ov.generatedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. It does not update by itself.`) : null)),
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

  // ------------------------------------------------------------ school view ---
  async function viewSchool(id, tabIndex) {
    app.replaceChildren(h('p', { class: 'loading' }, 'Loading…'));
    let d;
    try { d = await api(`/api/school?id=${encodeURIComponent(id)}&tab=${tabIndex || 0}`); } catch (e) {
      app.replaceChildren(h('a', { class: 'crumb', href: '#/' }, '← All schools'), h('div', { class: 'notice' }, e.message));
      return;
    }
    const s = d.school, r = d.result;
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
        h('div', { class: 'src' }, 'From: ', srcs.map((x, i) => [i ? ', ' : '', ext(x.url, null, x.title)]),
          // the old match mark only says how the rule found the text, not whether it is true: key facts show the rating instead, copied text sections keep it
          row.trust ? null : h('span', { class: 'conf ' + f.confidence, title: 'Exact match: a clearly labelled figure. Probable match: a relevant sentence or section. Please double-check: found by a keyword only.' }, CONF_LABEL[f.confidence] || (f.confidence + ' confidence'))),
        f.note ? h('div', { class: 'note' }, f.note) : null,
        row.trust ? trustLine(row.trust) : null,
        h('details', null, h('summary', null, 'Show the words from the website' + (f.alts ? ` and ${f.alts.length} other possible answer${f.alts.length === 1 ? '' : 's'}` : '')),
          h('div', { class: 'evidence' }, f.snippet || ''),
          f.alts ? h('ul', { class: 'alts' }, f.alts.map((a) => h('li', null, a.value.length > 220 ? a.value.slice(0, 220) + '…' : a.value, ' — ', ext(a.url)))) : null),
      ];
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
          h('div', { class: 'cell', 'data-title': 'What the school’s website says' }, scrapedCell(row), verifyControl(row))));
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
      try { showExport(await api('/api/export', { id: s.id, tab: d.tabIndex })); exportBtn.textContent = 'Send to Google Sheet again'; } catch (e) {
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
          `“${f.name}” is in your Downloads folder. In Google Sheets open School Info → Load export file... and pick it.`));
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
        h('li', null, 'A different answer from your sheet does not mean the website is wrong. Your sheet may simply be out of date.'))) : null;

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
            r ? h('span', null, `Last checked ${ago(r.scrapedAt)}; read ${r.pages.length} pages of the website`) : null),
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
      wrongSite, urlChangedNotice, notice, siteChanges, exportBox, guideBox, filterBox, rowsBox,
      r && r.pages.length ? h('details', { class: 'panel' }, h('summary', null, `Pages read on this website (${r.pages.length})`),
        h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Page'), h('th', null, 'Looks like a page about'), h('th', { class: 'num' }, 'Amount of text'))),
          h('tbody', null, r.pages.map((p) => h('tr', null,
            h('td', null, p.title || '(untitled)', h('span', { class: 'sub' }, ext(p.url))),
            h('td', { class: 'small' }, (p.topics || []).join(', ') + (p.kind === 'pdf' ? ' (PDF)' : '')),
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
    const r = await checkedFetch('/api/export-file?' + query, undefined, 'The file could not be made.');
    const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'school-info-export.json';
    triggerBlobDownload(await r.blob(), name);
    return { name, count: Number(r.headers.get('X-Export-Count')) || 0, skipped: Number(r.headers.get('X-Export-Skipped')) || 0, wrongSite: Number(r.headers.get('X-Export-Wrong-Site')) || 0 };
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
      h('p', { class: 'small' }, h('b', null, 'Set up once in your Google Sheet copy: '), 'click Extensions → Apps Script, replace or add a Script file with the copied code, click Save, and reload your sheet.'),
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
      zone.classList.add('busy'); detail.hidden = true;
      say(`Reading “${file.name}”. This takes about 30 seconds.`);
      try {
        const r = await checkedFetch('/api/workbook', { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: file }, 'The upload did not work.');
        const j = await r.json().catch(() => ({}));
        await loadOverview();
        say('Done. Your school list is ready.');
        detail.textContent = j.output || ''; detail.hidden = !j.output;
        if (onDone) onDone();
      } catch (e) { say(e.message, true); } finally { zone.classList.remove('busy'); input.value = ''; }
    }
    zone.onclick = () => input.click();
    zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
    input.onchange = () => send(input.files[0]);
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add('over'); };
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove('over'); send(e.dataTransfer.files[0]); };
    const reread = h('button', { class: 'btn link small', type: 'button' }, 'Re-read the file that is already loaded');
    reread.onclick = async () => {
      reread.disabled = true; say('Reading the file again. This takes about 30 seconds.');
      try { const j = await api('/api/import', {}); await loadOverview(); say('Done.'); detail.textContent = j.output || ''; detail.hidden = !j.output; if (onDone) onDone(); } catch (e) { say(e.message, true); }
      reread.disabled = false;
    };
    return h('div', { class: 'panel stepcard' },
      h('div', { class: 'stephead' },
        h('span', { class: 'stepnum' }, '1'),
        h('h2', null, 'Load your school sheet'),
        canReread ? chip(['Done', 'ok']) : chip(['Waiting for your file', 'warn'])),
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
      zone.classList.add('busy');
      say(`Adding the results in “${file.name}”…`);
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
      } catch (e) { say(e.message, true); } finally { zone.classList.remove('busy'); input.value = ''; }
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
      out);
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
        h('p', { class: 'muted small' }, 'Tier is the priority group from your sheet (Tier 1 is the most important). A big group takes a long time: about an hour for 65 schools. Keep this computer awake while it works.'),
        ov.ready ? [
          h('div', { class: 'pickrow', role: 'group', 'aria-label': 'Which schools to check' }, pills),
          h('label', { class: 'check', for: 'refresh' }, refresh, 'Read every website again from scratch (slower). Leave this unticked to reuse pages read in the last 7 days.'),
          pickSummary,
          h('div', { class: 'runbtns' }, startBtn),
          h('p', { class: 'muted small' }, 'The dashboard works on several schools at the same time, but only opens one page at a time from each school, so it never overloads a website. You can keep looking at schools in another tab while it works. Press Stop at any time: schools that are already finished stay saved.'),
        ] : h('p', null, 'Load your sheet first on the ', h('a', { href: '#/start' }, 'Start here'), ' page.')),
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
      h('div', { class: 'runbtns' }, btn), p.message ? h('p', { class: 'small ' + (p.bad ? 'bad' : 'good') }, p.message) : null);
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
      box.append(h('p', { class: 'muted small' }, message || 'Ask is not connected on this server yet. Contact your dashboard admin to enable it.'));
      return box;
    }
    const locked = st.locked || {};
    const box = h('details', { class: 'panel asksettings', open: !!message });
    box.append(h('summary', null, st.ready ? 'AI settings' : 'Optional AI settings (not connected yet)'));
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
    if (!q.ready) { setKids(app, h('div', { class: 'notice' }, 'Load your sheet and check some school websites first.')); return; }
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
      h('td', { class: 'small' }, i.why.map((w) => h('div', null, w)))));
    setKids(app,
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Answers to check'),
        h('p', null, 'These are the answers the dashboard is least sure about, the least certain first. Its rating looks at where an answer came from (the school’s own fact sheet, or its page on that topic, is the most reliable) and how clearly the website says it. It never looks at your sheet. Answers it is sure about are left out, so you only spend time where a person is needed. Open a school and press ✓ Right or ✗ Wrong: answers you check disappear from this list.'))),
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

  // ------------------------------------------------------------- help view ---
  // The plain-words guide: what the dashboard is, how to use it, and what every word and colour means.
  function viewHelp() {
    const chipOf = (pair) => chip(pair);
    const term = (label, text) => [h('dt', null, label), h('dd', null, text)];
    setKids(app,
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Help: what everything means'),
        h('p', null, 'A short guide in plain words. You do not need any technical knowledge to use this dashboard.'))),
      h('div', { class: 'panel' }, h('h2', null, 'What is this dashboard for?'),
        h('p', null, 'Your School Information Sheet has a long list of questions about each private school: tuition, class sizes, deadlines, and so on. Finding the answers means reading every school’s website. This dashboard does the reading for you. It opens each school’s own website, finds the answers, and shows them next to what your sheet says now, so you can copy the answers you want.'),
        h('p', null, 'It never changes your sheet. It only shows you answers and lets you copy them.')),
      h('div', { class: 'panel' }, h('h2', null, 'The quick guide'),
        h('ol', null,
          h('li', null, h('b', null, 'Start here: '), 'load your School Information Sheet once. Then press “Start checking websites”.'),
          h('li', null, h('b', null, 'Check websites: '), 'choose a group of schools (a “tier”) and press Start checking. It takes a while (about an hour for 65 schools), so keep the computer awake.'),
          h('li', null, h('b', null, 'Schools: '), 'open a school to see its answers. The right-hand column is what the school’s own website says. Press Copy to copy an answer.'),
          h('li', null, h('b', null, 'To check: '), 'this list shows only the answers the dashboard is not sure about, so you do not have to look at everything.'),
          h('li', null, h('b', null, 'Download: '), 'get everything as an Excel file from the Start here page or from any school.'))),
      h('div', { class: 'panel' }, h('h2', null, 'How sure is the dashboard? (the colour tags)'),
        h('p', null, 'Every important answer has a rating out of 100 and one of three tags:'),
        h('dl', { class: 'glossary' },
          ...term(h('span', { class: 'trust high' }, 'Safe to use'), 'The answer came from a very reliable page (the school’s own fact sheet or its page about that topic) and the page states it clearly. You can copy it without checking.'),
          ...term(h('span', { class: 'trust medium' }, 'Quick look'), 'Probably right, but open the school’s page and check it before you copy it.'),
          ...term(h('span', { class: 'trust low' }, 'Check this'), 'The dashboard is not sure. For example the page does not say which school year the number is for, or the number may cover the whole school and not just one division. A person should look.')),
        h('p', null, h('b', null, 'How is the rating worked out? '), 'From where the answer came from (the school’s own fact sheet is the most reliable, a news post the least), how clearly the website says it, whether the same answer appears on several pages, and whether the answer looks reasonable. Click “Why this rating?” under any answer to see the exact reasons.'),
        h('p', null, h('b', null, 'Why does it ignore my sheet? '), 'Because your sheet can be out of date or have mistakes. An answer is trusted for where it came from, not for matching a spreadsheet.'),
        h('p', null, h('b', null, 'Is “Safe to use” always right? '), 'No. It means the evidence is strong, not that it is certain. The ✓ Right and ✗ Wrong buttons let you check, and the Accuracy page shows how often the ratings turn out to be right.')),
      h('div', { class: 'panel' }, h('h2', null, 'What the labels on a school page mean'),
        h('dl', { class: 'glossary' },
          ...term(chipOf(VERDICT.match), 'The website and your sheet say the same thing.'),
          ...term(chipOf(VERDICT.differs), 'They say different things. The website may be right and your sheet out of date, so open the school’s page and see.'),
          ...term(chipOf(VERDICT.fills), 'Your sheet is empty here, and the website has an answer you can copy in.'),
          ...term(chipOf(VERDICT.both), 'Both have an answer, but the wording is different so the dashboard cannot say whether they agree. Compare them yourself.'),
          ...term(chipOf(VERDICT['sheet-only']), 'The website did not give an answer, but your sheet already has one. Nothing to do.'),
          ...term(chipOf(VERDICT.none), 'Neither your sheet nor the website has an answer.'),
          ...term(chipOf(VERDICT.manual), 'This question is never answered by a website (for example, things people have to find out by phone), so fill it in by hand.'))),
      h('div', { class: 'panel' }, h('h2', null, 'The status of a school'),
        h('dl', { class: 'glossary' },
          ...term(chipOf(STATUS.ok), 'The dashboard has read this school’s website.'),
          ...term(chipOf(STATUS['not-scraped']), 'Nobody has checked this school’s website yet.'),
          ...term(chipOf(STATUS.blocked), 'The school’s website stops automatic readers. Open it yourself to fill in the answers.'),
          ...term(chipOf(STATUS.error), 'The website did not open. The link in your sheet may be old or wrong.'),
          ...term(chipOf(STATUS.thin), 'The website shows its text in a way the dashboard cannot read. Open it yourself.'),
          ...term(chipOf(STATUS.robots), 'The website asks automatic programs not to read it, and the dashboard respects that.'),
          ...term(chipOf(STATUS['no-website']), 'Your sheet has no website link for this school.'),
          ...term('Tier', 'The priority group from your sheet. Tier 1 is the most important schools.'),
          ...term('check link?', 'The website never mentions the school’s name, so the link in your sheet may belong to a different school.'))),
      h('div', { class: 'panel' }, h('h2', null, 'Common questions'),
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
    if (STATIC && (view === 'run' || view === 'start' || view === 'ask')) { view = 'schools'; history.replaceState(null, '', '#/'); }
    if (STATIC && (view === 'accuracy' || view === 'review')) { view = 'schools'; history.replaceState(null, '', '#/'); }
    runUi = null; askUi = null;
    try {
      if (!S.ov) { app.replaceChildren(h('p', { class: 'loading' }, 'Loading…')); await loadOverview(); }
      // with no page chosen, open Start here until a sheet has been loaded, then the school list
      if (!view) view = !STATIC && S.ov && !S.ov.ready ? 'start' : 'schools';
      S.view = view;
      document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === (view === 'school' ? 'schools' : view)));
      if (view === 'start') return await viewStart();
      if (view === 'school') return await viewSchool(decodeURIComponent(hash.slice('school/'.length)));
      if (view === 'run') return viewRun();
      if (view === 'ask') return await viewAsk();
      if (view === 'accuracy') return await viewAccuracy();
      if (view === 'review') return await viewReview();
      if (view === 'help') return viewHelp();
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
        if (S.view !== 'run') route();
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

  window.addEventListener('hashchange', route);
  route().then(() => { if (!STATIC) { poll(true); initControls(); } });
})();
