/*
 * pcc-pars core — pure logic for the PARS attendance helper. No browser-only globals, so it runs both
 * in the content script (as `PARSCore` on the page) AND in Node/jsdom tests (via module.exports). It only
 * reads/writes a `document`; all the policy (minutes -> hours, who to fill) lives here so it is testable
 * against the real PARS HTML.
 *
 * PARS facts this encodes (verified from the live page):
 *  - A class meets on ONE weekday; that day's hours cell is the single editable <input> in each student row
 *    (the other six are disabled). The input carries onchange="hours_changed(this,'YYYYMMDD')".
 *  - Students are rows `tr#sturow{N}` with `td.stuname`, `td.stuiin` (the IIN — the stable join key), and
 *    seven `td.stuhrs` cells.
 *  - PARS counts attendance in the class's own "hour" unit = scheduledMinutes / fullCreditHours
 *    (e.g. 195 min / 3.9 h = 50-minute hours). Hours are stored to one decimal.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;       // Node / jsdom tests
  else root.PARSCore = api;                                                          // content script
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;   // PARS stores tenths of an hour

  /** Minutes present -> PARS hours, using the class's own unit (scheduledMinutes / fullHours, ~50). */
  function minutesToHours(minutes, unit) {
    const u = Number(unit) > 0 ? Number(unit) : 50;
    return round1(Math.max(0, Number(minutes) || 0) / u);
  }

  /** Class meta from #crn_heading ("(195 minutes)") + the "Autofill 3.9 hours" label. */
  function parseMeta(doc) {
    const heading = ((doc.querySelector('#crn_heading') || {}).textContent || '').replace(/ /g, ' ');
    const minMatch = heading.match(/\((\d+)\s*minutes?\)/i);
    const scheduledMinutes = minMatch ? Number(minMatch[1]) : null;
    const bodyText = ((doc.querySelector('#students') || doc.body || {}).textContent || '');
    const fullMatch = bodyText.match(/Autofill\s+([\d.]+)\s+hours/i);
    const fullHours = fullMatch ? Number(fullMatch[1]) : (scheduledMinutes ? round1(scheduledMinutes / 50) : null);
    const unit = (scheduledMinutes && fullHours) ? round1(scheduledMinutes / fullHours) : 50;
    const label = (heading.split(/\s-\s*Instructor/i)[0] || heading).replace(/\s+/g, ' ').trim();
    return { scheduledMinutes, fullHours, unit, label };
  }

  /** ALL editable (non-disabled, non-readonly) hours inputs in a student row. A single-meeting week has
   *  exactly one; a class meeting 2x/week has two — which this tool detects and refuses (see parseRoster). */
  function editableInputs(row) {
    const out = [];
    const inputs = row.querySelectorAll('td.stuhrs input');
    for (let i = 0; i < inputs.length; i++) { if (!inputs[i].disabled && !inputs[i].readOnly) out.push(inputs[i]); }
    return out;
  }
  function editableInput(row) { return editableInputs(row)[0] || null; }

  /** Meeting date (YYYYMMDD) from an editable input's onchange="hours_changed(this,'YYYYMMDD')". */
  function meetingDateOf(input) {
    const oc = input && input.getAttribute && input.getAttribute('onchange');
    const m = oc && oc.match(/hours_changed\([^,]+,\s*['"](\d{8})['"]\)/);
    return m ? m[1] : null;
  }

  /** Full roster from the PARS page: { meta, meetingDate, students:[{idx,seq,name,iin,rowId,currentHours}] }. */
  function parseRoster(doc) {
    const meta = parseMeta(doc);
    const rows = Array.prototype.slice.call(doc.querySelectorAll('table.pars_table.stulist tr[id^="sturow"]'));
    // A week with >1 editable cell per row = the class meets multiple days; this single-day tool refuses it.
    meta.multiMeeting = rows.some((row) => editableInputs(row).length > 1);
    let meetingDate = null;
    const students = rows.map((row) => {
      const input = editableInput(row);
      if (input && !meetingDate) meetingDate = meetingDateOf(input);
      const nameEl = row.querySelector('td.stuname');
      const iinEl = row.querySelector('td.stuiin');
      const seqEl = row.querySelector('td.stuseq');
      return {
        idx: Number((row.id.match(/sturow(\d+)/) || [])[1]),
        seq: seqEl ? seqEl.textContent.replace(/[.\s]/g, '') : '',
        name: nameEl ? nameEl.textContent.trim() : '',
        iin: iinEl ? iinEl.textContent.trim() : '',
        rowId: row.id,
        hasInput: !!input,
        currentHours: input ? (parseFloat(input.value) || 0) : null,
      };
    }).filter((s) => s.iin && s.hasInput);   // only students with an editable cell this week (open/uncertified)
    return { meta, meetingDate, students };
  }

  /** Fill plan: the MINUTES present to write per student (PARS converts minutes->hours itself; see
   *  applyFill). marks: { [iin]: { minutes } | { absent:true } }. Unmarked students keep whatever PARS
   *  currently shows (no accidental wipe). `hours` is included for display only. */
  function buildFillPlan(roster, marks) {
    marks = marks || {};
    const unit = (roster.meta && roster.meta.unit) || 50;
    const full = (roster.meta && roster.meta.scheduledMinutes);
    return roster.students.map((s) => {
      const mark = marks[s.iin];
      let minutes;
      if (mark && mark.absent) minutes = 0;
      else if (mark && mark.minutes != null) {
        minutes = Math.max(0, Math.round(Number(mark.minutes) || 0));
        if (full != null) minutes = Math.min(full, minutes);   // never exceed the class length (clipboard is a trust boundary)
      }
      else if (s.currentHours != null) minutes = Math.round(s.currentHours * unit);   // unmarked: keep current
      else minutes = full != null ? full : 0;
      return { iin: s.iin, rowId: s.rowId, name: s.name, minutes, hours: minutesToHours(minutes, unit) };
    });
  }

  /** Apply a fill plan to the live page: set each editable input's value + fire `change` (so PARS's own
   *  hours_changed handler records it). SELF-VERIFYING: before writing a row it confirms the row's IIN
   *  still matches the plan item, so a stale plan (the DOM changed underneath) can't write to the wrong
   *  student. Returns { written, skipped }. Henry then reviews + clicks Certify. */
  function applyFill(doc, plan) {
    let written = 0, skipped = 0;
    for (const item of plan) {
      const row = doc.getElementById(item.rowId);
      const iinEl = row && row.querySelector('td.stuiin');
      // Fail CLOSED: write only when the row's IIN positively matches the plan item (a missing IIN cell or
      // a mismatch -> skip, so a changed DOM can never get a value written to the wrong/unknown student).
      if (!row || !iinEl || iinEl.textContent.trim() !== item.iin) { skipped++; continue; }
      const input = editableInput(row);
      if (!input) { skipped++; continue; }
      // PARS's hours_changed reads a BARE number as CLOCK hours (×60/50 — so "3.9" would wrongly become
      // 4.68 and pop a disambiguation alert). The documented way to enter time is "/<minutes>" (minutes
      // present), which PARS converts to attendance hours itself. Absent stays bare "0" (PARS's own form).
      input.value = item.minutes > 0 ? '/' + item.minutes : '0';
      const view = (input.ownerDocument && input.ownerDocument.defaultView) || (typeof window !== 'undefined' ? window : null);
      if (view && view.Event) {
        input.dispatchEvent(new view.Event('input', { bubbles: true }));
        input.dispatchEvent(new view.Event('change', { bubbles: true }));
      }
      written++;
    }
    return { written, skipped };
  }

  // ---- Phase-2 handoff codec: serialize the roster (Mac extension -> phone) and the marks (phone ->
  // Mac extension) as tagged plain-text blobs. Plain JSON (not base64) so it's unicode-safe, debuggable,
  // and survives Apple Universal Clipboard / AirDrop between Henry's own devices. No cloud. ----
  function encodeRoster(roster) {
    return 'PARSROSTER1 ' + JSON.stringify({
      label: roster.meta.label, meetingDate: roster.meetingDate, multiMeeting: !!roster.meta.multiMeeting,
      scheduledMinutes: roster.meta.scheduledMinutes, fullHours: roster.meta.fullHours, unit: roster.meta.unit,
      students: (roster.students || []).map((s) => ({ iin: s.iin, name: s.name, seq: s.seq })),
    });
  }
  function decodeRoster(text) {
    const m = String(text || '').trim().match(/^PARSROSTER1\s+([\s\S]+)$/);
    if (!m) return null;
    try { const o = JSON.parse(m[1]); return (o && Array.isArray(o.students)) ? o : null; } catch (_) { return null; }
  }
  function encodeMarks(payload) {
    return 'PARSMARKS1 ' + JSON.stringify({ label: payload.label, meetingDate: payload.meetingDate, marks: payload.marks || [] });
  }
  function decodeMarks(text) {
    const m = String(text || '').trim().match(/^PARSMARKS1\s+([\s\S]+)$/);
    if (!m) return null;
    try { const o = JSON.parse(m[1]); return (o && Array.isArray(o.marks)) ? o : null; } catch (_) { return null; }
  }

  return { round1, minutesToHours, parseMeta, editableInput, editableInputs, meetingDateOf, parseRoster, buildFillPlan, applyFill, encodeRoster, decodeRoster, encodeMarks, decodeMarks };
});
