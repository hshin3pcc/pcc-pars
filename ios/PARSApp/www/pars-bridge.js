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
   *  Returns { rolled:[{key,label,fromDate,filed}], stuck:[{key,label,weekDate}] } — `filed` is true when the
   *  roll was justified by a PARS fill receipt (iOS app) rather than by the week being all-present. */
  function planAutoRoll(entries, todayYmd) {
    const rolled = [], stuck = [];
    Object.keys(entries || {}).forEach((k) => {
      const e = entries[k];
      if (!e || !e.roster || e.roster.dayOfWeek == null || !e.weekDate) return;   // malformed → skip, never crash
      const full = e.roster.scheduledMinutes || 195;
      const curWeek = weekdayInWeekOf(e.roster.dayOfWeek, todayYmd);
      if (!(e.weekDate < curWeek)) return;                                        // current/future week: left alone
      // iOS app: a fill receipt for THIS exact week (e.filedWeek === e.weekDate) means the marks are in PARS,
      // so the week may roll even though it holds absences/partials. Without a receipt the old rule stands.
      const filed = (!!e.filedWeek && e.filedWeek === e.weekDate) || !!(e.filed && e.filed[e.weekDate]);
      if (!filed && hasNonFullMarks(e.roster.students, e.minutes, full)) stuck.push({ key: k, label: e.roster.label, weekDate: e.weekDate });
      else rolled.push({ key: k, label: e.roster.label, fromDate: e.weekDate, filed });
    });
    return { rolled, stuck };
  }

  /** Week history (Phase 2.3): a class entry keeps EVERY week it has shown, `weeks: { [ymd]: minutes }`,
   *  plus `filed: { [ymd]: true }` receipts. Past weeks that still hold an absence/partial and were never
   *  marked filed are the ones worth a reminder — sorted oldest first. The week on screen counts only when
   *  it is itself in the past. Pure; never throws on a malformed entry. */
  function unfiledPastWeeks(e, todayYmd) {
    if (!e || !e.roster || e.roster.dayOfWeek == null || !e.weeks || typeof e.weeks !== 'object') return [];
    const full = e.roster.scheduledMinutes || 195;
    const curWeek = weekdayInWeekOf(e.roster.dayOfWeek, todayYmd);
    return Object.keys(e.weeks).filter((d) => d < curWeek && !(e.filed && e.filed[d]) && !(e.filedWeek === d)
      && hasNonFullMarks(e.roster.students, e.weeks[d], full)).sort();
  }
  /** Marks-bundle entries for EVERY stored week of every class (oldest first), so one paste on the Mac
   *  (or one Shortcut run) can fill any week PARS is showing — including a past week being corrected.
   *  Entries without a `weeks` map fall back to the single week on screen. Students missing a mark export
   *  as full. */
  function bundleEntriesFromClasses(classes) {
    const out = [];
    Object.keys(classes || {}).forEach((k) => {
      const c = classes[k];
      if (!c || !c.roster || !Array.isArray(c.roster.students)) return;
      const full = c.roster.scheduledMinutes || 195;
      const weeks = (c.weeks && typeof c.weeks === 'object' && Object.keys(c.weeks).length) ? c.weeks : (c.weekDate ? { [c.weekDate]: c.minutes || {} } : {});
      Object.keys(weeks).sort().forEach((d) => {
        const m = weeks[d] || {};
        out.push({ label: c.roster.label, meetingDate: d, marks: c.roster.students.filter((s) => s && s.iin != null).map((s) => ({ iin: s.iin, minutes: m[s.iin] != null ? m[s.iin] : full })) });
      });
    });
    return out;
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

  // ---- Chef bridge (Phase 3): chef (the orchestra app, pccorch.onrender.com) records attendance
  // at rehearsal; its /api/runner/pars feed returns per-student MINUTES PRESENT for a date
  // (present = full session, late = full − minutes missed, excused/absent = 0). These helpers turn
  // that feed into the same minutes-grid marks the phone path uses — review + Fill + Save stay
  // exactly the human steps they always were. ----

  /** Normalize a student ID for matching: digits only, leading zeros dropped (older PARS IINs
   *  carry leading 00s that chef's Notion-era data sometimes lacks, and vice versa). */
  function normIin(v) { return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, ''); }

  /**
   * Map chef PARS rows ({pcc_id, pars_minutes, full_name}) onto the on-screen roster. Matching is
   * by normalized ID, FAIL CLOSED both ways: chef rows with no matching student are reported (never
   * guessed onto someone), and students with no chef row are left untouched (they keep whatever the
   * grid already shows). Minutes are clamped to [0, fullMin].
   * Returns { minutes: {iin: min}, matched, unmatchedChef: [names] }.
   */
  function chefMarksToMinutes(rows, students, fullMin) {
    const byNorm = {};
    (students || []).forEach((s) => { const n = normIin(s.iin); if (n) byNorm[n] = s.iin; });
    const minutes = {};
    const unmatchedChef = [];
    (rows || []).forEach((r) => {
      const n = normIin(r && r.pcc_id);
      const iin = n && byNorm[n];
      if (!iin) { unmatchedChef.push((r && r.full_name) || 'unknown'); return; }
      let m = Math.max(0, Math.round(Number(r && r.pars_minutes) || 0));
      if (fullMin != null) m = Math.min(fullMin, m);
      minutes[iin] = m;
    });
    return { minutes, matched: Object.keys(minutes).length, unmatchedChef };
  }

  return { round1, minutesToHours, dayOfWeekOf, weekdayInWeekOf, shiftWeeks, ymdFromDate, hasNonFullMarks, planAutoRoll, unfiledPastWeeks, bundleEntriesFromClasses, reconcileMinutes, parseMeta, editableInput, editableInputs, meetingDateOf, parseRoster, buildFillPlan, applyFill, toRosterBlob, encodeRoster, decodeRoster, encodeBundle, decodeBundle, encodeMarks, decodeMarks, encodeMarksBundle, decodeMarksBundle, matchBundleEntry, normIin, chefMarksToMinutes };
});

'use strict';

/*
 * pcc-pars iOS bridge — runs INSIDE the PARS page in the app's embedded PARS web view. `npm run
 * build-ios` composes it with src/core.js into ios/PARSApp/www/pars-bridge.js, which the native shell
 * injects at document-end on every page of the PARS web view (the host guard below keeps it inert on
 * the Microsoft SSO pages). It is the phone-side twin of the extension's content script, cut down to
 * the two things the app needs from PARS:
 *
 *   1. ROSTER OUT — whenever PARS shows a fillable roster, post it to the app so the Attendance tab's
 *      rosters stay current by themselves (no "Load roster" step; add/drops are picked up the next time
 *      the class is on screen).
 *   2. MARKS IN  — the app hands over the marks bundle (every class). When the class + open week on
 *      screen matches an entry, a bottom bar offers ONE tap: Fill. Then Henry taps PARS's own
 *      "Save now" / "Certify week" — the bridge never saves or certifies.
 *
 * Matching is the tested fail-closed core (label + meeting date); the fill is core.applyFill (writes
 * "/<minutes>", self-verifies each row's IIN). The bar is sized for PARS's desktop layout, which iOS
 * renders at ~980px and scales down — 30px type reads as normal on the phone.
 *
 * Exports the pure `bridgeState` for tests; everything with a DOM lives in `start`.
 */
(function (root, factory) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const C = isNode ? require('./core') : root.PARSCore;
  const api = factory(C);
  if (isNode) module.exports = api;
  else if (root && root.document) api.start(root);
})(typeof window !== 'undefined' ? window : this, function (C) {
  const PARS_HOST = 'csweb-pub.pasadena.edu';

  /** Pure decision: what the bar shows for the live roster + the marks bundle the app sent.
   *  { kind: 'noroster' | 'multi' | 'nolength' | 'nomatch' | 'done' | 'ready', ... } */
  function bridgeState(live, bundle) {
    const entries = Array.isArray(bundle) ? bundle : [];
    const pending = entries.filter((e) => e && Array.isArray(e.marks) && e.marks.length).map((e) => ({ label: e.label, meetingDate: e.meetingDate }));
    if (!live || !live.students || !live.students.length) return { kind: 'noroster', pending };
    const label = live.meta.label, date = live.meetingDate;
    if (live.meta.multiMeeting) return { kind: 'multi', label, date, pending };
    if (!live.meta.scheduledMinutes) return { kind: 'nolength', label, date, pending };
    const entry = C.matchBundleEntry(entries, label, date);
    if (!entry) return { kind: 'nomatch', label, date, pending };
    if (!entry.marks || !entry.marks.length) return { kind: 'done', label, date, filledAt: entry.filledAt || null, pending };
    const full = live.meta.scheduledMinutes;
    let absent = 0, partial = 0;
    entry.marks.forEach((m) => { const n = Number(m && m.minutes); if (!(n > 0)) absent++; else if (n < full) partial++; });
    return { kind: 'ready', label, date, entry, total: entry.marks.length, absent, partial, pending };
  }

  function fmtDate(d) { return (d && d.length === 8) ? `${+d.slice(4, 6)}/${+d.slice(6, 8)}` : (d || ''); }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function pendingNote(st) {
    const others = (st.pending || []).filter((p) => !(p.label === st.label && p.meetingDate === st.date));
    return others.length ? ` Waiting: ${others.map((p) => `${p.label} ${fmtDate(p.meetingDate)}`).join(', ')}.` : '';
  }

  /** Bar copy per state. Pure so the wording is testable. */
  function barText(st, lastFill) {
    switch (st.kind) {
      case 'noroster': return { tone: 'muted', text: 'Pick a class and an open (uncertified) week.' + pendingNote(st) };
      case 'multi': return { tone: 'warn', text: `${st.label} meets more than one day this week — enter it directly in PARS.` };
      case 'nolength': return { tone: 'warn', text: `Couldn’t read the class length for ${st.label} — enter this week directly in PARS.` };
      case 'nomatch': return { tone: 'muted', text: `Roster saved to the app. No marks for ${st.label} ${fmtDate(st.date)}.` + pendingNote(st) };
      case 'done': {
        const n = lastFill && lastFill.label === st.label && lastFill.date === st.date ? lastFill : null;
        return { tone: 'ok', text: n
          ? `Filled ${n.written} into ${st.label} ${fmtDate(st.date)}${n.skipped ? ` (${n.skipped} skipped)` : ''}. Review, then tap PARS’s Save now / Certify week.` + pendingNote(st)
          : `${st.label} ${fmtDate(st.date)} was already filled${st.filledAt ? ` on ${fmtDate(st.filledAt)}` : ''}. Push again from the app to refill.` + pendingNote(st) };
      }
      case 'ready': return { tone: 'ready', text: `${st.label} ${fmtDate(st.date)}: ${st.total} students · ${st.absent} absent · ${st.partial} partial`, button: 'Fill PARS' };
      default: return { tone: 'muted', text: '' };
    }
  }

  function start(win) {
    const doc = win.document;
    if (win.location.host !== PARS_HOST && win.location.protocol !== 'file:') return;   // inert on SSO pages
    if (win.__parsBridgeStarted) return;
    win.__parsBridgeStarted = true;
    const post = (msg) => { try { win.webkit.messageHandlers.pars.postMessage(msg); } catch (_) { /* not in the app */ } };

    let bundle = [];
    let lastRosterKey = null;
    let lastFill = null;
    let bar = null, textEl = null, btn = null, current = null;

    function ensureBar() {
      if (bar && doc.body.contains(bar)) return;
      const style = doc.createElement('style');
      style.textContent =
        '#parsbridge{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;gap:24px;' +
        'padding:26px 30px calc(26px + env(safe-area-inset-bottom));font:30px/1.3 -apple-system,sans-serif;color:#fff;' +
        'background:#1c1c1e;box-shadow:0 -6px 32px rgba(0,0,0,.35)}' +
        '#parsbridge.ready{background:#0b3d25}#parsbridge.ok{background:#16653e}#parsbridge.warn{background:#7a3b00}' +
        '#parsbridge .pb-text{flex:1;min-width:0}' +
        '#parsbridge button{flex:0 0 auto;border:0;border-radius:18px;padding:22px 34px;font:600 32px -apple-system,sans-serif;' +
        'background:#30d158;color:#000}#parsbridge button:disabled{opacity:.5}' +
        'body{padding-bottom:160px}';
      (doc.head || doc.documentElement).appendChild(style);
      bar = doc.createElement('div'); bar.id = 'parsbridge';
      textEl = doc.createElement('div'); textEl.className = 'pb-text';
      btn = doc.createElement('button'); btn.type = 'button'; btn.style.display = 'none';
      btn.addEventListener('click', () => { if (current && current.kind === 'ready') fill(current); });
      bar.appendChild(textEl); bar.appendChild(btn);
      doc.body.appendChild(bar);
    }

    function render(st) {
      ensureBar();
      current = st;
      const t = barText(st, lastFill);
      bar.className = t.tone;
      if (textEl.textContent !== t.text) textEl.textContent = t.text;
      if (t.button) { btn.textContent = t.button; btn.style.display = ''; } else btn.style.display = 'none';
    }

    function evaluate() {
      const live = C.parseRoster(doc);
      const st = bridgeState(live, bundle);
      if (st.kind !== 'noroster' && st.kind !== 'multi' && st.kind !== 'nolength') {
        // Roster OUT — only a fillable roster, and only when it actually changed (not on every mutation).
        const blob = C.toRosterBlob(live);
        const key = JSON.stringify([blob.label, blob.meetingDate, blob.scheduledMinutes, blob.unit, blob.students.map((s) => [s.iin, s.name])]);
        if (key !== lastRosterKey) { lastRosterKey = key; post({ type: 'roster', roster: blob }); }
      }
      render(st);
    }

    function fill(st) {
      // Re-scan the LIVE page and refuse a stale state (the class/week changed under the bar).
      const live = C.parseRoster(doc);
      if (live.meetingDate !== st.date || live.meta.label !== st.label || !live.students.length) { evaluate(); return; }
      const marks = {};
      (st.entry.marks || []).forEach((m) => { if (m && m.iin != null) marks[m.iin] = { minutes: m.minutes }; });
      const r = C.applyFill(doc, C.buildFillPlan(live, marks));
      st.entry.marks = []; st.entry.filledAt = C.ymdFromDate(new Date());   // no IINs at rest once filled
      lastFill = { label: st.label, date: st.date, written: r.written, skipped: r.skipped };
      post({ type: 'filled', label: st.label, meetingDate: st.date, written: r.written, skipped: r.skipped });
      evaluate();
    }

    win.PARSBridge = {
      setMarks(entries) { bundle = Array.isArray(entries) ? entries : []; evaluate(); },
      refresh: evaluate,
    };

    // PARS is a client-side form: the roster changes without a navigation, so watch the DOM (debounced,
    // ignoring our own bar so it can't feed back into itself).
    let timer = null;
    const kick = (records) => {
      if (records && records.every((m) => bar && (m.target === bar || bar.contains(m.target)))) return;
      win.clearTimeout(timer); timer = win.setTimeout(evaluate, 250);
    };
    new win.MutationObserver(kick).observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'readonly'] });

    post({ type: 'ready' });   // the app answers with PARSBridge.setMarks(bundle)
    evaluate();
  }

  return { bridgeState, barText, start };
});

})();
