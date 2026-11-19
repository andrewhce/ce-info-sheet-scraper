'use strict';
// Adding a school by hand, so that a new school does not need the whole School Information Sheet to be uploaded again.
//
// A school added here is written to data/schools.json (so every page sees it at once) and remembered in data/added-schools.json.
// When the full sheet is uploaded later, import-workbook.js keeps the schools added here unless the sheet now lists them itself
// (same name), in which case the sheet's row takes over and the earlier results stay with the school.
const fs = require('fs');
const path = require('path');
const { PATHS, readJson, writeJson, slug, alnum, squash, clip } = require('./util');
const { cleanStart } = require('./crawl');

class SchoolListError extends Error { constructor(m, status) { super(m); this.status = status || 422; } }

const addedFile = () => path.join(PATHS.data, 'added-schools.json');
const loadAdded = () => { const x = readJson(addedFile(), []); return Array.isArray(x) ? x : []; };

function divisionOf(name) {
  const n = String(name).toLowerCase();
  if (/\blower\b|elementary|preschool|junior school/.test(n)) return 'lower';
  if (/\bmiddle\b/.test(n)) return 'middle';
  if (/\bupper\b|\(high\)|high school/.test(n)) return 'upper';
  return null;
}

const webAddress = (raw, what) => {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { throw new SchoolListError(`The ${what} address does not look right.`); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new SchoolListError(`The ${what} address does not look right.`);
  return u.href;
};

/**
 * input: { name, website?, tier?, region?, portal? }. Returns the school as it is saved in schools.json.
 * Needs the school list to exist already (the sheet has been loaded once): the template and the other schools come from it.
 */
function addSchool(input) {
  const list = readJson(PATHS.schools, null);
  if (!list || !Array.isArray(list.schools)) throw new SchoolListError('Load your School Information Sheet once first. After that, new schools can be added here one at a time.', 400);
  const name = squash(String(input.name || '')).replace(/\n/g, ' ');
  if (name.length < 3) throw new SchoolListError('Type the school’s name (at least 3 letters).');
  if (name.length > 120) throw new SchoolListError('That name is too long.');
  const website = webAddress(input.website, 'website');
  const portal = webAddress(input.portal, 'application portal');
  const region = clip(squash(String(input.region || '')).replace(/\n/g, ' '), 80) || null;
  let tier = null;
  if (input.tier != null && String(input.tier).trim() !== '') {
    tier = Number(input.tier);
    if (![1, 2, 3].includes(tier)) throw new SchoolListError('Tier must be 1, 2 or 3 (or left empty).');
  }
  if (website) { try { cleanStart(website); } catch { throw new SchoolListError('The website address does not look right.'); } }

  const same = list.schools.find((s) => alnum(s.name) === alnum(name));
  if (same) throw new SchoolListError(`“${same.name}” is already in the list. Open it from the Schools page.`, 409);

  const taken = new Set(list.schools.map((s) => s.id));
  let id = slug(name) || 'school';
  while (taken.has(id)) id += '-2';
  const portalHost = portal ? new URL(portal).hostname.replace(/^www\./, '') : '';
  const school = {
    id, row: null, name, tier, region, website, portal,
    portalLabel: /ravenna-hub\.com$/i.test(portalHost) ? 'Ravenna' : null,
    appOpen: null, division: divisionOf(name), tabs: [],
    addedByHand: true, addedAt: new Date().toISOString(),
  };
  list.schools.push(school);
  writeJson(PATHS.schools, list);
  writeJson(addedFile(), [...loadAdded(), school]);
  return school;
}

/** Takes a school off the list again. Only schools added by hand can be removed this way; the sheet's own schools never are. */
function removeSchool(id) {
  const list = readJson(PATHS.schools, null);
  const school = list && Array.isArray(list.schools) && list.schools.find((s) => s.id === String(id));
  if (!school) throw new SchoolListError('That school was not found.', 404);
  if (!school.addedByHand) throw new SchoolListError('Only schools added by hand can be removed here. This one comes from your sheet.', 403);
  list.schools = list.schools.filter((s) => s.id !== school.id);
  writeJson(PATHS.schools, list);
  writeJson(addedFile(), loadAdded().filter((s) => s.id !== school.id));
  fs.rmSync(path.join(PATHS.resultsDir, school.id + '.json'), { force: true });
  return school;
}

/**
 * Used by import-workbook.js after it has read the sheet: returns the sheet's schools plus the ones added by hand that the sheet
 * does not list. A school the sheet now lists is dropped from the by-hand list (the sheet's row wins).
 */
function mergeAdded(sheetSchools) {
  const byName = new Set(sheetSchools.map((s) => alnum(s.name)));
  const ids = new Set(sheetSchools.map((s) => s.id));
  const keep = [], extra = [];
  for (const a of loadAdded()) {
    if (byName.has(alnum(a.name))) continue;
    keep.push(a);
    extra.push(ids.has(a.id) ? { ...a, id: a.id + '-added' } : a);
  }
  if (keep.length !== loadAdded().length) writeJson(addedFile(), keep);
  return { schools: [...sheetSchools, ...extra], kept: extra.length };
}

module.exports = { addSchool, removeSchool, mergeAdded, loadAdded, SchoolListError };
