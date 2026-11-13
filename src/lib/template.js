'use strict';
// Maps the row labels of the "Master Template" tab to stable field keys.
// The template stays the guide: rows are read from the workbook in order, and each
// label is matched to a key here. A label with no match still shows in the dashboard,
// marked as having no scraping rule yet.

const LABEL_KEYS = [
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
  ['peerSchools', /^peer schools/],
];

function normLabel(label) {
  return String(label || '').replace(/\s+/g, ' ').trim().replace(/:$/, '').trim().toLowerCase();
}

/**
 * Turns an ordered list of column-A labels into keyed rows.
 * "Events" appears twice in the template: first as a field inside Guide to Applying,
 * then as the heading of the Events section. They are told apart by order.
 */
function keyRows(labels) {
  const out = [];
  let section = 'School Facts';
  let seenEvents = false;
  for (const { row, label } of labels) {
    const n = normLabel(label);
    if (!n) continue;
    if (n === 'school name') { out.push({ row, label, key: 'schoolName', kind: 'name', section }); continue; }
    if (n === 'guide to applying') { section = 'Guide to Applying'; out.push({ row, label, key: null, kind: 'section', section }); continue; }
    if (n === 'events') {
      if (!seenEvents) { seenEvents = true; out.push({ row, label, key: 'guideEvents', kind: 'field', section, hasRule: true }); }
      else { section = 'Events'; out.push({ row, label, key: null, kind: 'section', section }); }
      continue;
    }
    if (n === 'peer schools') section = 'Peer Schools';
    const hit = LABEL_KEYS.find(([, re]) => re.test(n));
    out.push({ row, label: String(label).trim(), key: hit ? hit[0] : 'x_' + n.replace(/[^a-z0-9]+/g, '_'), kind: 'field', section, hasRule: !!hit });
  }
  return out;
}

module.exports = { keyRows, normLabel };
