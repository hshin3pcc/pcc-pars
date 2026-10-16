'use strict';

/*
 * PARS Attendance PWA (Phase 2.2) — load your rosters ONCE; the app tracks the week itself.
 * Classes are keyed by class (the roster is stable all term); each carries the week it's recording for.
 *
 * NEVER silently loses attendance: a past week is auto-rolled to the current week ONLY if it has no marks
 * (nothing to lose) — and every auto-rolled week is NAMED in the banner (the app can't know whether an
 * all-present week was actually FILED in PARS, so the banner is the guardrail). A past week that has any
 * absence/partial is LEFT ALONE and flagged — you file it in PARS or explicitly roll forward (with a
 * confirm). Step weeks with ◀ ▶; "📅 This week" rolls past weeks forward. Re-load only when a student
 * adds/drops — re-loading keeps your marks.
 * Phase 2.3 — WEEK HISTORY: every week a class has shown stays on the phone (`weeks[ymd]`), so stepping
 * ◀ ▶ never clears anything, auto-roll never discards, and a past week can be revisited and re-filed.
 * Copy/Share exports EVERY stored week (the Mac helper + Shortcut match by class + date, fail closed).
 * Fully offline + local; Copy marks hands everything back via Universal Clipboard, 📡 Share via AirDrop
 * (or Messages/Mail) when Universal Clipboard won't cooperate. Nothing leaves the device otherwise.
 */
(function () {
  const C = window.PARSCore;
  const LS = 'pars.v2';
  // iOS app mode (Phase 4): the native shell hosts this page next to an embedded, signed-in PARS view and
  // relays messages between them. In the app, rosters arrive from PARS by themselves (no Load step), marks
  // go over as "Push to PARS" (no clipboard), PARS answers with a fill receipt, and the shell persists our
  // state (localStorage on a file:// view isn't trustworthy). Outside the app nothing changes.
  const APP = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pars);
  const native = (msg) => { if (APP) { try { window.webkit.messageHandlers.pars.postMessage(msg); } catch (_) {} } };
  // classes: { [label]: { roster:{label,scheduledMinutes,unit,dayOfWeek,students}, weekDate, minutes,
  //                        weeks:{ [ymd]: minutes }, filed:{ [ymd]: true } } }
  // INVARIANT: minutes === weeks[weekDate] (same object) — `minutes` stays for older readers of pars.v2.
  let classes = {};
  let current = null;
  let saveOk = true, bannerMsg = '';
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const $ = (id) => document.getElementById(id);
  const todayYmd = () => C.ymdFromDate(new Date());
  const cur = () => (current && classes[current]) || null;
  const fullMin = (e) => (e ? e.roster.scheduledMinutes : 195) || 195;
  const unit = (e) => (e ? e.roster.unit : 50) || 50;
  const hoursOf = (e, m) => C.minutesToHours(m, unit(e));
  const fmtDate = (d) => (d && d.length === 8) ? `${+d.slice(4, 6)}/${+d.slice(6, 8)}` : (d || '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const thisWeekDate = (e) => C.weekdayInWeekOf(e.roster.dayOfWeek, todayYmd());
  const isStale = (e) => e.weekDate < thisWeekDate(e);
  const hasMarks = (e) => C.hasNonFullMarks(e.roster.students, e.minutes, fullMin(e));
  const isFiled = (e) => !!(e.filed && e.filed[e.weekDate]);   // filed in PARS (receipt from the app, or ✓ tapped by hand)

  function save() {
    const state = { classes, current };
    if (APP) native({ type: 'save', state });   // the shell writes it to disk and re-injects it on next launch
    try { localStorage.setItem(LS, JSON.stringify(state)); saveOk = true; }
    catch (_) { saveOk = APP; if (!APP) status('⚠️ Couldn’t save on this device — Copy marks to PARS before closing the app.'); }
  }
  function restore() {
    try {
      const injected = (APP && window.__PARS_STATE__ && typeof window.__PARS_STATE__ === 'object') ? window.__PARS_STATE__ : null;
      const o = injected || JSON.parse(localStorage.getItem(LS) || '{}');
      classes = (o && o.classes && typeof o.classes === 'object' && !Array.isArray(o.classes)) ? o.classes : {}; current = (o && o.current) || null;
    }
    catch (_) { classes = {}; current = null; }
    Object.keys(classes).forEach((k) => { const e = classes[k]; if (!e || !e.roster || !Array.isArray(e.roster.students) || e.roster.dayOfWeek == null || !e.weekDate) delete classes[k]; else migrate(e); });
    if (!current || !classes[current]) current = Object.keys(classes)[0] || null;
  }
  /** Same key (pars.v2), additive shape: a pre-history entry has only { weekDate, minutes } — fold it into
   *  weeks[] so nothing is lost on upgrade, and re-link `minutes` to the showing week after JSON round-trip. */
  function migrate(e) {
    if (!e.weeks || typeof e.weeks !== 'object' || Array.isArray(e.weeks)) e.weeks = {};
    if (!e.filed || typeof e.filed !== 'object' || Array.isArray(e.filed)) e.filed = {};
    if (e.filedWeek) { e.filed[e.filedWeek] = true; delete e.filedWeek; }
    if (!e.weeks[e.weekDate]) e.weeks[e.weekDate] = (e.minutes && typeof e.minutes === 'object') ? e.minutes : freshMinutes(e);
    e.minutes = e.weeks[e.weekDate];
  }
  function freshMinutes(e) { const m = {}; e.roster.students.forEach((s) => { m[s.iin] = fullMin(e); }); return m; }
  /** Show a week: its marks come from history, or start all-present. Never discards another week. */
  function showWeek(e, ymd) { e.weekDate = ymd; if (!e.weeks[ymd]) e.weeks[ymd] = freshMinutes(e); e.minutes = e.weeks[ymd]; }
  function setMinutes(e, m) { e.weeks[e.weekDate] = m; e.minutes = m; }
  function roll(e) { showWeek(e, thisWeekDate(e)); }

  /** On open: every class advances to the current week — with history nothing is lost by moving, so a
   *  past week never blocks today's capture. The banner still NAMES what needs attention: past weeks
   *  holding absences/partials that were never marked filed (tap ◀ to revisit), and all-present weeks
   *  just advanced past without a receipt (core.planAutoRoll — the app can't know they were filed). */
  function autoRollOnOpen() {
    const today = todayYmd();
    const plan = C.planAutoRoll(classes, today);
    plan.rolled.concat(plan.stuck).forEach((r) => roll(classes[r.key]));
    bannerMsg = reminders(plan.rolled.filter((r) => !r.filed), today);
    save();
  }
  function reminders(unsure, today) {
    const parts = [];
    const open = [];
    Object.keys(classes).forEach((k) => { const e = classes[k]; C.unfiledPastWeeks(e, today).forEach((d) => open.push(`${e.roster.label} ${fmtDate(d)}`)); });
    if (open.length) parts.push(`Past weeks with absences not yet marked filed in PARS: ${open.slice(0, 4).join(', ')}${open.length > 4 ? ` and ${open.length - 4} more` : ''}. Tap ◀ to revisit; tap ☐ Filed once they’re in PARS.`);
    if (unsure && unsure.length) parts.push(`Advanced to this week: ${unsure.map((r) => `${r.label} (was ${fmtDate(r.fromDate)})`).join(', ')} — those weeks were all-present; if one was never filed in PARS, tap ◀ to go back and file it.`);
    return parts.join('  ');
  }

  function addRoster(r) {
    if (!r || !Array.isArray(r.students)) return { skipped: 'invalid' };
    if (r.multiMeeting) return { skipped: `${r.label || 'a class'}: meets multiple days this week` };
    if (!r.scheduledMinutes) return { skipped: `${r.label || 'a class'}: class length unreadable` };
    const students = r.students.filter((s) => s && s.iin != null);
    const roster = { label: r.label, scheduledMinutes: r.scheduledMinutes, unit: r.unit, dayOfWeek: C.dayOfWeekOf(r.meetingDate), students };
    const k = roster.label;
    if (classes[k]) {   // re-load (add/drop): keep every week, reconcile marks so continuing students keep theirs
      const old = classes[k], weeks = {};
      Object.keys(old.weeks || {}).forEach((d) => { weeks[d] = C.reconcileMinutes(old.weeks[d], students, roster.scheduledMinutes); });
      classes[k] = { roster, weekDate: old.weekDate || r.meetingDate, minutes: {}, weeks, filed: old.filed || {} };
      showWeek(classes[k], classes[k].weekDate);
    } else {
      classes[k] = { roster, weekDate: r.meetingDate, minutes: {}, weeks: {}, filed: {} };
      showWeek(classes[k], r.meetingDate);
    }
    return { key: k };
  }
  function loadRoster(text) {
    const bundle = C.decodeBundle(text);
    const list = bundle || (C.decodeRoster(text) ? [C.decodeRoster(text)] : null);
    if (!list) return { ok: false };
    let added = 0; const skipped = []; let firstKey = null;
    list.forEach((r) => { const res = addRoster(r); if (res.key) { added++; if (!firstKey) firstKey = res.key; } else if (res.skipped) skipped.push(res.skipped); });
    if (!added) return { ok: false, err: skipped[0] || 'No usable classes in that paste.' };
    if (!current || !classes[current]) current = firstKey;
    save(); render();
    return { ok: true, added, skipped };
  }

  function setMin(iin, v) {
    const e = cur(); if (!e) return;
    if (v === '' || v == null || (typeof v === 'string' && !v.trim())) return;   // blank = no change
    const m = Math.round(Number(v));
    if (!Number.isFinite(m)) return;
    e.minutes[iin] = Math.max(0, Math.min(fullMin(e), m)); save();
  }
  function allPresent() {
    const e = cur(); if (!e) return;
    if (hasMarks(e) && !confirm('Set everyone to full? The absences/partials you’ve marked for this week will be overwritten.')) return;
    setMinutes(e, freshMinutes(e)); save(); render();
  }
  function stepWeek(n) {   // just a different page of history — nothing is cleared
    const e = cur(); if (!e) return;
    showWeek(e, C.shiftWeeks(e.weekDate, n)); bannerMsg = ''; save(); render();
  }
  function rollAll() {   // bring every class to the current week; past weeks stay in history
    const stale = Object.keys(classes).map((k) => classes[k]).filter(isStale);
    if (!stale.length) { status('All classes are already on the current week.'); return; }
    stale.forEach(roll); bannerMsg = ''; save(); render();
  }
  function toggleFiled() {   // hand receipt: "this week is in PARS" (the Mac path has no automatic one)
    const e = cur(); if (!e) return;
    if (e.filed[e.weekDate]) delete e.filed[e.weekDate]; else e.filed[e.weekDate] = true;
    bannerMsg = ''; save(); render();
  }

  function render() {
    const list = $('list'), sel = $('classsel'), wb = $('weekbar'), bn = $('banner');
    const keys = Object.keys(classes);
    bn.hidden = !bannerMsg; bn.textContent = bannerMsg;
    if (!keys.length || !cur()) {
      sel.hidden = true; wb.hidden = true; $('sub').textContent = 'No roster loaded'; $('tools').hidden = true; $('foot').hidden = true;
      list.innerHTML = APP
        ? '<div class="empty">No classes yet.<br><br>Open the <b>PARS</b> tab, sign in, and view each class once (any open week) — its roster lands here by itself. Rosters refresh the same way whenever a student adds or drops.</div>'
        : '<div class="empty">Tap <b>⬇︎ Load roster</b> above.<br><br>On your Mac, in the helper, <b>➕ Add</b> each class then <b>📤 Copy bundle</b>, and paste it here — all your classes load at once. You only do this once (re-load when a student adds/drops).</div>';
      return;
    }
    sel.hidden = false; wb.hidden = false; $('tools').hidden = false; $('foot').hidden = false;
    sel.innerHTML = keys.map((k) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(classes[k].roster.label || k)}</option>`).join('');
    const e = cur();
    $('weeklabel').textContent = `${DOW[e.roster.dayOfWeek]} ${fmtDate(e.weekDate)}` + (isFiled(e) ? ' ✓ filed' : isStale(e) ? ' (past)' : '');
    const nWeeks = Object.keys(e.weeks).length;
    $('sub').textContent = `${e.roster.students.length} students` + (keys.length > 1 ? ` · ${keys.length} classes` : '') + (nWeeks > 1 ? ` · ${nWeeks} weeks stored` : '');
    $('markfiled').textContent = isFiled(e) ? '✓ Filed in PARS' : '☐ Filed';
    $('markfiled').classList.toggle('on', isFiled(e));
    list.innerHTML = '';
    e.roster.students.forEach((s) => list.appendChild(card(e, s)));
    if (!saveOk) status('⚠️ Couldn’t save on this device — Copy marks to PARS before closing.');
  }

  function card(e, s) {
    const m = e.minutes[s.iin] != null ? e.minutes[s.iin] : fullMin(e);
    const present = m >= fullMin(e), absent = m <= 0;
    const el = document.createElement('div');
    el.className = 'card' + (absent ? ' absent' : present ? '' : ' partial');
    el.innerHTML =
      `<div class="name"><span>${esc(s.seq)}. ${esc(s.name)}</span><span class="hrs">${hoursOf(e, m)} h</span></div>` +
      '<div class="ctrls">' +
      `<button class="present${present ? ' on' : ''}">Present</button>` +
      `<button class="absent-btn${absent ? ' on' : ''}">Absent</button>` +
      `<div class="min"><label>min</label><input type="number" inputmode="numeric" min="0" max="${fullMin(e)}" value="${m}"></div>` +
      '</div>';
    el.querySelector('.present').addEventListener('click', () => { setMin(s.iin, fullMin(e)); render(); });
    el.querySelector('.absent-btn').addEventListener('click', () => { setMin(s.iin, 0); render(); });
    const inp = el.querySelector('input');
    inp.addEventListener('change', () => { setMin(s.iin, inp.value); render(); });
    return el;
  }

  // Every stored week of every class goes out (core.bundleEntriesFromClasses): the Mac helper and the
  // Shortcut pick the entry matching the class + week PARS is showing, so a past week can be re-filed.
  const summary = (entries) => `${Object.keys(classes).length} class(es), ${entries.length} week-entries`;
  function copyMarks() {
    const entries = C.bundleEntriesFromClasses(classes);
    if (APP) {   // no clipboard: hand the bundle to the shell, which opens the PARS tab with it
      native({ type: 'push', bundle: entries });
      status(`Sent ${summary(entries)} to the PARS tab — pick the class and open week there, tap Fill PARS, then Save now / Certify.`);
      return;
    }
    const blob = C.encodeMarksBundle(entries);
    const done = () => status(`Copied ${summary(entries)}. On your Mac: paste ONCE into the helper (📥 Paste marks from phone) — then for each class select it + the week in PARS and click 📥 Fill from phone marks. If the paste on the Mac isn’t these marks, use 📡 Share instead.`);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(blob).then(done, () => showFallback(blob));
    else showFallback(blob);
  }
  /** Clipboard-free hand-off: Web Share → AirDrop (or Messages/Mail) a small .txt to the Mac; the helper's
   *  📂 Open marks file reads it. Falls back to sharing plain text, then to the select-all box. */
  function shareMarks() {
    const entries = C.bundleEntriesFromClasses(classes);
    const blob = C.encodeMarksBundle(entries);
    if (!navigator.share) { showFallback(blob); return; }
    let data = { title: 'PARS marks', text: blob };
    try {
      const file = new File([blob], `pars-marks-${todayYmd()}.txt`, { type: 'text/plain' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) data = { title: 'PARS marks', files: [file] };
    } catch (_) {}
    navigator.share(data).then(
      () => status(`Shared ${summary(entries)}. On your Mac: AirDrop puts pars-marks-${todayYmd()}.txt in Downloads — in the helper click 📂 Open marks file, then per class select it + the week in PARS and click 📥 Fill from phone marks.`),
      (err) => { if (!(err && err.name === 'AbortError')) showFallback(blob); });
  }
  function showFallback(blob) { const ta = $('marksout'); ta.hidden = false; ta.value = blob; ta.focus(); ta.select(); status('Couldn’t auto-copy — tap the box, Select All, Copy (then paste into Messages/Mail to yourself if the Mac clipboard won’t pick it up).'); }
  function clearAll() {
    if (!confirm('Clear ALL classes + attendance from this phone? Do this only to start over (you’ll re-load rosters).')) return;
    classes = {}; current = null; saveOk = true; bannerMsg = '';
    try { localStorage.removeItem(LS); } catch (_) {}
    status(''); render();
  }
  function status(msg) { $('status').textContent = msg || ''; }

  // wire listeners FIRST (so the UI is usable even if persisted state is bad)
  $('loadbtn').addEventListener('click', () => { const b = $('loadbox'); b.hidden = !b.hidden; if (!b.hidden) $('rosterpaste').focus(); });
  $('rostercancel').addEventListener('click', () => { $('loadbox').hidden = true; $('loaderr').textContent = ''; });
  $('rosterload').addEventListener('click', () => {
    const r = loadRoster($('rosterpaste').value);
    if (r.ok) { $('loadbox').hidden = true; $('rosterpaste').value = ''; $('loaderr').textContent = ''; status(`Loaded ${r.added} class(es)${r.skipped && r.skipped.length ? ` · skipped: ${r.skipped.join('; ')}` : ''}.`); }
    else $('loaderr').textContent = r.err || 'That doesn’t look like a PARS roster/bundle. Re-copy it on your Mac and paste again.';
  });
  $('classsel').addEventListener('change', (ev) => { current = ev.target.value; save(); render(); });
  $('weekprev').addEventListener('click', () => stepWeek(-1));
  $('weeknext').addEventListener('click', () => stepWeek(1));
  $('thisweek').addEventListener('click', rollAll);
  $('allpresent').addEventListener('click', allPresent);
  $('markfiled').addEventListener('click', toggleFiled);
  $('copymarks').addEventListener('click', copyMarks);
  $('sharemarks').addEventListener('click', shareMarks);
  $('clearbtn').addEventListener('click', clearAll);

  if (APP) {   // in-app chrome: rosters come from the PARS tab, marks go to it
    $('loadbar').hidden = true;
    $('copymarks').textContent = '📤 Push to PARS';
    $('sharemarks').hidden = true;
  }

  // Entry points the native shell calls (relayed from the embedded PARS view).
  window.PARSApp = {
    /** PARS showed a fillable roster: add or refresh that class (marks survive, add/drops reconcile). A
     *  brand-new class starts on the CURRENT week, not whichever week PARS happened to be showing. */
    receiveRoster(blob) {
      try {
        const existed = !!(blob && classes[blob.label]);
        const res = addRoster(blob);
        if (!res.key) { if (res.skipped) status(`PARS roster not loaded — ${res.skipped}.`); return; }
        const e = classes[res.key];
        if (!existed) roll(e);
        if (!current || !classes[current]) current = res.key;
        save(); render();
        status(`${existed ? 'Refreshed' : 'Added'} ${e.roster.label} from PARS (${e.roster.students.length} students).`);
      } catch (_) { /* never let a bad relay brick the app */ }
    },
    /** PARS was filled for a class + week: record the receipt against that week in history. */
    markFiled(info) {
      try {
        const e = info && classes[info.label]; if (!e) return;
        if (!e.weeks[info.meetingDate]) { status(`PARS was filled for ${info.label} ${fmtDate(info.meetingDate)}, but this app has no marks for that week — nothing marked filed.`); return; }
        e.filed[info.meetingDate] = true; save(); render();
        status(`Filled ${info.label} ${fmtDate(info.meetingDate)} in PARS (${info.written} students). Tap Save now / Certify week in the PARS tab.`);
      } catch (_) {}
    },
  };

  // load state safely — a corrupt blob can never brick the app
  try { restore(); autoRollOnOpen(); render(); } catch (_) { classes = {}; current = null; bannerMsg = ''; render(); }
})();
