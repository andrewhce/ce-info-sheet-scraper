(() => {
  'use strict';
  // Dashboard front end. Everything scraped from the web is inserted as plain text,
  // never as HTML, and only http(s) links are made clickable.
  const app = document.getElementById('app');
  const pill = document.getElementById('jobpill');
  // The read-only copy (made by build-static.js) has no server: it reads saved JSON files and has no Run controls.
  const STATIC = document.body.dataset.mode === 'static';
  const S = { ov: null, q: '', tier: '', status: '', sort: 'name', dir: 1, job: null, log: [], since: 0, verdict: 'all', view: '' };

  // ---------------------------------------------------------------- helpers ---
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
    const add = (c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) c.forEach(add);
      else el.append(c.nodeType ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
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
    if (body) throw new Error('This is a read-only copy. Scraping is run on the computer that holds the workbook.');
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
  async function api(path, body) {
    if (STATIC) return staticApi(path, body);
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' }, body: JSON.stringify(body) } : undefined);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.signIn) { location.href = j.signIn; throw new Error('Please sign in again.'); }   // the sign-in has expired
    if (!r.ok) throw new Error(j.error || 'Request failed (' + r.status + ')');
    return j;
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

  const STATUS = {
    'not-scraped': ['Not scraped', ''], ok: ['Scraped', 'ok'], blocked: ['Blocked by site', 'warn'], error: ['Could not load', 'bad'],
    thin: ['No readable text', 'warn'], robots: ['Not allowed', 'warn'], 'no-website': ['No website link', 'bad'],
  };
  const VERDICT = {
    fills: ['Can fill a blank', 'info'], match: ['Matches the sheet', 'ok'], differs: ['Differs from sheet', 'warn'],
    both: ['Both filled', ''], 'sheet-only': ['Only in the sheet', ''], none: ['Not found', ''], manual: ['Not on websites', ''],
  };
  const chip = (pair, title) => h('span', { class: 'chip ' + (pair[1] || ''), title: title || null }, pair[0]);

  /** Long text is clamped with a "Show all" toggle. */
  const pending = [];
  function clamped(text) {
    const val = h('div', { class: 'val clamp' }, text);
    const btn = h('button', { class: 'btn link small', type: 'button', onclick: () => {
      const open = val.classList.toggle('clamp');
      btn.textContent = open ? 'Show all' : 'Show less';
    } }, 'Show all');
    pending.push([val, btn]);
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
      if (S.status === 'problem') return !['ok', 'not-scraped'].includes(s.status);
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
        h('p', null, 'Load your School Information Sheet first. It gives the program the Master Template and the PSTP Schools list.'),
        h('a', { class: 'btn primary', href: '#/start' }, 'Go to Start here')));
      return;
    }
    const scraped = ov.schools.filter((s) => s.status === 'ok');
    const problems = ov.schools.filter((s) => !['ok', 'not-scraped'].includes(s.status));
    const sum = (k) => scraped.reduce((n, s) => n + (s[k] || 0), 0);
    const stat = (n, label) => h('div', { class: 'stat' }, h('b', null, n), h('span', null, label));
    const tbody = h('tbody');
    const count = h('span', { class: 'muted small' });
    const scrapeBtn = h('button', { class: 'btn', type: 'button', onclick: () => {
      const ids = filtered().map((s) => s.id);
      if (!ids.length) return;
      if (ids.length > 400) return alert('Narrow the list to 400 schools or fewer, or use the Run scraper page.');
      if (confirm(`Scrape the ${ids.length} school${ids.length === 1 ? '' : 's'} shown in the list now?`)) startRun({ scope: 'schools', ids });
    } });
    const cols = [['name', 'School'], ['tier', 'Tier'], ['status', 'Status'], ['found', 'Fields found', 'num'], ['fills', 'Blanks it can fill', 'num'],
      ['differs', 'Differs', 'num'], ['scrapedAt', 'Scraped'], ...(STATIC ? [] : [['exportedAt', 'In Google Sheet']]), [null, 'Website']];
    const headRow = h('tr');
    const draw = () => {
      headRow.replaceChildren(...cols.map(([k, label, cls]) => h('th', { class: cls || null, 'aria-sort': k && S.sort === k ? (S.dir > 0 ? 'ascending' : 'descending') : null },
        k ? h('button', { type: 'button', onclick: () => { if (S.sort === k) S.dir = -S.dir; else { S.sort = k; S.dir = k === 'name' || k === 'tier' || k === 'status' ? 1 : -1; } draw(); } }, label) : label)));
      const list = filtered();
      count.textContent = `${list.length} of ${ov.schools.length} schools`;
      scrapeBtn.textContent = `Scrape these ${list.length}`;
      scrapeBtn.disabled = !list.length || !!(S.job && S.job.running);
      if (!list.length) { tbody.replaceChildren(h('tr', null, h('td', { colspan: cols.length, class: 'empty' }, 'No schools match these filters.'))); return; }
      tbody.replaceChildren(...list.map((s) => {
        const href = '#/school/' + encodeURIComponent(s.id);
        const total = ov.fieldCount - 2;
        return h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('a')) location.hash = href; } },
          h('td', { class: 'name' }, h('a', { href }, s.name), h('span', { class: 'sub' }, s.region || '')),
          h('td', null, s.tier == null ? '' : s.tier),
          h('td', null, chip(STATUS[s.status] || [s.status, ''], s.detail)),
          h('td', { class: 'num' }, s.status === 'ok' ? [h('span', { class: 'meter' }, (() => { const i = h('i'); i.style.width = Math.round((s.found / total) * 100) + '%'; return i; })()), `${s.found} / ${total}`] : ''),
          h('td', { class: 'num' }, s.status === 'ok' ? s.fills : ''),
          h('td', { class: 'num' }, s.status === 'ok' ? s.differs : ''),
          h('td', { class: 'small muted' }, ago(s.scrapedAt)),
          STATIC ? null : h('td', { class: 'small muted' }, s.exportedAt ? ago(s.exportedAt) : ''),
          h('td', { class: 'small' }, s.website ? ext(s.website, shortUrl(s.website).split('/')[0]) : h('span', { class: 'muted' }, 'none'),
            s.wrongSite ? h('span', { class: 'chip warn', title: 'The school’s name never appears on this website. The link in the list may belong to another school.' }, 'wrong site?') : null));
      }));
    };
    const search = h('input', { type: 'search', placeholder: 'Search school or region', 'aria-label': 'Search school or region', value: S.q, oninput: (e) => { S.q = e.target.value; draw(); } });
    const sel = (key, label, opts) => {
      const el = h('select', { 'aria-label': label, onchange: (e) => { S[key] = e.target.value; draw(); } }, opts.map(([v, t]) => h('option', { value: v }, t)));
      el.value = S[key];
      return el;
    };
    app.replaceChildren(
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Schools'),
        h('p', null, `The PSTP Schools list, checked against each school’s own website using the ${ov.fieldCount} rows of the Master Template.`),
        STATIC && ov.generatedAt ? h('p', { class: 'snapshot' }, `Read-only copy of the results as of ${new Date(ov.generatedAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. It does not update by itself.`) : null)),
      h('div', { class: 'stats' },
        stat(ov.schools.length, 'schools in the list'), stat(scraped.length, 'scraped'), stat(problems.length, 'could not be read'),
        stat(sum('found'), 'fields found on websites'), stat(sum('fills'), 'blanks the scrape can fill'), stat(sum('differs'), 'values that differ from the sheet')),
      h('div', { class: 'bar' }, search,
        sel('tier', 'Tier', [['', 'All tiers'], ['1', 'Tier 1'], ['2', 'Tier 2'], ['3', 'Tier 3']]),
        sel('status', 'Status', [['', 'All statuses'], ['ok', 'Scraped'], ['not-scraped', 'Not scraped yet'], ['problem', 'Could not be read'], ['fills', 'Has blanks it can fill'], ['differs', 'Differs from the sheet']]),
        count, h('span', { class: 'spacer' }), STATIC ? null : scrapeBtn),
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

    const sheetCell = (row) => {
      if (!row.sheet.length) return h('span', { class: 'nothing' }, tab ? 'Blank in the sheet' : 'No tab for this school yet');
      const guide = tab && tab.guideCols && row.section === 'Guide to Applying';
      return row.sheet.map((c) => h('div', { class: 'part' },
        row.sheet.length > 1 || guide ? h('span', { class: 'tag' }, guide && tab.guideCols[c.col] ? tab.guideCols[c.col] : 'Column ' + c.col) : null,
        c.text ? clamped(c.text) : null,
        c.link ? h('div', { class: 'src' }, ext(c.link)) : null));
    };
    const scrapedCell = (row) => {
      const f = row.scraped;
      if (!r) return h('span', { class: 'nothing' }, 'Not scraped yet');
      if (r.status !== 'ok') return h('span', { class: 'nothing' }, 'The website could not be read');
      if (!f || f.status === 'none') return [h('span', { class: 'nothing' }, 'Not found on the website'), f && f.note ? h('div', { class: 'note' }, f.note) : null];
      if (f.status === 'manual') return h('span', { class: 'nothing' }, f.note);
      if (f.status !== 'found') return h('span', { class: 'nothing' }, f.note || 'No result');
      const srcs = (f.sources || []).filter((x) => safeUrl(x.url));
      return [
        clamped(f.value),
        h('div', { class: 'src' }, 'Source: ', srcs.map((x, i) => [i ? ', ' : '', ext(x.url, null, x.title)]),
          h('span', { class: 'conf ' + f.confidence, title: 'How direct the match is. High: a labelled figure or exact pattern. Medium: a matching sentence or section. Low: keyword match only, check it.' }, f.confidence + ' confidence')),
        f.note ? h('div', { class: 'note' }, f.note) : null,
        h('details', null, h('summary', null, 'Evidence' + (f.alts ? ` and ${f.alts.length} other match${f.alts.length === 1 ? '' : 'es'}` : '')),
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
        if (S.verdict !== 'all' && row.verdict !== S.verdict) continue;
        any = true;
        if (row.section !== lastSection) {
          lastSection = row.section;
          kids.push(h('h2', { class: 'section' }, row.section),
            h('div', { class: 'colhead' }, h('span', null, 'Template row'), h('span', null, 'In the sheet now'), h('span', null, 'Found on the website')));
        }
        kids.push(h('div', { class: 'frow' },
          h('div', { class: 'label' }, h('b', null, row.label), h('span', { class: 'rownum' }, 'Template row ' + row.row), chip(VERDICT[row.verdict])),
          h('div', { class: 'cell', 'data-title': 'In the sheet now' }, sheetCell(row)),
          h('div', { class: 'cell', 'data-title': 'Found on the website' }, scrapedCell(row))));
      }
      if (!any) kids.push(h('p', { class: 'empty' }, 'No fields in this group.'));
      rowsBox.replaceChildren(...kids);
      settleClamps();
    };
    const drawFilters = () => {
      const opts = [['all', 'All fields', d.rows.filter((x) => x.kind === 'field').length], ['fills', 'Can fill a blank', d.counts.fills], ['differs', 'Differs', d.counts.differs],
        ['match', 'Matches', d.counts.match], ['both', 'Both filled', d.counts.both], ['sheet-only', 'Only in the sheet', d.counts['sheet-only']], ['none', 'Not found', d.counts.none]];
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
    const exportBtn = STATIC ? null : h('button', { class: 'btn', type: 'button', disabled: !r || r.status !== 'ok', title: !r || r.status !== 'ok' ? 'Scrape this school first' : null, onclick: async () => {
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

    // the file the Google Sheet's own menu loads (works under any company Google policy)
    const canExport = r && r.status === 'ok';
    const fileBtn = STATIC ? null : h('button', { class: 'btn' + (d.exportConfigured ? '' : ' primary'), type: 'button', disabled: !canExport, title: canExport ? 'Makes a small file. In your Google Sheet: School Info menu, Load export file.' : 'Scrape this school first', onclick: async () => {
      fileBtn.disabled = true;
      try {
        const f = await downloadExportFile(`id=${encodeURIComponent(s.id)}&tab=${d.tabIndex}`);
        exportBox.replaceChildren(h('div', { class: 'notice ok' }, h('b', null, 'File saved. '),
          `“${f.name}” is in your Downloads folder. In your Google Sheet open the School Info menu, choose “Load export file...”, and pick it. Blank cells are filled in yellow; cells that already have text get a note and turn orange.`));
      } catch (e) { exportBox.replaceChildren(h('div', { class: 'notice' }, h('b', null, 'The file could not be made. '), e.message)); }
      fileBtn.disabled = false;
    } }, 'Download file for Google Sheet');

    const notice = !r ? h('div', { class: 'notice info' }, STATIC ? 'This school had not been scraped when this copy was made, so the fields below show only what the sheet has.' : 'This school has not been scraped yet. Use “Scrape this school” to read its website.')
      : r.status !== 'ok' ? h('div', { class: 'notice' }, h('b', null, (STATUS[r.status] || [r.status])[0] + '. '), r.detail || '', ' Nothing was read from this website, so the fields below show only what the sheet has.')
      : null;

    // the website in the list may belong to another school: everything below would then be about someone else
    const wrongSite = r && r.identity && r.identity.ok === false
      ? h('div', { class: 'notice' }, h('b', null, 'This website may not be this school. '),
        `None of the words ${r.identity.checked.map((w) => `“${w}”`).join(', ')} appear in the titles, descriptions or opening text of ${r.identity.host || 'the website'}. Everything below was read from that website, so check the Website column for this school in the PSTP Schools list before trusting it.${STATIC ? '' : ' This school is left out of the “all schools” file for the Google Sheet.'}`)
      : null;

    app.replaceChildren(...[
      h('a', { class: 'crumb', href: '#/' }, '← All schools'),
      h('div', { class: 'pagehead' },
        h('div', { class: 'grow' }, h('h1', null, s.name),
          h('div', { class: 'meta' },
            s.tier != null ? h('span', null, 'Tier ' + s.tier) : null,
            s.region ? h('span', null, s.region) : null,
            s.website ? h('span', null, 'Website: ', ext(s.website)) : h('span', null, 'No website link in the list'),
            s.portal ? h('span', null, 'Portal in the list: ', ext(s.portal, s.portalLabel && !/^https?:/i.test(s.portalLabel) ? s.portalLabel : null)) : null,
            r ? h('span', null, `Scraped ${ago(r.scrapedAt)}, ${r.pages.length} pages read`) : null),
          h('div', { class: 'meta' },
            tab ? h('span', null, `Workbook tab: “${tab.tab.trim()}”` + (tab.matchedBy !== 'exact' ? ` (matched by ${tab.matchedBy}; please check it is the right tab)` : '')) : h('span', null, 'No tab in the workbook for this school yet'),
            d.tabs.length > 1 ? (() => {
              const el = h('select', { 'aria-label': 'Workbook tab to compare', onchange: (e) => viewSchool(id, Number(e.target.value)) }, d.tabs.map((t, i) => h('option', { value: i }, t.tab.trim())));
              el.value = String(d.tabIndex);
              return h('label', null, 'Compare with: ', el);
            })() : null)),
        STATIC ? null : h('div', { class: 'actions' }, fileBtn, d.exportConfigured ? exportBtn : null,
          h('button', { class: 'btn primary', type: 'button', disabled: running || !s.website, title: running ? 'A scrape is already running' : null,
            onclick: () => startRun({ scope: 'schools', ids: [s.id] }) }, r ? 'Scrape this school again' : 'Scrape this school'))),
      wrongSite, notice, exportBox, filterBox, rowsBox,
      r && r.pages.length ? h('details', { class: 'panel' }, h('summary', null, `Pages read on this website (${r.pages.length})`),
        h('div', { class: 'tablewrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Page'), h('th', null, 'Read as'), h('th', { class: 'num' }, 'Text'))),
          h('tbody', null, r.pages.map((p) => h('tr', null,
            h('td', null, p.title || '(untitled)', h('span', { class: 'sub' }, ext(p.url))),
            h('td', { class: 'small' }, (p.topics || []).join(', ') + (p.kind === 'pdf' ? ' (PDF)' : '')),
            h('td', { class: 'num small' }, (p.chars || 0).toLocaleString() + ' chars'))))))) : null,
      r && r.skipped && r.skipped.length ? h('details', { class: 'panel' }, h('summary', null, `Pages it tried but could not read (${r.skipped.length})`),
        h('ul', null, r.skipped.map((x) => h('li', { class: 'small' }, ext(x.url), ' — ', x.reason)))) : null,
    ].filter(Boolean));
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
    const show = (c) => {
      status.textContent = c.configured ? 'Saved on this computer. The secret is never shown again.' : 'Not set up yet. Follow the steps in docs/GOOGLE-SHEET-EXPORT.md, then fill in the two boxes below.';
      if (c.url) url.value = c.url;
    };
    api('/api/export-config').then(show).catch((e) => { status.textContent = e.message; });
    const guard = (btn, label, fn) => async () => {
      btn.disabled = true;
      try { await fn(); } catch (e) { say(e.message, true); }
      btn.disabled = false; btn.textContent = label;
    };
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
      const r = await api('/api/export-test', {});
      say(`Connected to “${r.sheet}” (${r.tabs} tabs). ${r.hasTemplate ? '' : 'There is no Master Template tab, so a school without a tab cannot get one. '}${r.emailConfigured ? 'Daily email recipients are set.' : 'No email recipients are set yet, so the daily email will not be sent.'}`);
    });
    return h('details', { class: 'direct' }, h('summary', null, 'Advanced: send straight to the sheet with one click'),
      h('p', { class: 'muted small' }, 'Only works if your company lets an Apps Script web app be open to “Anyone”. If the deploy screen only offers your organization, use the file above instead.'),
      status,
      h('label', { class: 'field' }, h('span', null, 'Web app address'), url),
      h('label', { class: 'field' }, h('span', null, 'Secret'), token),
      h('div', { class: 'runbtns' }, make, save, test), out);
  }

  /** Downloads the file the Google Sheet's School Info menu loads. Resolves to { name, count, skipped }. */
  async function downloadExportFile(query) {
    const r = await fetch('/api/export-file?' + query);
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'The file could not be made.'); }
    const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'school-info-export.json';
    const url = URL.createObjectURL(await r.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { name, count: Number(r.headers.get('X-Export-Count')) || 0, skipped: Number(r.headers.get('X-Export-Skipped')) || 0, wrongSite: Number(r.headers.get('X-Export-Wrong-Site')) || 0 };
  }

  /** Start here: send findings to the Google Sheet copy through the sheet's own menu (needs nothing from Google admins). */
  function sheetFilePanel() {
    const scraped = S.ov && S.ov.ready ? S.ov.schools.filter((s) => s.status === 'ok').length : 0;
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: !scraped, title: scraped ? null : 'Scrape some schools first' },
      scraped ? `Download file for all ${scraped} scraped schools` : 'Scrape some schools first');
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const f = await downloadExportFile('all=1');
        say(`Saved “${f.name}” with ${f.count} school${f.count === 1 ? '' : 's'}${f.skipped ? ` (${f.skipped} left out: not scraped yet, nothing found${f.wrongSite ? `, or ${f.wrongSite} whose website looks like a different school` : ''})` : ''}. Now open your Google Sheet, School Info menu, Load export file...`);
      } catch (e) { say(e.message, true); }
      btn.disabled = false;
    };
    return h('div', { class: 'panel' }, h('h2', null, 'Send to your Google Sheet'),
      h('p', null, 'A person fact checks what the websites said inside a copy of your sheet. The dashboard makes a small file; a menu inside the Google Sheet loads it. Blank cells are filled in yellow. A cell that already has text is never changed: it gets a note with what the website says, and turns orange. Every load is listed in an Export Log tab, and a daily email names the schools that were updated.'),
      h('p', null, h('b', null, 'Set up once, in your Google Sheet copy: '), 'Extensions, Apps Script, click + next to Files, choose Script, paste the whole of ',
        h('a', { href: '#/script' }, 'google-sheet/Code.gs'), ' (the Script page has a Copy button), Save, then reload the sheet. A “School Info” menu appears. The full steps are in docs/GOOGLE-SHEET-EXPORT.md.'),
      h('p', null, h('b', null, 'Each time: '), 'download the file here (or “Download file for Google Sheet” on one school’s page), then in the sheet choose School Info, Load export file..., and pick it. Expect a few seconds per school.'),
      h('div', { class: 'runbtns' }, btn), out,
      exportPanel());
  }

  // ------------------------------------------------------------- start view ---
  /** Choose or drop the .xlsx: it is sent to the program, saved, and imported. */
  function workbookPanel(onDone, canReread) {
    const out = h('p', { class: 'small' });
    const detail = h('pre', { class: 'cmd', hidden: true });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const input = h('input', { type: 'file', accept: '.xlsx', 'aria-label': 'Choose your School Information Sheet (.xlsx)', hidden: true });
    const zone = h('div', { class: 'drop', tabindex: '0', role: 'button' }, h('b', null, 'Choose your sheet'), h('span', null, ' or drop the .xlsx file here'));
    async function send(file) {
      if (!file) return;
      if (!/\.xlsx$/i.test(file.name)) { say('Please choose an Excel file ending in .xlsx.', true); return; }
      zone.classList.add('busy'); detail.hidden = true;
      say(`Reading “${file.name}”. This takes about 30 seconds.`);
      try {
        const r = await fetch('/api/workbook', { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'The upload did not work (' + r.status + ').');
        await loadOverview();
        say('Loaded. Your school list is ready.');
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
    return h('div', { class: 'panel' }, h('h2', null, 'Your School Information Sheet'),
      h('p', null, 'In Google Sheets choose File, Download, Microsoft Excel (.xlsx), then choose that file here. Do the same whenever the sheet changes. The program only reads it and never changes it.'),
      zone, input, out, detail, canReread ? h('p', { class: 'muted small' }, reread) : null);
  }

  /** Share results with teammates: save everything found so far to one file, or add a teammate's file. */
  function sharePanel() {
    const out = h('p', { class: 'small' });
    const say = (msg, bad) => { out.textContent = msg; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    const save = h('button', { class: 'btn', type: 'button' }, 'Save my results to a file');
    save.onclick = async () => {
      save.disabled = true;
      try {
        const r = await fetch('/api/results-package');
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'The file could not be made.'); }
        const name = (/filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '') || [])[1] || 'school-results.zip';
        const url = URL.createObjectURL(await r.blob());
        const a = h('a', { href: url, download: name });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        say(`Saved as “${name}”, usually in your Downloads folder. Send that file to a teammate.`);
      } catch (e) { say(e.message, true); }
      save.disabled = false;
    };
    const input = h('input', { type: 'file', accept: '.zip', hidden: true, 'aria-label': 'Choose a teammate’s results file' });
    const zone = h('div', { class: 'drop compact', tabindex: '0', role: 'button' }, h('b', null, 'Add a teammate’s results file'), h('span', null, ' or drop it here'));
    async function add(file) {
      if (!file) return;
      if (!/\.zip$/i.test(file.name)) { say('Please choose a results file (its name ends in .zip).', true); return; }
      zone.classList.add('busy');
      say(`Adding the results in “${file.name}”…`);
      try {
        const r = await fetch('/api/results-package', { method: 'POST', headers: { 'X-Dashboard': '1', 'Content-Type': 'application/octet-stream' }, body: file });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'That did not work (' + r.status + ').');
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
    return h('div', { class: 'panel' }, h('h2', null, 'Share results with teammates'),
      h('p', null, 'Results are what was found on the school websites. They hold nothing from your sheet, so the file is safe to send. One person can scrape and the others add that file instead of repeating the work. Each person still compares the results with their own copy of the sheet.'),
      h('div', { class: 'runbtns' }, save), zone, input, out);
  }

  async function viewStart() {
    app.replaceChildren(h('p', { class: 'loading' }, 'Checking…'));
    const { items } = await api('/api/setup');
    const LABEL = { ok: ['Ready', 'ok'], todo: ['To do', 'warn'], optional: ['Optional', ''], info: ['Note', 'info'] };
    const todo = items.filter((i) => i.status === 'todo');
    const row = (i) => h('li', { class: 'check-item' },
      h('span', { class: 'chip ' + LABEL[i.status][1] }, LABEL[i.status][0]),
      h('div', null, h('b', null, i.title), h('span', { class: 'sub' }, i.detail), i.action && i.status !== 'ok' ? h('span', { class: 'next' }, '→ ' + i.action) : null));
    const go = (href, title, text) => h('a', { class: 'tile', href }, h('b', null, title), h('span', null, text));
    app.replaceChildren(
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Start here'),
        h('p', null, todo.length ? `${todo.length} thing${todo.length === 1 ? '' : 's'} to do before the dashboard is useful.` : 'Everything needed is ready. Pick what you want to do below.'))),
      h('ul', { class: 'checklist' }, items.map(row)),
      workbookPanel(() => viewStart(), !!(S.ov && S.ov.ready)),
      sharePanel(),
      h('div', { class: 'tiles' },
        go('#/', 'Review the schools', 'Every school, with what your sheet says next to what the website says.'),
        go('#/run', 'Read school websites', 'Start with Tier 1. Progress shows live.'),
        go('#/script', 'See how it works', 'The code and the rules, in plain view.')),
      sheetFilePanel());
  }

  // --------------------------------------------------------------- run view ---
  let runUi = null;
  function viewRun() {
    const ov = S.ov;
    const n = (f) => (ov.ready ? ov.schools.filter(f).length : 0);
    const refresh = h('input', { type: 'checkbox', id: 'refresh' });
    const go = (body) => () => startRun({ ...body, refresh: refresh.checked });
    const btn = (label, body, primary) => h('button', { class: 'btn' + (primary ? ' primary' : ''), type: 'button', 'data-run': '1', onclick: go(body) }, label);
    const status = h('p', null);
    const bar = h('i');
    const active = h('ul', { class: 'active' });
    const logBox = h('div', { class: 'log', role: 'log', 'aria-live': 'off' });
    const stop = h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Stop the running scrape? Schools already finished stay saved.')) { await api('/api/stop', {}); poll(true); } } }, 'Stop');
    runUi = { status, bar, active, logBox, stop, shown: 0 };

    app.replaceChildren(
      h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Run scraper'),
        h('p', null, 'Starts the script on this computer. It reads each school’s public website, slowly and politely, and saves what it finds for the dashboard.'))),
      h('div', { class: 'panel' }, h('h2', null, 'Start a scrape'),
        ov.ready ? [
          h('div', { class: 'runbtns' },
            btn(`Tier 1 (${n((s) => s.tier === 1)})`, { scope: 'tier', tier: 1 }, true),
            btn(`Tier 2 (${n((s) => s.tier === 2)})`, { scope: 'tier', tier: 2 }),
            btn(`Tier 3 (${n((s) => s.tier === 3)})`, { scope: 'tier', tier: 3 }),
            btn(`Not scraped yet (${n((s) => s.status === 'not-scraped')})`, { scope: 'pending' }),
            btn(`All schools (${ov.schools.length})`, { scope: 'all' })),
          h('label', { class: 'check', for: 'refresh' }, refresh, 'Download every page again instead of using pages saved in the last 7 days'),
          h('p', { class: 'muted small' }, 'Expect 2 to 7 minutes per website, because many school sites ask automated visitors to wait 5 to 10 seconds between pages. Several websites are read at the same time, so a tier takes roughly an hour and the whole list a few hours. Schools that share a website (lower, middle and upper divisions) are read once. To scrape one school, open it from the Schools list.'),
        ] : h('p', null, 'Load your sheet first on the ', h('a', { href: '#/start' }, 'Start here'), ' page.')),
      h('div', { class: 'panel' }, h('h2', null, 'Progress'), status, h('div', { class: 'progress' }, bar), stop, active, logBox),
      h('div', { class: 'panel' }, h('h2', null, 'Your sheet and the Google Sheet export'),
        h('p', null, 'Loading a new copy of your School Information Sheet, and sending findings to your Google Sheet copy, are on the ', h('a', { href: '#/start' }, 'Start here'), ' page. The workbook is only read, never changed.')),
      h('div', { class: 'panel' }, h('h2', null, 'What the script does and does not do'),
        h('ul', null,
          h('li', null, 'Reads only the school’s own website and the PDFs it links to (fact sheets, school profiles). No third-party sites such as Niche.'),
          h('li', null, 'Uses fixed rules, no AI. Every answer shows the page it came from and the exact words it matched, so it can be checked.'),
          h('li', null, 'Obeys each site’s robots.txt, identifies itself honestly, and pauses between pages. A site that refuses automated visits is marked “Blocked by site” and left alone.'),
          h('li', null, 'Cannot log in. Anything that only exists inside an admissions portal (Ravenna, Gateway and so on), such as the exact essay prompts, will not be found.'),
          h('li', null, 'Never changes the workbook. The dashboard shows what could fill a blank or differs; you decide what goes into the sheet.'))));
    drawJob();
  }

  function drawJob() {
    if (!runUi || S.view !== 'run') return;
    const j = S.job || { running: false };
    document.querySelectorAll('[data-run]').forEach((b) => { b.disabled = !!j.running; });
    runUi.stop.hidden = !j.running;
    if (j.running) runUi.status.textContent = `Running: ${j.label}. ${j.done} of ${j.schools || '?'} schools done, ${j.sitesDone} of ${j.sites || '?'} websites.`;
    else if (j.label) runUi.status.textContent = `${j.stopped ? 'Stopped' : j.exitCode ? 'Ended with an error' : 'Finished'}: ${j.label}. ${j.done} of ${j.schools} schools done.`;
    else runUi.status.textContent = 'Nothing is running.';
    runUi.bar.style.width = j.schools ? Math.round((j.done / j.schools) * 100) + '%' : '0%';
    runUi.active.replaceChildren(...(j.active || []).map((a) => h('li', null, 'Reading ', h('b', null, shortUrl(a.start)), ` — ${a.pages} page${a.pages === 1 ? '' : 's'} so far (${a.schools.join(', ')})`)));
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
          : 'The exact code that runs when you press a button on the Run scraper page. It is plain JavaScript (Node.js) and lives in the school-info-scraper folder.'))),
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
  const ASK = { id: null, items: [], busy: false, status: null, ctrl: null, draft: '' };
  let askUi = null;
  const SUGGESTIONS = [
    'Which schools differ most from my sheet?',
    'What can the websites fill into blank sheet cells?',
    'How many Tier 1 schools have not been scraped yet?',
    'Which fields does the scraper find least often?',
    'Which school websites in the list look wrong?',
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
    const parts = [lookups > 0 ? `${lookups} lookup${lookups === 1 ? '' : 's'}` : (u.searches ? '' : 'no lookups needed')];
    if (u.searches) parts.push(`${u.searches} web search${u.searches === 1 ? '' : 'es'}`);
    parts.push(u.tracked ? `about ${money(u.cost)}` : `${(u.inputTokens + u.outputTokens).toLocaleString()} tokens (spend is not tracked for the test model)`);
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
          p.state = 'done'; p.message = 'Started. Watch it on the Run scraper page.';
          S.log = []; location.hash = '#/run'; poll(true);
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

  function turnView(t) {
    return h('div', { class: 'msg bot' },
      t.steps.length ? h('ul', { class: 'steps' }, t.steps.map((s) => h('li', { class: s.done ? (s.ok ? 'done' : 'failed') : 'running' }, s.label))) : null,
      t.note ? h('p', { class: 'small muted' }, t.note) : null,
      t.text ? h('div', { class: 'answer' }, renderMd(t.text)) : (t.pending && !t.error ? h('p', { class: 'muted small' }, t.steps.length ? 'Working it out…' : 'Thinking…') : null),
      t.sources && t.sources.length ? h('div', { class: 'sources' }, h('p', { class: 'small muted' }, 'Web sources. These are not the school’s own website and the scraper has not checked them:'),
        h('ul', null, t.sources.map((s) => h('li', null, ext(s.url, s.title || null))))) : null,
      t.proposals.map(proposalCard),
      t.error ? h('div', { class: 'notice' }, t.error) : null,
      t.usage ? h('p', { class: 'usage small muted' }, usageLine(t.usage)) : null);
  }

  function drawChat() {
    if (!askUi || S.view !== 'ask') return;
    const st = ASK.status;
    const items = ASK.items.map((it) => (it.role === 'user' ? h('div', { class: 'msg user' }, it.text) : turnView(it)));
    if (!items.length) {
      items.push(h('div', { class: 'panel intro' },
        h('p', null, st && st.ready ? 'Ask a question about the schools in plain English. I answer from what the scraper read on each school’s own website and from your sheet, and I show where each fact came from.'
          : 'Connect the AI above, then ask a question about the schools.'),
        h('div', { class: 'filters' }, SUGGESTIONS.map((q) => h('button', { type: 'button', onclick: () => { askUi.input.value = q; submit(); } }, q)))));
    }
    askUi.chat.replaceChildren(...items);
    askUi.send.hidden = ASK.busy; askUi.stop.hidden = !ASK.busy;
    askUi.input.disabled = ASK.busy;
    if (ASK.busy) requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
  }

  function drawBar() {
    if (!askUi || S.view !== 'ask') return;
    const st = ASK.status;
    const groq = st.provider === 'groq';
    const cfg = groq ? st.groq : st.anthropic;
    const model = groq ? cfg.model : ((st.anthropic.models.find((m) => m.id === cfg.model) || {}).label || cfg.model);
    const used = st.spentThisMonth || 0, pct = Math.min(100, Math.round(used / st.monthlyCapUsd * 100));
    askUi.bar.replaceChildren(
      st.ready ? chip([groq ? 'Test model (Groq)' : 'Claude', groq ? 'warn' : 'ok'], groq ? 'Only for trying the page out. Claude is the one meant for real use.' : null) : chip(['Not connected', 'warn']),
      st.webSearchOn ? chip(['Web search on', 'info'], 'The assistant may search the web when the saved data cannot answer. Web results are labelled and never go into the Sheet file.') : null,
      h('span', { class: 'small muted' }, model),
      groq ? h('span', { class: 'small muted' }, 'spend not tracked') : h('span', { class: 'small', title: 'An estimate from list prices. The cap stops new questions once it is reached.' },
        h('span', { class: 'meter' }, h('i', { style: null })), `${money(used)} of $${st.monthlyCapUsd} this month`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: newChat }, 'New chat'));
    const bar = askUi.bar.querySelector('.meter i');
    if (bar) bar.style.width = pct + '%';   // a style property set from script is allowed; an inline style attribute is not
  }

  function askSettings(message) {
    const st = ASK.status;
    const box = h('details', { class: 'panel asksettings', open: !st.ready || !!message });
    box.append(h('summary', null, st.ready ? 'AI settings' : 'Connect the AI (needed once)'));
    if (!st.canEditSettings) {
      box.append(h('p', { class: 'muted small' }, 'On a shared server these are set by whoever runs it, with environment variables (ANTHROPIC_API_KEY, GROQ_API_KEY, ASK_PROVIDER, ASK_MODEL, ASK_MONTHLY_CAP_USD). ' + (st.ready ? 'The AI is connected.' : 'The AI is not connected yet.')));
      return box;
    }
    const out = h('p', { class: 'small' });
    const say = (m, bad) => { out.textContent = m; out.className = 'small ' + (bad ? 'bad' : 'good'); };
    if (message) say(message);
    const form = { provider: st.provider };
    const fields = h('div');
    const radio = (value, label, hint) => {
      const input = h('input', { type: 'radio', name: 'askprov', value, checked: st.provider === value, disabled: st.locked.provider });
      input.onchange = () => { form.provider = value; draw(); };
      return h('label', { class: 'radio' }, input, h('span', null, h('b', null, label), ' ', h('span', { class: 'muted small' }, hint)));
    };
    let key, model, cap, web;
    function draw() {
      const g = form.provider === 'groq';
      const k = g ? st.groq : st.anthropic;
      const lockedKey = g ? st.locked.groqKey : st.locked.anthropicKey;
      key = h('input', { type: 'password', class: 'wide', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'API key', disabled: lockedKey,
        placeholder: lockedKey ? 'Set by the server' : k.configured ? `Saved (${k.keyHint}). Paste a new key to replace it.` : g ? 'Groq API key (starts with gsk_)' : 'Anthropic API key (starts with sk-ant-)' });
      const ids = g ? (k.models.includes(k.model) ? k.models : [k.model, ...k.models]) : k.models.map((m) => m.id);
      model = h('select', { 'aria-label': 'Model' }, ids.map((id) => h('option', { value: id, selected: id === k.model }, g ? id : k.models.find((m) => m.id === id).label)));
      cap = h('input', { type: 'number', min: '1', max: '10000', step: '1', value: String(st.monthlyCapUsd), class: 'cap', 'aria-label': 'Monthly cap in dollars', disabled: st.locked.cap });
      web = h('input', { type: 'checkbox', checked: !!st.webSearch, disabled: st.locked.webSearch, 'aria-label': 'Let the assistant search the web' });
      fields.replaceChildren(
        h('label', { class: 'field' }, h('span', null, g ? 'Groq API key' : 'Anthropic API key'), key),
        h('label', { class: 'field' }, h('span', null, 'Model'), model),
        ...(g ? [
          h('p', { class: 'muted small' }, 'Groq is a different company with open models, for trying this page out cheaply. Your questions and the school data the tools return are sent to Groq. Its free plan allows only a few thousand tokens a minute, so a long answer may pause and retry. Claude is the one meant for real use.'),
          h('p', { class: 'muted small' }, 'Web search is only available with Claude.'),
        ] : [
          h('label', { class: 'field' }, h('span', null, 'Monthly spending cap (US dollars)'), cap),
          h('label', { class: 'check field' }, web, h('span', null, 'Let the assistant search the web')),
          h('p', { class: 'muted small' }, 'Off unless you switch it on. About $0.01 a search on top of the usual cost. Web results are not the school’s own website: they are labelled, listed as sources, and never go into the Google Sheet file. Your organization may need to allow web search in the Anthropic console first.'),
        ]));
    }
    async function save() {
      const g = form.provider === 'groq';
      const body = { provider: form.provider };
      if (g) { if (key.value.trim()) body.groqKey = key.value; body.groqModel = model.value; } else { if (key.value.trim()) body.apiKey = key.value; body.model = model.value; body.monthlyCapUsd = cap.value; if (!st.locked.webSearch) body.webSearch = web.checked; }
      ASK.status = await api('/api/ask/settings', body);
    }
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save');
    const testBtn = h('button', { class: 'btn', type: 'button' }, 'Save and test the connection');
    const run = (btn, label, fn) => async () => {
      btn.disabled = true;
      try { await fn(); } catch (e) { say(e.message, true); }
      btn.disabled = false; btn.textContent = label;
    };
    saveBtn.onclick = run(saveBtn, 'Save', async () => { await save(); askUi.settings.replaceChildren(askSettings('Saved on this computer. The key is never shown again.')); drawBar(); drawChat(); });
    testBtn.onclick = run(testBtn, 'Save and test the connection', async () => {
      testBtn.textContent = 'Testing…';
      await save();
      const r = await api('/api/ask/test', {});
      if (r.models) ASK.status.groq.models = r.models;
      askUi.settings.replaceChildren(askSettings(r.message)); drawBar(); drawChat();
    });
    draw();
    box.append(
      h('p', { class: 'muted small' }, 'The key is saved only on this computer (in the data folder) and is never sent back to the page. Make one in the Anthropic console (Settings, API keys) or, for the test model, at console.groq.com.'),
      h('div', { class: 'radios' }, radio('anthropic', 'Claude', '(Anthropic): the real one'), radio('groq', 'Groq', '(test only): free to try')),
      fields, h('div', { class: 'runbtns' }, saveBtn, testBtn), out);
    return box;
  }

  function onAskEvent(turn, ev) {
    if (ev.type === 'conversation') { ASK.id = ev.id; if (ev.fresh) turn.note = 'The earlier conversation was no longer there (the dashboard was restarted), so this started a new one.'; }
    else if (ev.type === 'step') turn.steps.push({ id: ev.id, label: ev.label, done: false, ok: true });
    else if (ev.type === 'step-done') { const s = turn.steps.find((x) => x.id === ev.id); if (s) { s.label = ev.label; s.done = true; s.ok = ev.ok; } }
    else if (ev.type === 'proposal') turn.proposals.push({ ...ev.proposal, state: 'idle' });
    else if (ev.type === 'sources') turn.sources = ev.sources;
    else if (ev.type === 'answer') turn.text = ev.text;
    else if (ev.type === 'usage') { turn.usage = ev; if (ASK.status && ev.month) ASK.status.spentThisMonth = ev.month.spent; }
    else if (ev.type === 'error') turn.error = ev.message;
  }

  async function askStream(message) {
    const turn = { role: 'assistant', steps: [], proposals: [], sources: [], text: '', usage: null, error: null, note: null, pending: true };
    ASK.items.push({ role: 'user', text: message }, turn);
    ASK.busy = true; ASK.ctrl = new AbortController();
    drawChat();
    try {
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dashboard': '1' }, body: JSON.stringify({ conversationId: ASK.id, message }), signal: ASK.ctrl.signal });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        if (r.status === 401 && j.signIn) { location.href = j.signIn; return; }
        throw new Error(j.error || 'Request failed (' + r.status + ')');
      }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
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
    drawChat(); drawBar();
  }

  function submit() {
    if (!askUi || ASK.busy) return;
    const text = askUi.input.value.trim();
    if (!text) return;
    if (!ASK.status.ready) { askUi.settings.replaceChildren(askSettings('Connect the AI first, then ask again.')); return; }
    askUi.input.value = ''; ASK.draft = '';
    const panel = askUi.settings.querySelector('details');
    if (panel) panel.open = false;                 // the settings are out of the way once a question is on its way
    askStream(text);
  }

  function newChat() {
    if (ASK.ctrl) ASK.ctrl.abort();
    if (ASK.id) api('/api/ask/reset', { conversationId: ASK.id }).catch(() => {});
    ASK.id = null; ASK.items = []; ASK.busy = false;
    drawChat();
  }

  async function viewAsk() {
    ASK.status = await api('/api/ask/status');
    const input = h('textarea', { class: 'askinput', rows: '2', placeholder: 'Ask about the schools. Enter sends, Shift+Enter makes a new line.', 'aria-label': 'Your question', maxlength: '4000' });
    input.value = ASK.draft;
    input.oninput = () => { ASK.draft = input.value; };
    input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } };
    const send = h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'Ask');
    const stop = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => ASK.ctrl && ASK.ctrl.abort() }, 'Stop');
    askUi = { bar: h('div', { class: 'askbar' }), chat: h('div', { class: 'chat', 'aria-live': 'polite' }), settings: h('div'), input, send, stop };
    askUi.settings.append(askSettings());
    app.replaceChildren(
      h('div', { class: 'ask' },
        h('div', { class: 'pagehead' }, h('div', { class: 'grow' }, h('h1', null, 'Ask'),
          h('p', null, 'Ask questions about the school data in plain English. Answers come from the websites the scraper has read and from your sheet, with the source shown. Nothing is changed unless you press a button.'))),
        askUi.bar, askUi.settings, askUi.chat,
        h('div', { class: 'composer' }, input, h('div', { class: 'runbtns' }, send, stop))));
    drawBar(); drawChat();
    if (ASK.status.ready && !ASK.busy) input.focus();
  }

  // ----------------------------------------------------------------- router ---
  async function route() {
    const hash = location.hash.replace(/^#\/?/, '');
    let view = hash.split('/')[0];
    if (STATIC && (view === 'run' || view === 'start' || view === 'ask')) { view = 'schools'; history.replaceState(null, '', '#/'); }
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
      if (j.running) pill.textContent = `Scraping: ${j.done} of ${j.schools || '?'} schools`;
      drawJob();
      if (was && !j.running) {
        await loadOverview();
        if (S.view !== 'run') route();
      } else if (j.running && S.view === 'schools' && Date.now() - lastOverview > 30000 && !(document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName))) {
        // while a scrape runs, the list fills in as schools finish
        await loadOverview();
        if (S.view === 'schools') { const y = window.scrollY; viewSchools(); window.scrollTo(0, y); }
      }
    } catch { /* the server may be restarting; try again */ }
    timer = setTimeout(poll, S.job && S.job.running ? 1500 : 5000);
  }

  // who is signed in (only shown when the program runs online with team sign-in)
  async function showWho() {
    const el = document.getElementById('who');
    try {
      const me = await api('/api/me');
      if (me.email && el) { el.replaceChildren(`Signed in as ${me.email}`, h('a', { href: '/auth/logout' }, 'Sign out')); el.hidden = false; }
    } catch { /* not signed in: the page is about to move to the sign-in */ }
  }

  window.addEventListener('hashchange', route);
  route().then(() => { if (!STATIC) { poll(true); showWho(); } });
})();
