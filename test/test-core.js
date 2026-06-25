'use strict';

/**
 * Offline tests for pcc-pars/src/core.js, run against the real PARS HTML structure (jsdom + the fixture).
 *   npm test
 * Verifies the roster scrape (names with commas, leading-zero IINs, absences), the class meta + 50-min
 * hour unit, minutes->hours, the fill plan (unmarked students keep their value), and applyFill writing
 * the right inputs + firing change.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const core = require('../src/core');

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); };

const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'pars-roster.html'), 'utf8');
const doc = new JSDOM(html).window.document;

// 1) meta
const meta = core.parseMeta(doc);
ok(meta.scheduledMinutes === 195, 'parseMeta reads scheduled minutes (195)');
ok(meta.fullHours === 3.9, 'parseMeta reads full-credit hours (3.9) from the Autofill label');
ok(meta.unit === 50, 'derives the hour unit = 195/3.9 = 50 (not hardcoded)');
ok(/MUSC 60\+OLAD360/.test(meta.label) && !/Instructor/.test(meta.label), 'class label parsed, instructor trimmed');

// 2) minutes -> hours
ok(core.minutesToHours(195, 50) === 3.9, '195 min -> 3.9 h');
ok(core.minutesToHours(190, 50) === 3.8, '190 min -> 3.8 h (5 min late)');
ok(core.minutesToHours(0, 50) === 0 && core.minutesToHours(-5, 50) === 0, 'absent/negative -> 0');
ok(core.minutesToHours(195) === 3.9, 'defaults the unit to 50 when omitted');

// 3) roster scrape
const roster = core.parseRoster(doc);
ok(roster.students.length === 8, 'scrapes all 8 students that have an editable cell');
ok(roster.meetingDate === '20260608', 'meeting date pulled from the editable input onchange (YYYYMMDD)');
const byName = (n) => roster.students.find((s) => s.name === n);
ok(byName('Baker, Robin D').iin === '00000042', 'preserves a leading-zero IIN (string, not number)');
ok(!!byName('Nguyen, Pat Lee, Jr'), 'a multi-comma name is captured whole');
ok(!!byName('De La Cruz, Maria Elena'), 'a two-word surname is captured whole');
ok(byName('Castille, Jordan').currentHours === 0 && byName('Anderson, Alex J').currentHours === 3.9, 'reads current PARS values (absent=0, present=3.9)');
ok(roster.students.every((s) => s.rowId && /^sturow\d+$/.test(s.rowId)), 'every student carries its rowId for the write-back');

// 4) fill plan — unmarked keep current; marks override
const marks = {
  '00000042': { minutes: 190 },              // Robin 5 min late -> 3.8
  '10000008': { absent: true },              // Underwood absent -> 0
  '10000003': { minutes: 195 },              // Jordan now marked present -> 3.9 (was 0)
};
const plan = core.buildFillPlan(roster, marks);
const planFor = (iin) => plan.find((p) => p.iin === iin);
ok(planFor('00000042').minutes === 190 && planFor('00000042').hours === 3.8, 'marked late -> 190 min / 3.8 h');
ok(planFor('10000008').minutes === 0 && planFor('10000008').hours === 0, 'marked absent -> 0');
ok(planFor('10000003').minutes === 195 && planFor('10000003').hours === 3.9, 'marked present overrides prior 0 -> 195 min / 3.9 h');
ok(planFor('10000001').minutes === 195 && planFor('10000001').hours === 3.9, 'UNMARKED keeps current (3.9 h -> 195 min, no wipe)');
ok(plan.length === 8, 'plan covers every student');

// 5) applyFill writes the right inputs and fires change
let changeFired = 0;
roster.students.forEach((s) => {
  const inp = doc.getElementById(s.rowId).querySelector('td.stuhrs input:not([disabled])');
  inp.addEventListener('change', () => { changeFired++; });
});
const res = core.applyFill(doc, plan);
ok(res.written === 8 && res.skipped === 0, 'applyFill writes all 8 editable inputs');
ok(changeFired === 8, 'applyFill fires a change event on each (so PARS records it)');
ok(doc.getElementById('sturow3').querySelector('input:not([disabled])').value === '/190', 'Robin written as /190 (PARS minutes syntax, not bare hours)');
ok(doc.getElementById('sturow61').querySelector('input:not([disabled])').value === '0', 'Underwood written as 0 (absent)');
ok(doc.getElementById('sturow0').querySelector('input:not([disabled])').value === '/195', 'unmarked Alex written as /195 (keeps full)');
// never touches a disabled day
ok(doc.getElementById('sturow0').querySelectorAll('input[disabled]').length === 6, 'the 6 non-meeting days remain disabled/untouched');

// 6) stale-DOM safety: a plan item whose rowId now holds a DIFFERENT student (IIN) is SKIPPED, not written.
const doc2 = new JSDOM(html).window.document;
const stalePlan = [
  { iin: 'WRONG-IIN', rowId: 'sturow0', name: 'x', minutes: 50, hours: 1.0 },  // sturow0 really holds IIN 10000001
  { iin: '10000008', rowId: 'sturow61', name: 'Underwood', minutes: 100, hours: 2.0 },  // matches -> writes
];
const res2 = core.applyFill(doc2, stalePlan);
ok(res2.written === 1 && res2.skipped === 1, 'applyFill skips a row whose IIN no longer matches (stale grid safety)');
ok(doc2.getElementById('sturow0').querySelector('input:not([disabled])').value === '3.9', 'mismatched row is NOT overwritten');
ok(doc2.getElementById('sturow61').querySelector('input:not([disabled])').value === '/100', 'matched row is written (/100)');

// 7) single-meeting week is not flagged; a row with TWO editable inputs IS (multi-day -> refused by UI).
ok(core.parseRoster(new JSDOM(html).window.document).meta.multiMeeting === false, 'single-meeting week: multiMeeting=false');
const multiDoc = new JSDOM('<table class="pars_table stulist"><tbody><tr id="sturow0"><td class="stuseq">1.</td><td class="stuname">A, B</td><td class="stuiin">111</td><td></td><td class="stutotal">9</td><td class="stuhrs"><input value="3.9" onchange="hours_changed(this,&quot;20260608&quot;)"></td><td class="stuhrs"><input value="3.9" onchange="hours_changed(this,&quot;20260610&quot;)"></td><td class="stuhrs"><input disabled></td></tr></tbody></table>').window.document;
ok(core.parseRoster(multiDoc).meta.multiMeeting === true, 'detects a multi-meeting week (a row with 2 editable inputs)');

// 8) applyFill fails CLOSED when a row has no IIN cell (can't verify -> don't write).
const noIin = new JSDOM('<table class="pars_table stulist"><tbody><tr id="sturowX"><td class="stuseq">1.</td><td class="stuname">A, B</td><td></td><td class="stutotal">9</td><td class="stuhrs"><input value="3.9"></td></tr></tbody></table>').window.document;
const r3 = core.applyFill(noIin, [{ iin: '111', rowId: 'sturowX', name: 'A', hours: 1.0 }]);
ok(r3.written === 0 && r3.skipped === 1, 'applyFill fails CLOSED: a row with no IIN cell is skipped, not written');

// 9) Phase-2 handoff codec round-trips (roster Mac->phone, marks phone->Mac) and rejects junk.
const rosterBlob = core.encodeRoster(roster);
ok(/^PARSROSTER1 /.test(rosterBlob), 'encodeRoster emits a tagged text blob');
const decoded = core.decodeRoster(rosterBlob);
ok(decoded && decoded.students.length === 8 && decoded.meetingDate === '20260608' && decoded.scheduledMinutes === 195, 'decodeRoster round-trips the roster + meta');
ok(decoded.students.find((s) => s.iin === '00000042').name === 'Baker, Robin D', 'roster blob preserves iin + name (unicode-safe JSON)');
const marksBlob = core.encodeMarks({ label: roster.meta.label, meetingDate: roster.meetingDate, marks: [{ iin: '00000042', minutes: 190 }, { iin: '10000008', minutes: 0 }] });
const dm = core.decodeMarks(marksBlob);
ok(/^PARSMARKS1 /.test(marksBlob) && dm.marks.length === 2 && dm.marks[0].iin === '00000042' && dm.marks[0].minutes === 190, 'marks blob round-trips');
ok(core.decodeRoster('garbage') === null && core.decodeMarks('PARSROSTER1 {}') === null && core.decodeMarks('') === null, 'decoders reject junk / wrong tag / empty');
ok(decoded.multiMeeting === false, 'roster blob carries the multiMeeting flag (false for a single-meeting week)');
ok(core.buildFillPlan(roster, { '00000042': { minutes: 99999 } }).find((p) => p.iin === '00000042').minutes === 195, 'buildFillPlan clamps an over-range clipboard mark to the class length (195)');

// 10) Phase-2.1 multi-class bundles round-trip (load all classes at once).
ok(core.toRosterBlob(roster).students.length === 8 && core.toRosterBlob(roster).scheduledMinutes === 195, 'toRosterBlob flattens a parseRoster result');
const bundleBlob = core.encodeBundle([roster, roster]);
const rb = core.decodeBundle(bundleBlob);
ok(/^PARSBUNDLE1 /.test(bundleBlob) && Array.isArray(rb) && rb.length === 2 && rb[0].students.length === 8 && rb[0].scheduledMinutes === 195 && rb[0].multiMeeting === false, 'encode/decodeBundle round-trips multiple roster blobs');
ok(core.decodeBundle('garbage') === null && core.decodeBundle('PARSROSTER1 x') === null, 'decodeBundle rejects junk / wrong tag');
const mbBlob = core.encodeMarksBundle([{ label: 'A', meetingDate: '20260608', marks: [{ iin: '111', minutes: 100 }] }, { label: 'B', meetingDate: '20260610', marks: [] }]);
const mb = core.decodeMarksBundle(mbBlob);
ok(/^PARSMARKSB1 /.test(mbBlob) && Array.isArray(mb) && mb.length === 2 && mb[0].label === 'A' && mb[0].marks[0].minutes === 100, 'encode/decodeMarksBundle round-trips multiple classes');
ok(core.decodeMarksBundle('PARSMARKS1 {}') === null, 'decodeMarksBundle rejects a single-marks blob (different tag)');
ok(core.decodeMarksBundle('PARSMARKSB1 ' + JSON.stringify({ classes: [null, { label: 'A', meetingDate: 'x', marks: [] }, { label: 'B' }] })).length === 1, 'decodeMarksBundle filters null / malformed class entries (trust boundary)');
ok(core.decodeBundle('PARSBUNDLE1 ' + JSON.stringify({ rosters: [null, { label: 'A', students: [] }, { label: 'B' }] })).length === 1, 'decodeBundle filters null / no-students roster entries');

// 11) Phase-2.2 week-date math (load once, app rolls the week itself).
ok(core.dayOfWeekOf('20260608') === 1, 'Jun 8 2026 is a Monday (matches the fixture meeting day)');
ok(core.shiftWeeks('20260608', 1) === '20260615' && core.shiftWeeks('20260608', -1) === '20260601', 'shiftWeeks ±1 stays on Monday');
ok(core.weekdayInWeekOf(1, '20260610') === '20260608', 'Monday of the week containing Wed Jun 10 is Jun 8');
ok(core.weekdayInWeekOf(1, '20260608') === '20260608', 'Monday-of-week for a Monday is itself');
ok(core.dayOfWeekOf(core.weekdayInWeekOf(4, '20260608')) === 4, 'weekdayInWeekOf returns the requested weekday (Thu)');
ok(core.shiftWeeks('20251229', 1) === '20260105', 'shiftWeeks crosses a year boundary correctly');

// 12) Phase-2.2 mark predicates — the data-loss safety gates (auto-roll only when there's nothing to lose).
const studs = [{ iin: 'a' }, { iin: 'b' }, { iin: 'c' }];
ok(core.hasNonFullMarks(studs, { a: 195, b: 195, c: 195 }, 195) === false, 'all-present -> no marks to protect (auto-roll OK)');
ok(core.hasNonFullMarks(studs, {}, 195) === false, 'empty minutes default to full -> no marks');
ok(core.hasNonFullMarks(studs, { a: 195, b: 0, c: 195 }, 195) === true, 'an absence (0) -> protected from auto-roll');
ok(core.hasNonFullMarks(studs, { a: 190 }, 195) === true, 'a partial (190<195) -> protected');
const rec = core.reconcileMinutes({ a: 0, b: 190 }, [{ iin: 'b' }, { iin: 'd' }], 195);
ok(rec.b === 190 && rec.d === 195 && rec.a === undefined, 'reconcileMinutes: keep continuing (b=190), default new (d=195), drop departed (a) — marks survive add/drop');

console.log(`\n${fail === 0 ? '✓ ALL GOOD' : '✗ FAILURES'}: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
