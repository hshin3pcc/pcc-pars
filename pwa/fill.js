(function(){
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

  // ---- week-date math (Phase 2.2: load the roster once, the app rolls the date itself each week) ----
  function dateFromYmd(ymd) { const s = String(ymd); return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); }
  function ymdFromDate(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
  function dayOfWeekOf(ymd) { return dateFromYmd(ymd).getDay(); }   // 0=Sun … 6=Sat
  /** The date (YYYYMMDD) of weekday `dow` in the Sun–Sat week containing refYmd. */
  function weekdayInWeekOf(dow, refYmd) { const d = dateFromYmd(refYmd); d.setDate(d.getDate() - d.getDay() + Number(dow)); return ymdFromDate(d); }
  /** Shift a meeting date by n weeks (±7·n days), preserving the weekday. */
  function shiftWeeks(ymd, n) { const d = dateFromYmd(ymd); d.setDate(d.getDate() + 7 * Number(n)); return ymdFromDate(d); }
  /** Any student below full attendance? (an absence/partial = captured data worth protecting from auto-roll). */
  function hasNonFullMarks(students, minutes, full) {
    return (students || []).some((s) => s && s.iin != null && ((minutes && minutes[s.iin] != null ? minutes[s.iin] : full) < full));
  }
  /** Phase-2.2 on-open auto-roll PLAN (pure; the PWA applies it). For each class entry
   *  { weekDate, minutes, roster:{label, dayOfWeek, scheduledMinutes, students} } whose stored week is
   *  BEFORE the current week: it may roll only when it holds NO absence/partial (nothing to lose) — and
   *  even then it is NAMED in `rolled`, because the app cannot know whether that all-present week was
   *  ever actually FILED in PARS. The banner is the guardrail against silently losing an unfiled week.
   *  A stale week holding marks goes to `stuck` (kept + flagged, never rolled).
   *  Returns { rolled:[{key,label,fromDate}], stuck:[{key,label,weekDate}] }. */
  function planAutoRoll(entries, todayYmd) {
    const rolled = [], stuck = [];
    Object.keys(entries || {}).forEach((k) => {
      const e = entries[k];
      if (!e || !e.roster || e.roster.dayOfWeek == null || !e.weekDate) return;   // malformed → skip, never crash
      const full = e.roster.scheduledMinutes || 195;
      const curWeek = weekdayInWeekOf(e.roster.dayOfWeek, todayYmd);
      if (!(e.weekDate < curWeek)) return;                                        // current/future week: left alone
      if (hasNonFullMarks(e.roster.students, e.minutes, full)) stuck.push({ key: k, label: e.roster.label, weekDate: e.weekDate });
      else rolled.push({ key: k, label: e.roster.label, fromDate: e.weekDate });
    });
    return { rolled, stuck };
  }

  /** Reconcile a minutes map to a new roster (add/drop): keep a continuing student's mark, default a new
   *  student to full, drop a departed student. Pure — used on re-load so marks survive enrollment changes. */
  function reconcileMinutes(oldMinutes, students, full) {
    const m = {};
    (students || []).forEach((s) => { if (s && s.iin != null) m[s.iin] = (oldMinutes && oldMinutes[s.iin] != null) ? oldMinutes[s.iin] : full; });
    return m;
  }

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
  function toRosterBlob(roster) {
    return (roster && roster.meta) ? {
      label: roster.meta.label, meetingDate: roster.meetingDate, multiMeeting: !!roster.meta.multiMeeting,
      scheduledMinutes: roster.meta.scheduledMinutes, fullHours: roster.meta.fullHours, unit: roster.meta.unit,
      students: (roster.students || []).map((s) => ({ iin: s.iin, name: s.name, seq: s.seq })),
    } : roster;   // already a flat roster-blob object (e.g. round-tripped through storage)
  }
  function encodeRoster(roster) { return 'PARSROSTER1 ' + JSON.stringify(toRosterBlob(roster)); }
  /** Bundle SEVERAL class rosters into one blob (Mac -> phone, "all classes at once"). */
  function encodeBundle(rosters) { return 'PARSBUNDLE1 ' + JSON.stringify({ rosters: (rosters || []).map(toRosterBlob) }); }
  function decodeBundle(text) {
    const m = String(text || '').trim().match(/^PARSBUNDLE1\s+([\s\S]+)$/);
    if (!m) return null;
    try { const o = JSON.parse(m[1]); return (o && Array.isArray(o.rosters)) ? o.rosters.filter((r) => r && typeof r === 'object' && Array.isArray(r.students)) : null; } catch (_) { return null; }
  }
  /** Bundle SEVERAL classes' marks (phone -> Mac). entries: [{label, meetingDate, marks:[{iin,minutes}]}]. */
  function encodeMarksBundle(entries) { return 'PARSMARKSB1 ' + JSON.stringify({ classes: entries || [] }); }
  function decodeMarksBundle(text) {
    const m = String(text || '').trim().match(/^PARSMARKSB1\s+([\s\S]+)$/);
    if (!m) return null;
    try { const o = JSON.parse(m[1]); return (o && Array.isArray(o.classes)) ? o.classes.filter((c) => c && typeof c === 'object' && Array.isArray(c.marks)) : null; } catch (_) { return null; }
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
  /** Pick the marks-bundle entry matching the class ON SCREEN — by BOTH label and meeting date,
   *  fail closed (two same-weekday classes share a date, and label alone could span weeks). Used by
   *  the extension's stored-bundle fill and the phone bookmarklet. Returns the entry or null. */
  function matchBundleEntry(entries, label, meetingDate) {
    if (!Array.isArray(entries) || !label || !meetingDate) return null;
    return entries.find((e) => e && e.label === label && e.meetingDate === meetingDate) || null;
  }

  return { round1, minutesToHours, dayOfWeekOf, weekdayInWeekOf, shiftWeeks, ymdFromDate, hasNonFullMarks, planAutoRoll, reconcileMinutes, parseMeta, editableInput, editableInputs, meetingDateOf, parseRoster, buildFillPlan, applyFill, toRosterBlob, encodeRoster, decodeRoster, encodeBundle, decodeBundle, encodeMarks, decodeMarks, encodeMarksBundle, decodeMarksBundle, matchBundleEntry };
});

/*
 * PARS phone-fill bookmarklet WRAPPER — never shipped alone: scripts/build-bookmarklet.js composes
 * src/core.js + this file into a single `javascript:` URL, installed as a Safari bookmark on the
 * iPhone (install page: pwa/fill.html, hosted with the PWA). Tapping it ON the live PARS page:
 *   1. guards it's really PARS (a mistap on any other site does nothing),
 *   2. reads the marks bundle from the clipboard — the bookmarklet tap is the user gesture iOS
 *      requires, so Safari shows its one-tap paste-permission bubble; a manual paste box is the
 *      fallback,
 *   3. matches the class on screen by label + meeting date (fail closed, core.matchBundleEntry),
 *   4. fills via the SAME tested buildFillPlan/applyFill as the desktop extension,
 *   5. shows a review overlay. It NEVER touches Save/Certify — Henry reviews and taps PARS's own
 *      buttons, so the funding attestation stays a human action.
 */
(function () {
  var C = window.PARSCore;
  // Two targets, one wrapper. IN_SHORTCUT = running inside Apple Shortcuts' "Run JavaScript on
  // Web Page" action, whose contract is: the action WAITS until completion() is called. So
  // completion() must fire only at TERMINAL points (after the overlay is painted / the fill is
  // done) — an early unconditional call ends the shortcut before the async clipboard path runs
  // (live-observed: checkmark, no overlay). finish() is that single terminal chokepoint.
  var IN_SHORTCUT = (typeof completion === 'function');
  function finish(msg) {
    // THREE channels, because live debugging showed feedback can silently vanish: (1) the in-page
    // overlay; (2) the page's own alert() — WKWebView renders JS dialogs even for injected code;
    // (3) completion(msg), which a "Show Alert"/"Show Result" action after the JS action displays
    // in Apple's own UI. At least one must land.
    if (msg) {
      overlay(msg);
      if (IN_SHORTCUT) { try { window.alert(msg); } catch (_) {} }
    }
    if (IN_SHORTCUT) { try { completion(msg || 'PARS Fill: done.'); } catch (_) {} }
  }
  function say(m) {
    if (IN_SHORTCUT) finish(m);
    else if (typeof alert === 'function') alert(m);
  }
  if (!C) { say('PARS Fill: core failed to load — reinstall from the helper page.'); return; }

  var BOX_ID = 'pars-fill-overlay';
  function overlay(msg, withPaste) {
    var old = document.getElementById(BOX_ID); if (old) old.remove();
    var box = document.createElement('div');
    box.id = BOX_ID;
    // Sized for PARS's NON-responsive layout: iOS renders the page at ~980px virtual width and
    // scales it down, so normal-sized text becomes microscopic. 34px here ≈ comfortably readable.
    box.style.cssText = 'position:fixed;top:12px;left:12px;right:12px;z-index:2147483647;background:#1c1c1e;color:#fff;padding:24px;border-radius:18px;font:34px -apple-system,sans-serif;box-shadow:0 6px 32px rgba(0,0,0,.45)';
    var p = document.createElement('div'); p.textContent = msg; box.appendChild(p);
    if (withPaste) {
      var ta = document.createElement('textarea');
      ta.rows = 3; ta.placeholder = 'Paste the marks here…';
      ta.style.cssText = 'width:100%;margin-top:16px;font:26px ui-monospace,monospace;color:#000';
      box.appendChild(ta);
      var go = document.createElement('button'); go.textContent = 'Fill from pasted marks';
      go.style.cssText = 'margin-top:14px;width:100%;padding:18px;border-radius:14px;border:0;background:#0a84ff;color:#fff;font-size:32px';
      go.addEventListener('click', function () { fillFrom(ta.value); });
      box.appendChild(go);
    }
    var x = document.createElement('button'); x.textContent = 'Close';
    x.style.cssText = 'margin-top:14px;width:100%;padding:16px;border-radius:14px;border:0;background:#3a3a3c;color:#fff;font-size:32px';
    // Attribute handler on purpose: it runs in the PAGE world, so Close keeps working even after
    // the Shortcuts script context is torn down post-completion().
    x.setAttribute('onclick', 'document.getElementById("' + BOX_ID + '").remove()');
    box.appendChild(x);
    (document.body || document.documentElement).appendChild(box);
  }

  // Guard: only ever act on the real PARS page. Anywhere else, explain and do nothing.
  if (!/(^|\.)pasadena\.edu$/i.test(location.hostname) || location.pathname.toLowerCase().indexOf('pcc_pars') < 0) {
    say('PARS Fill: open the PARS attendance page (csweb-pub.pasadena.edu/pcc_pars/…) first, then run this again.');
    return;
  }
  var live = C.parseRoster(document);
  if (!live.students.length) {
    // Diagnostics ride the message: which document we actually ran in, and whether the roster
    // table exists at all (rows>0 with no editable cells = a certified/closed week; rows=0 = the
    // wrong document — e.g. a frameset parent — or not a roster page).
    var rows = document.querySelectorAll('tr[id^="sturow"]').length;
    finish('No editable roster on this page — pick a class and an OPEN (uncertified) week in PARS, then run PARS Fill again. [saw ' + rows + ' roster row(s) on ' + location.pathname + ']');
    return;
  }
  if (live.meta.multiMeeting) { finish('This class meets more than one day this week — the helper fills single-meeting weeks only. Enter this one directly in PARS.'); return; }
  if (!live.meta.scheduledMinutes) { finish('Couldn’t read the class length from PARS, so no hours will be guessed — enter this week directly in PARS.'); return; }

  function fillFrom(text) {
    var single;
    var bundle = C.decodeMarksBundle(text) || ((single = C.decodeMarks(text)) ? [single] : null);
    // Interactive paste-box retries only make sense in the bookmarklet (page world). In the
    // Shortcut, the cure is always the same: copy the marks, run PARS Fill again — say so + end.
    if (!bundle) {
      if (IN_SHORTCUT) { finish('The clipboard isn’t phone marks — in the PARS Attendance app tap 📋 Copy marks, then run PARS Fill again.'); return; }
      overlay('That isn’t phone marks — in the PARS Attendance app tap 📋 Copy marks, then tap this bookmark again.', true); return;
    }
    var entry = C.matchBundleEntry(bundle, live.meta.label, live.meetingDate);
    if (!entry) {
      if (IN_SHORTCUT) { finish('The copied marks (' + bundle.length + ' class(es)) don’t include “' + live.meta.label + '” for this week — check the class + week PARS is showing, re-copy, and run again.'); return; }
      overlay('The copied marks (' + bundle.length + ' class(es)) don’t include “' + live.meta.label + '” for this week — check the class + week PARS is showing.', true); return;
    }
    var marks = {};
    (entry.marks || []).forEach(function (m) { if (m && m.iin != null) marks[m.iin] = { minutes: m.minutes }; });
    var r = C.applyFill(document, C.buildFillPlan(live, marks));
    finish('Filled ' + r.written + ' student(s) into “' + live.meta.label + '”' + (r.skipped ? ' (' + r.skipped + ' skipped — roster changed?)' : '') + '. REVIEW the values, then tap PARS’s own Save / Certify. Nothing was submitted automatically.');
  }

  /** Clipboard reads need a USER GESTURE on iOS — a Shortcut run isn't one, but a tap on a
   *  page button is. So when the direct read is refused, show a big button; its click handler
   *  retries readText inside the gesture (iOS then shows its normal "Allow Paste" bubble), with
   *  the manual paste box as the fallback of last resort. Requires page-world listeners — the
   *  Shortcuts stub injects this file as an inline <script> for exactly that reason. */
  function promptForMarks() {
    overlay('Marks copied in the PARS Attendance app? Tap the button — iOS will ask to allow the paste.', true);
    var box = document.getElementById(BOX_ID);
    var read = document.createElement('button');
    read.textContent = '📥 Read marks from clipboard & fill';
    read.style.cssText = 'margin-top:14px;width:100%;padding:18px;border-radius:14px;border:0;background:#30d158;color:#000;font-size:32px;font-weight:600';
    read.addEventListener('click', function () {
      navigator.clipboard.readText().then(fillFrom, function () {
        overlay('iOS declined the clipboard read — paste the marks manually below:', true);
      });
    });
    box.insertBefore(read, box.children[1]); // right under the message, above the paste box
  }

  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(fillFrom, function () { promptForMarks(); });
  } else {
    overlay('Paste the marks from the PARS Attendance app:', true);
  }
  if (IN_SHORTCUT) { try { completion('PARS Fill loaded — use the panel on the page.'); } catch (_) {} }
})();

})();
