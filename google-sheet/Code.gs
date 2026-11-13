/**
 * School Info Sheet: takes a school's website findings from the dashboard and writes them into
 * that school's tab of THIS Google Sheet. Add the whole file to the sheet copy as a NEW script file:
 *   Extensions > Apps Script > + next to Files > Script > paste > Save. Then reload the sheet.
 * Setup steps are in docs/GOOGLE-SHEET-EXPORT.md.
 *
 * Two ways in (the writing is the same code either way):
 *   1. Menu "School Info > Load export file...": the dashboard makes a small file, a person picks it
 *      here. Needs no web app and no secret, so it works under any company Google Workspace policy.
 *   2. Web app (doPost): the dashboard sends the findings straight here. Needs "Who has access: Anyone",
 *      which some company accounts do not allow, and the EXPORT_TOKEN script property.
 *
 * What an export does to a school's tab (it never overwrites what a person typed):
 *   - Empty cell (or one that still holds the template's hint text): filled, highlighted yellow,
 *     with a note giving the source page and confidence.
 *   - Cell with a different value: left as it is. A note on the cell says "UPDATED INFO ON WEBSITE"
 *     and shows the website's value and source. The cell is highlighted orange (only if it has no
 *     colour of its own).
 *   - Cell that already says the same thing: left alone.
 * Every export adds a line to the "Export Log" tab. A daily email lists the schools exported since
 * the last email, so a person can fact check them.
 */

var VERSION = '1.1.0';

var CONFIG = {
  // Who gets the daily email. Comma separated, e.g. 'a@example.com, b@example.com'.
  // (A Script property named NOTIFY_EMAILS, if present, is used instead.)
  NOTIFY_EMAILS: '',
  DIGEST_HOUR: 17,                 // hour of day for the daily email, in this sheet's time zone
  TEMPLATE_TAB: 'Master Template', // copied when a school has no tab yet
  LOG_TAB: 'Export Log',
  FILLED_COLOR: '#fff2cc',         // yellow: filled from the website
  UPDATE_COLOR: '#fce5cd',         // orange: the website says something different
  MAX_NOTE_CHARS: 2000
};

var NOTE_MARK = '[School Info export]';

// Which column of a school tab each template row is written to: column B for the school facts and the
// Events rows, column C ("School Website") for the Guide to Applying rows and the Facts Sheet links.
var COLUMN_C_KEYS = {
  factsSheet: 1, mission: 1, portal: 1, timeline: 1, application: 1, recommendations: 1, transcripts: 1,
  testingPolicy: 1, interviews: 1, pws: 1, essays: 1, guideEvents: 1, decisionDate: 1
};
// These rows hold "Name - link" lines, written as clickable links.
var LINK_KEYS = { factsSheet: 1, portal: 1 };

// ------------------------------------------------------------------ web app ---

function doPost(e) {
  var lock = LockService.getScriptLock();
  var held = false;
  try {
    var body = JSON.parse(e.postData.contents);
    if (!tokenOk_(body.token)) {
      return json_({ ok: false, error: 'The secret did not match. Check the EXPORT_TOKEN script property against the secret saved in the dashboard.' });
    }
    if (body.action === 'ping') return json_(ping_());
    if (body.action === 'export') {
      lock.waitLock(30000);
      held = true;
      return json_(exportSchool_(body));
    }
    return json_({ ok: false, error: 'Unknown action.' });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (held) lock.releaseLock();
  }
}

function doGet() {
  return json_({ ok: true, message: 'School Info Sheet export receiver is running. It only accepts POST requests from the dashboard.', version: VERSION });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function tokenOk_(given) {
  var expected = PropertiesService.getScriptProperties().getProperty('EXPORT_TOKEN');
  given = String(given || '');
  if (!expected || expected.length !== given.length) return false;
  var diff = 0;
  for (var i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function ping_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    ok: true, version: VERSION, sheet: ss.getName(), tabs: ss.getSheets().length,
    hasTemplate: !!ss.getSheetByName(CONFIG.TEMPLATE_TAB), emailConfigured: !!notifyEmails_()
  };
}

// ------------------------------------------------- menu: load an export file ---

/** Runs by itself when the sheet is opened (reload the sheet after adding this script). */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('School Info')
    .addItem('Load export file...', 'showLoadDialog')
    .addSeparator()
    .addItem('Start the daily email', 'startDailyEmail')
    .addToUi();
}

function showLoadDialog() {
  var html = HtmlService.createHtmlOutput(loadDialogHtml_()).setWidth(640).setHeight(580);
  SpreadsheetApp.getUi().showModalDialog(html, 'Load school info into this sheet');
}

/** Menu item: the same as running setupDailyDigest from the editor, with a message saying what it did. */
function startDailyEmail() {
  var ui = SpreadsheetApp.getUi();
  setupDailyDigest();
  var to = notifyEmails_();
  ui.alert('Daily email', 'The daily email is set for about ' + CONFIG.DIGEST_HOUR + ':00 (this sheet\'s time zone). ' +
    (to ? 'It goes to: ' + to + '.' : 'No recipients are set yet: put the addresses in NOTIFY_EMAILS at the top of the script.'), ui.ButtonSet.OK);
}

/**
 * Called by the dialog, one school at a time (so a long file never runs into Google's time limit).
 * item: { school, fields, hints } as made by the dashboard. Public on purpose: google.script.run cannot call names ending in _.
 */
function loadSchoolFromFile(item) {
  var body = checkFileItem_(item);
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var res = exportSchool_(body);
    return { ok: true, name: body.school.name, tab: res.tab, created: res.created, summary: res.summary };
  } finally {
    lock.releaseLock();
  }
}

/** The file comes from a person's computer: accept only the expected shapes and sizes. Returns a clean copy. */
function checkFileItem_(item) {
  var str = function (v, max) { return v == null ? '' : String(v).slice(0, max); };
  if (!item || typeof item !== 'object' || !item.school || typeof item.school.name !== 'string' || !item.school.name.trim()) {
    throw new Error('An entry in the file has no school name, so it was skipped.');
  }
  if (!Array.isArray(item.fields) || item.fields.length > 80) throw new Error('The entry for ' + str(item.school.name, 80) + ' is not in the expected format.');
  var s = item.school;
  var school = { id: str(s.id, 80), name: str(s.name, 200).trim(), tab: s.tab ? str(s.tab, 120) : null, nameInTab: s.nameInTab ? str(s.nameInTab, 200) : null, website: s.website ? str(s.website, 500) : null };
  var fields = [];
  for (var i = 0; i < item.fields.length; i++) {
    var f = item.fields[i];
    if (!f || typeof f.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(f.key)) continue;
    var sources = [];
    var src = Array.isArray(f.sources) ? f.sources.slice(0, 10) : [];
    for (var j = 0; j < src.length; j++) if (src[j] && typeof src[j].url === 'string' && /^https?:\/\//i.test(src[j].url)) sources.push({ url: src[j].url.slice(0, 500) });
    fields.push({ key: f.key, label: str(f.label, 120), value: str(f.value, 20000), confidence: str(f.confidence, 20), sources: sources, note: f.note ? str(f.note, 500) : null });
  }
  var hints = {};
  var h = item.hints && typeof item.hints === 'object' ? item.hints : {};
  for (var k in h) {
    if (Object.prototype.hasOwnProperty.call(h, k) && h[k] && typeof h[k] === 'object') hints[k] = { B: str(h[k].B, 1000), C: str(h[k].C, 1000) };
  }
  return { school: school, fields: fields, hints: hints };
}

// >>> generated from google-sheet/load-dialog.html by tools/embed-dialog.js (edit that file, then run: npm run build-sheet-script)
function loadDialogHtml_() {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<base target="_blank">',
    '<meta charset="utf-8">',
    '<style>',
    '  body { font-family: Arial, sans-serif; font-size: 13px; color: #202124; margin: 0; padding: 16px; }',
    '  h1 { font-size: 16px; margin: 0 0 8px; }',
    '  p { margin: 6px 0; line-height: 1.4; }',
    '  .muted { color: #5f6368; }',
    '  .box { background: #f1f3f4; border-radius: 6px; padding: 8px 10px; margin: 10px 0; }',
    '  .bad { color: #b3261e; }',
    '  .good { color: #137333; }',
    '  button { font: inherit; padding: 6px 14px; border-radius: 4px; border: 1px solid #dadce0; background: #fff; cursor: pointer; }',
    '  button.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }',
    '  button:disabled { opacity: 0.5; cursor: default; }',
    '  .bar { height: 8px; background: #e8eaed; border-radius: 4px; overflow: hidden; margin: 8px 0; }',
    '  .bar i { display: block; height: 100%; width: 0; background: #1a73e8; }',
    '  #results { list-style: none; margin: 8px 0; padding: 0; max-height: 210px; overflow: auto; border: 1px solid #e8eaed; border-radius: 6px; }',
    '  #results li { padding: 4px 8px; border-bottom: 1px solid #f1f3f4; }',
    '  #results li:last-child { border-bottom: 0; }',
    '</style>',
    '</head>',
    '<body>',
    '<h1>Load school info into this sheet</h1>',
    '<p>Choose the file the dashboard made (its name starts with <b>school-info-export</b>). Blank cells are filled in yellow. A cell that already has text is never changed: it gets a note with what the website says, and turns orange.</p>',
    '<p><input type="file" id="file" accept=".json,application/json"></p>',
    '<div id="summary" class="box" hidden></div>',
    '<p>',
    '  <button id="go" class="primary" disabled>Load into this sheet</button>',
    '  <button id="stop" hidden>Stop after this school</button>',
    '  <button id="close" hidden>Close</button>',
    '</p>',
    '<div id="progress" hidden>',
    '  <div class="bar"><i id="bar"></i></div>',
    '  <p id="now"></p>',
    '</div>',
    '<ul id="results" hidden></ul>',
    '<p id="final" hidden></p>',
    '<p class="muted" id="hint">Each school takes a few seconds. Keep this window open until it says Done. Loading the same file again is safe: nothing already written is changed.</p>',
    '<script>',
    '(function () {',
    '  var $ = function (id) { return document.getElementById(id); };',
    '  var data = null, running = false, stopNow = false;',
    '  var tally = { done: 0, filled: 0, flagged: 0, created: 0, failed: 0, still: 0 };',
    '',
    '  function show(node, text, cls) { node.hidden = false; node.textContent = text; node.className = cls || \'\'; }',
    '',
    '  function reset() {',
    '    data = null;',
    '    $(\'go\').disabled = true; $(\'go\').textContent = \'Load into this sheet\';',
    '    $(\'summary\').hidden = true;',
    '    $(\'results\').hidden = true; $(\'results\').textContent = \'\';',
    '    $(\'progress\').hidden = true; $(\'final\').hidden = true; $(\'close\').hidden = true;',
    '  }',
    '',
    '  $(\'file\').onchange = function () {',
    '    reset();',
    '    var f = this.files && this.files[0];',
    '    if (!f) return;',
    '    var reader = new FileReader();',
    '    reader.onerror = function () { show($(\'summary\'), \'That file could not be read.\', \'box bad\'); };',
    '    reader.onload = function () {',
    '      var j;',
    '      try { j = JSON.parse(String(reader.result)); } catch (e) {',
    '        show($(\'summary\'), \'That is not a file made by the dashboard. Choose the .json file whose name starts with school-info-export.\', \'box bad\');',
    '        return;',
    '      }',
    '      if (!j || j.kind !== \'school-info-export\' || !Array.isArray(j.schools)) {',
    '        show($(\'summary\'), \'That is not a file made by the dashboard. Choose the .json file whose name starts with school-info-export.\', \'box bad\');',
    '        return;',
    '      }',
    '      if (j.format !== 1) { show($(\'summary\'), \'This file is from a newer version of the dashboard than this script. Add the latest Code.gs to the sheet first.\', \'box bad\'); return; }',
    '      if (!j.schools.length) { show($(\'summary\'), \'The file holds no schools.\', \'box bad\'); return; }',
    '      data = j;',
    '      var when = j.createdAt ? new Date(j.createdAt).toLocaleString() : \'an unknown time\';',
    '      show($(\'summary\'), j.schools.length + (j.schools.length === 1 ? \' school\' : \' schools\') + \' in this file, made \' + when + (j.createdBy ? \' by \' + j.createdBy : \'\') + \'.\', \'box\');',
    '      $(\'go\').disabled = false;',
    '    };',
    '    reader.readAsText(f);',
    '  };',
    '',
    '  function addLine(text, cls) {',
    '    var li = document.createElement(\'li\');',
    '    li.textContent = text;',
    '    if (cls) li.className = cls;',
    '    $(\'results\').hidden = false;',
    '    $(\'results\').appendChild(li);',
    '    $(\'results\').scrollTop = $(\'results\').scrollHeight;',
    '  }',
    '',
    '  function finish(at) {',
    '    running = false;',
    '    $(\'stop\').hidden = true; $(\'close\').hidden = false; $(\'file\').disabled = false;',
    '    var left = data.schools.length - at;',
    '    var parts = [tally.done + \' of \' + data.schools.length + \' schools loaded\'];',
    '    parts.push(tally.filled + \' blank cells filled (yellow)\');',
    '    parts.push(tally.flagged + \' cells with updated info to check (orange)\');',
    '    if (tally.created) parts.push(tally.created + \' new tab\' + (tally.created === 1 ? \'\' : \'s\') + \' made\');',
    '    if (tally.failed) parts.push(tally.failed + \' failed (marked in red above)\');',
    '    var head = left > 0 ? \'Stopped. \' : \'Done. \';',
    '    show($(\'final\'), head + parts.join(\', \') + \'. Each school is listed in the Export Log tab.\', tally.failed || left > 0 ? \'bad\' : \'good\');',
    '    $(\'bar\').style.width = Math.round(((data.schools.length - left) / data.schools.length) * 100) + \'%\';',
    '    $(\'now\').textContent = \'\';',
    '    if (tally.failed || left > 0) { $(\'go\').disabled = false; $(\'go\').textContent = \'Load the file again\'; }   // safe: nothing already written is changed',
    '  }',
    '',
    '  function next(i) {',
    '    if (stopNow || i >= data.schools.length) { finish(i); return; }',
    '    if (tally.still >= 3) {',
    '      addLine(\'Stopped: three schools in a row failed, so something is wrong (for example Google asking you to allow the script again). Close this window, fix it, then load the same file again.\', \'bad\');',
    '      finish(i); return;',
    '    }',
    '    var entry = data.schools[i];',
    '    var name = entry && entry.school && entry.school.name ? entry.school.name : \'(no name)\';',
    '    $(\'now\').textContent = \'Loading \' + (i + 1) + \' of \' + data.schools.length + \': \' + name;',
    '    $(\'bar\').style.width = Math.round((i / data.schools.length) * 100) + \'%\';',
    '    google.script.run',
    '      .withSuccessHandler(function (r) {',
    '        tally.done++; tally.still = 0;',
    '        var s = r.summary || {};',
    '        tally.filled += s.filled || 0; tally.flagged += s.flagged || 0;',
    '        if (r.created) tally.created++;',
    '        addLine(r.name + \': \' + (s.filled || 0) + \' filled, \' + (s.flagged || 0) + \' to check\' + (r.created ? \' (new tab made)\' : \'\') + \' in tab "\' + r.tab + \'"\');',
    '        next(i + 1);',
    '      })',
    '      .withFailureHandler(function (err) {',
    '        tally.failed++; tally.still++;',
    '        addLine(name + \': \' + ((err && err.message) || String(err)), \'bad\');',
    '        next(i + 1);',
    '      })',
    '      .loadSchoolFromFile({ school: entry.school, fields: entry.fields, hints: data.hints || {} });',
    '  }',
    '',
    '  $(\'go\').onclick = function () {',
    '    if (!data || running) return;',
    '    running = true; stopNow = false;',
    '    tally = { done: 0, filled: 0, flagged: 0, created: 0, failed: 0, still: 0 };',
    '    $(\'results\').textContent = \'\'; $(\'final\').hidden = true;',
    '    $(\'go\').disabled = true; $(\'file\').disabled = true;',
    '    $(\'stop\').hidden = false; $(\'stop\').disabled = false; $(\'close\').hidden = true;',
    '    $(\'progress\').hidden = false;',
    '    next(0);',
    '  };',
    '',
    '  $(\'stop\').onclick = function () { stopNow = true; $(\'stop\').disabled = true; };',
    '  $(\'close\').onclick = function () { google.script.host.close(); };',
    '})();',
    '</script>',
    '</body>',
    '</html>'
  ].join('\n');
}
// <<< end of generated dialog

// ----------------------------------------------------- template row labels ---
// Kept in step with lib/template.js in the dashboard project. A test there compares both on every tab.

var LABEL_KEYS = [
  ['applicationOpenDate', /^application open date/],
  ['factsSheet', /^facts? sheet/],
  ['schoolType', /^school type/],
  ['location', /^location/],
  ['grades', /^grades/],
  ['enrollment', /^total student enrollment/],
  ['classesPerGrade', /^number of classes per grade/],
  ['studentsPerGrade', /^number of students per grade/],
  ['classSize', /^average class size/],
  ['ratio', /^student[- ]teacher ratio/],
  ['counselors', /^number of .*counselors/],
  ['advancedClasses', /^number of advanced classes/],
  ['testScores', /^average standardized test/],
  ['homework', /^average hours of homework/],
  ['facultyDegrees', /^percentage of faculty/],
  ['sports', /^sports offered/],
  ['collegeEnrollment', /^college enrollment/],
  ['tuition', /^tuition/],
  ['newSpots', /^new spots/],
  ['mission', /^about the school \(mission/],
  ['about', /^about the school/],
  ['demographics', /^student demographics/],
  ['academics', /^academics/],
  ['partners', /^partnering organi[sz]ations/],
  ['transit', /^transit options/],
  ['notes', /^further notes/],
  ['portal', /^portal information/],
  ['timeline', /^application timeline/],
  ['application', /^application$/],
  ['recommendations', /^recommendations?/],
  ['transcripts', /^transcripts?/],
  ['testingPolicy', /^testing policy/],
  ['interviews', /^interviews?/],
  ['pws', /^pws/],
  ['essays', /^essays/],
  ['decisionDate', /^decision release date/],
  ['infoSessions', /^information sessions?/],
  ['openHouse', /^open house/],
  ['tours', /^tours?$/],
  ['peerSchools', /^peer schools/]
];

function normLabel_(label) {
  return String(label == null ? '' : label).replace(/\s+/g, ' ').trim().replace(/:$/, '').trim().toLowerCase();
}

/** labels: [{row, label}] in sheet order. Returns [{row, key, kind}]; kind is 'field' or 'section'. */
function keyRows_(labels) {
  var out = [];
  var seenEvents = false;
  for (var i = 0; i < labels.length; i++) {
    var row = labels[i].row;
    var n = normLabel_(labels[i].label);
    if (!n) continue;
    if (n === 'school name') { out.push({ row: row, key: 'schoolName', kind: 'name' }); continue; }
    if (n === 'guide to applying') { out.push({ row: row, key: 'guideSection', kind: 'section' }); continue; }
    if (n === 'events') {
      if (!seenEvents) { seenEvents = true; out.push({ row: row, key: 'guideEvents', kind: 'field' }); }
      else out.push({ row: row, key: 'eventsSection', kind: 'section' });
      continue;
    }
    var key = null;
    for (var j = 0; j < LABEL_KEYS.length; j++) { if (LABEL_KEYS[j][1].test(n)) { key = LABEL_KEYS[j][0]; break; } }
    out.push({ row: row, key: key || ('x_' + n.replace(/[^a-z0-9]+/g, '_')), kind: 'field' });
  }
  return out;
}

/** Reads column A of a tab and returns {rows: {key: row}, guideRow: row or 0, last: lastRowRead}. */
function locateRows_(sheet) {
  var last = Math.min(Math.max(sheet.getLastRow(), 1), 120);
  var col = sheet.getRange(1, 1, last, 1).getValues();
  var labels = [];
  for (var i = 0; i < col.length; i++) if (String(col[i][0]).trim() !== '') labels.push({ row: i + 1, label: col[i][0] });
  var rows = {}, guideRow = 0, list = keyRows_(labels);
  for (var k = 0; k < list.length; k++) {
    var e = list[k];
    if (e.kind === 'section' && e.key === 'guideSection') guideRow = e.row;
    if (e.kind === 'field' && !rows[e.key]) rows[e.key] = e.row;
  }
  return { rows: rows, guideRow: guideRow, last: last };
}

// ---------------------------------------------------------------- the export ---

function exportSchool_(body) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var school = body.school || {};
  if (!school.name) throw new Error('The request has no school name.');
  var fields = body.fields || [];
  var hints = body.hints || {};

  var found = findTab_(ss, school);
  var sheet = found.sheet;
  var loc = locateRows_(sheet);
  var span = loc.last;
  var area = sheet.getRange(1, 1, span, 4);
  var shown = area.getDisplayValues();
  var notes = area.getNotes();
  var backs = area.getBackgrounds();
  var stamp = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM-dd');

  var counts = { filled: 0, flagged: 0, unchanged: 0, noRow: 0 };
  var rowsOut = [];
  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    var row = Object.prototype.hasOwnProperty.call(loc.rows, f.key) ? loc.rows[f.key] : 0;
    if (!row || row > span) { counts.noRow++; rowsOut.push({ key: f.key, label: f.label, result: 'no-row' }); continue; }
    var colNum = COLUMN_C_KEYS[f.key] ? 3 : 2;
    var letter = colNum === 3 ? 'C' : 'B';
    var cell = sheet.getRange(row, colNum);
    var existing = String(shown[row - 1][colNum - 1] || '');
    var hint = hints[f.key] && hints[f.key][letter] ? String(hints[f.key][letter]) : '';
    var isHint = hint !== '' && squash_(existing) === squash_(hint);
    var blank = squash_(existing) === '' || isHint;
    var oldNote = String(notes[row - 1][colNum - 1] || '');
    var bg = String(backs[row - 1][colNum - 1] || '').toLowerCase();
    var plainBg = bg === '' || bg === '#ffffff';
    var value = String(f.value == null ? '' : f.value);
    if (squash_(value) === '') continue;

    if (blank) {
      var text = value;
      // short hints such as "Parent" / "Student" are labels: keep them as the first line
      if (isHint && hint.length <= 12) text = hint + '\n' + value;
      writeValue_(cell, text, !!LINK_KEYS[f.key]);
      cell.setNote(mergeNote_(oldNote, noteBlock_('FILLED FROM WEBSITE', stamp, f, null)));
      if (plainBg || isHint) cell.setBackground(CONFIG.FILLED_COLOR);
      counts.filled++;
      rowsOut.push({ key: f.key, label: f.label, result: 'filled' });
    } else if (same_(existing, plainText_(value, !!LINK_KEYS[f.key]))) {
      counts.unchanged++;
      rowsOut.push({ key: f.key, label: f.label, result: 'unchanged' });
    } else {
      cell.setNote(mergeNote_(oldNote, noteBlock_('UPDATED INFO ON WEBSITE (cell not overwritten)', stamp, f, value)));
      if (plainBg) cell.setBackground(CONFIG.UPDATE_COLOR);
      counts.flagged++;
      rowsOut.push({ key: f.key, label: f.label, result: 'flagged' });
    }
  }

  var tabUrl = ss.getUrl() + '#gid=' + sheet.getSheetId();
  logExport_(ss, sheet, school, counts, found.created);
  return {
    ok: true, tab: sheet.getName(), tabUrl: tabUrl, created: found.created,
    summary: { sent: fields.length, filled: counts.filled, flagged: counts.flagged, unchanged: counts.unchanged, noRow: counts.noRow },
    rows: rowsOut
  };
}

function squash_(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
function alnum_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

/** Does the existing cell already say what the website says? Deliberately generous: a person reviews the rest. */
function same_(existing, scraped) {
  var a = alnum_(existing), b = alnum_(scraped);
  if (!a || !b) return false;
  if (a === b) return true;
  var shorter = a.length < b.length ? a : b, longer = a.length < b.length ? b : a;
  if (shorter.length >= 6 && longer.indexOf(shorter) >= 0) return true;
  var nums = String(scraped).match(/\d[\d,.]*/g) || [];
  if (nums.length > 0 && nums.length <= 3 && String(scraped).length <= 40) {
    var have = (String(existing).match(/\d[\d,.]*/g) || []).map(function (n) { return n.replace(/,/g, ''); });
    var all = true;
    for (var i = 0; i < nums.length; i++) if (have.indexOf(nums[i].replace(/,/g, '')) < 0) all = false;
    if (all) return true;
  }
  return false;
}

// "Name — https://link" lines
function linkLines_(value) {
  var lines = String(value).split('\n'), out = [], any = false;
  for (var i = 0; i < lines.length; i++) {
    var m = /^(.*?)\s+—\s+(https?:\/\/\S+)\s*$/.exec(lines[i]);
    if (m) { out.push({ text: m[1], url: m[2] }); any = true; } else out.push({ text: lines[i], url: null });
  }
  return any ? out : null;
}

function plainText_(value, asLinks) {
  var parts = asLinks ? linkLines_(value) : null;
  return parts ? parts.map(function (p) { return p.text; }).join('\n') : String(value);
}

function writeValue_(cell, text, asLinks) {
  cell.setNumberFormat('@');   // keep it text: "6:1" must not become a time, "9-12" must not become a date
  var parts = asLinks ? linkLines_(text) : null;
  if (!parts) { cell.setValue(text); return; }
  var full = parts.map(function (p) { return p.text; }).join('\n');
  var b = SpreadsheetApp.newRichTextValue().setText(full);
  var at = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].url && parts[i].text.length) b = b.setLinkUrl(at, at + parts[i].text.length, parts[i].url);
    at += parts[i].text.length + 1;
  }
  cell.setRichTextValue(b.build());
}

function noteBlock_(head, stamp, f, websiteValue) {
  var urls = [];
  var src = f.sources || [];
  for (var i = 0; i < src.length; i++) if (src[i].url) urls.push(src[i].url);
  var lines = [NOTE_MARK + ' ' + head + ' ' + stamp];
  if (websiteValue != null) {
    var v = String(websiteValue);
    if (v.length > CONFIG.MAX_NOTE_CHARS) v = v.slice(0, CONFIG.MAX_NOTE_CHARS) + ' ...';
    lines.push('', 'Website says:', v);
  }
  lines.push('', 'Source: ' + (urls.join(', ') || 'see dashboard'), 'Confidence: ' + (f.confidence || 'unknown'));
  if (f.note) lines.push('Note: ' + f.note);
  lines.push('Please fact check.');
  return lines.join('\n');
}

/** Keeps any note a person wrote and replaces only the block this script wrote earlier. */
function mergeNote_(oldNote, block) {
  var at = oldNote.indexOf(NOTE_MARK);
  var human = (at >= 0 ? oldNote.slice(0, at) : oldNote).replace(/\s+$/, '');
  return human ? human + '\n\n' + block : block;
}

// ------------------------------------------------------------ finding a tab ---

function findTab_(ss, school) {
  var sheets = ss.getSheets();
  var names = [school.tab, school.name].filter(function (x) { return x; });
  var i, j, n;
  // 1. exact title
  for (i = 0; i < sheets.length; i++) {
    n = sheets[i].getName().trim().toLowerCase();
    for (j = 0; j < names.length; j++) if (n === String(names[j]).trim().toLowerCase()) return { sheet: sheets[i], created: false };
  }
  // 2. same letters and digits
  for (i = 0; i < sheets.length; i++) {
    n = alnum_(sheets[i].getName());
    for (j = 0; j < names.length; j++) if (n && n === alnum_(names[j])) return { sheet: sheets[i], created: false };
  }
  // 3. the workbook export cut long tab titles to 31 characters: match on the start, when only one tab fits
  var hits = [];
  var wantTab = alnum_(school.tab), wantName = alnum_(school.name);
  for (i = 0; i < sheets.length; i++) {
    n = alnum_(sheets[i].getName());
    if (!n || n === alnum_(CONFIG.TEMPLATE_TAB) || n === alnum_(CONFIG.LOG_TAB)) continue;
    var cut = (wantTab && wantTab.length >= 20 && n.indexOf(wantTab) === 0 && wantName.indexOf(wantTab) === 0);
    var longer = (n.length >= 20 && wantName.indexOf(n) === 0);
    if (cut || longer) hits.push(sheets[i]);
  }
  if (hits.length === 1) return { sheet: hits[0], created: false };
  // 4. last resort: the school name typed in cell B1 of each tab
  var wantB1 = [alnum_(school.nameInTab), wantName].filter(function (x) { return x; });
  var started = new Date().getTime();
  for (i = 0; i < sheets.length && new Date().getTime() - started < 60000; i++) {
    n = alnum_(sheets[i].getName());
    if (n === alnum_(CONFIG.TEMPLATE_TAB) || n === alnum_(CONFIG.LOG_TAB)) continue;
    var b1 = alnum_(sheets[i].getRange(1, 2).getDisplayValue());
    if (b1 && wantB1.indexOf(b1) >= 0) return { sheet: sheets[i], created: false };
  }
  return { sheet: createTab_(ss, school), created: true };
}

function createTab_(ss, school) {
  var tpl = ss.getSheetByName(CONFIG.TEMPLATE_TAB);
  if (!tpl) throw new Error('This school has no tab and there is no "' + CONFIG.TEMPLATE_TAB + '" tab to copy.');
  var s = tpl.copyTo(ss);
  var base = String(school.name).replace(/[\[\]*?:\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 95) || 'New school';
  var name = base, k = 2;
  while (ss.getSheetByName(name)) { name = base.slice(0, 90) + ' (' + k + ')'; k++; }
  s.setName(name);
  s.getRange(1, 2).setValue(school.name);
  if (school.website && /^https?:\/\//i.test(school.website)) {
    s.getRange(1, 3).setRichTextValue(SpreadsheetApp.newRichTextValue().setText('Website Link').setLinkUrl(school.website).build());
  }
  // the filled tabs have a header row under "Guide to Applying" naming the two columns
  var loc = locateRows_(s);
  if (loc.guideRow) {
    s.insertRowAfter(loc.guideRow);
    s.getRange(loc.guideRow + 1, 2, 1, 2).setValues([['Admissions Portal', 'School Website']]).setFontWeight('bold');
  }
  return s;
}

// -------------------------------------------------------- log and daily email ---

var LOG_HEADERS = ['Exported at', 'School', 'Tab', 'Filled (were blank)', 'Updates to check', 'Already matched', 'Not in tab', 'Reviewed?', 'Reviewed by', 'Review notes', 'Emailed'];

function logSheet_(ss) {
  var log = ss.getSheetByName(CONFIG.LOG_TAB);
  if (log) return log;
  log = ss.insertSheet(CONFIG.LOG_TAB);
  log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
  log.setFrozenRows(1);
  return log;
}

function logExport_(ss, sheet, school, counts, created) {
  var log = logSheet_(ss);
  var row = log.getLastRow() + 1;
  log.getRange(row, 1, 1, 7).setValues([[new Date(), school.name, '', counts.filled, counts.flagged, counts.unchanged, counts.noRow]]);
  log.getRange(row, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  log.getRange(row, 3).setFormula('=HYPERLINK("#gid=' + sheet.getSheetId() + '","' + sheet.getName().replace(/"/g, '""') + '")');
  log.getRange(row, 8).insertCheckboxes();
  if (created) log.getRange(row, 10).setValue('New tab created from ' + CONFIG.TEMPLATE_TAB);
}

function notifyEmails_() {
  var p = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAILS');
  return String(p || CONFIG.NOTIFY_EMAILS || '').replace(/\s+/g, '').replace(/^,+|,+$/g, '');
}

/** Run once from the editor (Run > setupDailyDigest) to start the daily email. */
function setupDailyDigest() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) if (triggers[i].getHandlerFunction() === 'sendDailyDigest') ScriptApp.deleteTrigger(triggers[i]);
  ScriptApp.newTrigger('sendDailyDigest').timeBased().everyDays(1).atHour(CONFIG.DIGEST_HOUR).create();
  Logger.log('Daily email set for about ' + CONFIG.DIGEST_HOUR + ':00 in this sheet\'s time zone.');
}

/** One email listing every school exported since the last email. Does nothing when there is nothing new. */
function sendDailyDigest() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(CONFIG.LOG_TAB);
  if (!log || log.getLastRow() < 2) return;
  var rows = log.getRange(2, 1, log.getLastRow() - 1, LOG_HEADERS.length).getValues();
  var pending = [];
  for (var i = 0; i < rows.length; i++) if (!rows[i][10] && rows[i][1]) pending.push({ row: i + 2, v: rows[i] });
  if (!pending.length) return;
  var to = notifyEmails_();
  if (!to) { Logger.log('NOTIFY_EMAILS is empty, so no email was sent. ' + pending.length + ' export(s) are waiting.'); return; }

  var bySchool = {}, order = [];
  pending.forEach(function (p) {
    var name = String(p.v[1]);
    if (!bySchool[name]) { bySchool[name] = p; order.push(name); } else bySchool[name] = p; // the latest export of a school wins
  });
  var logUrl = ss.getUrl() + '#gid=' + log.getSheetId();
  var lines = [];
  order.forEach(function (name) {
    var v = bySchool[name].v;
    lines.push('- ' + name + ': ' + v[3] + ' filled, ' + v[4] + ' with updated info to check' + (v[9] ? ' (' + v[9] + ')' : ''));
  });
  var body = order.length + ' school' + (order.length === 1 ? '' : 's') + ' updated in "' + ss.getName() + '" and waiting for a fact check:\n\n' +
    lines.join('\n') + '\n\nIn each school\'s tab, yellow cells were filled from the school website and orange cells have a note with newer ' +
    'information from the website (the existing text was not changed). Hover a cell to read its note and source link.\n\n' +
    'Tick "Reviewed?" in the Export Log once a school has been checked:\n' + logUrl + '\n';
  MailApp.sendEmail({ to: to, subject: 'School Info Sheet: ' + order.length + ' school' + (order.length === 1 ? '' : 's') + ' updated', body: body });
  var now = new Date();
  pending.forEach(function (p) { log.getRange(p.row, 11).setValue(now); });
}
