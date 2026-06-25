'use strict';

/*
 * PARS Attendance PWA (Phase 2.2) — load your rosters ONCE; the app tracks the week itself.
 * Classes are keyed by class (the roster is stable all term); each carries the week it's recording for.
 *
 * NEVER silently loses attendance: a past week is auto-rolled to the current week ONLY if it has no marks
 * (nothing to lose). A past week that has any absence/partial is LEFT ALONE and flagged in the banner —
 * you file it in PARS or explicitly roll forward (with a confirm). Step weeks with ◀ ▶; "📅 This week"
 * rolls past weeks forward. Re-load only when a student adds/drops — re-loading keeps your marks.
 * Fully offline + local; Copy marks hands everything back via Universal Clipboard. Nothing leaves the device.
 */
(function () {
  const C = window.PARSCore;
  const LS = 'pars.v2';
  // classes: { [label]: { roster:{label,scheduledMinutes,unit,dayOfWeek,students}, weekDate, minutes } }
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

  function save() {
    try { localStorage.setItem(LS, JSON.stringify({ classes, current })); saveOk = true; }
    catch (_) { saveOk = false; status('⚠️ Couldn’t save on this device — Copy marks to PARS before closing the app.'); }
  }
  function restore() {
    try { const o = JSON.parse(localStorage.getItem(LS) || '{}'); classes = (o && o.classes && typeof o.classes === 'object' && !Array.isArray(o.classes)) ? o.classes : {}; current = (o && o.current) || null; }
    catch (_) { classes = {}; current = null; }
    Object.keys(classes).forEach((k) => { const e = classes[k]; if (!e || !e.roster || !Array.isArray(e.roster.students) || e.roster.dayOfWeek == null || !e.weekDate) delete classes[k]; });
    if (!current || !classes[current]) current = Object.keys(classes)[0] || null;
  }
  function freshMinutes(e) { const m = {}; e.roster.students.forEach((s) => { m[s.iin] = fullMin(e); }); return m; }
  function roll(e) { e.weekDate = thisWeekDate(e); e.minutes = freshMinutes(e); }

  /** On open: auto-roll a past week ONLY when it has no marks (nothing to lose). Leave a past week that
   *  holds absences/partials and flag it — never silently discard captured attendance. */
  function autoRollOnOpen() {
    const stuck = [];
    Object.keys(classes).forEach((k) => {
      const e = classes[k];
      if (!isStale(e)) return;
      if (!hasMarks(e)) roll(e);
      else stuck.push(e.roster.label);
    });
    bannerMsg = stuck.length ? `Un-filed attendance from a past week: ${stuck.join(', ')}. File it in PARS, or tap 📅 This week to start fresh.` : '';
    save();
  }

  function addRoster(r) {
    if (!r || !Array.isArray(r.students)) return { skipped: 'invalid' };
    if (r.multiMeeting) return { skipped: `${r.label || 'a class'}: meets multiple days this week` };
    if (!r.scheduledMinutes) return { skipped: `${r.label || 'a class'}: class length unreadable` };
    const students = r.students.filter((s) => s && s.iin != null);
    const roster = { label: r.label, scheduledMinutes: r.scheduledMinutes, unit: r.unit, dayOfWeek: C.dayOfWeekOf(r.meetingDate), students };
    const k = roster.label;
    if (classes[k]) {   // re-load (add/drop): keep the week, reconcile marks so continuing students keep theirs
      classes[k] = { roster, weekDate: classes[k].weekDate || r.meetingDate, minutes: C.reconcileMinutes(classes[k].minutes, students, roster.scheduledMinutes) };
    } else {
      classes[k] = { roster, weekDate: r.meetingDate, minutes: {} };
      classes[k].minutes = freshMinutes(classes[k]);
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
  function allPresent() { const e = cur(); if (!e) return; e.minutes = freshMinutes(e); save(); render(); }
  function stepWeek(n) {
    const e = cur(); if (!e) return;
    if (hasMarks(e) && !confirm('Move to a different week? The current marks will be cleared — make sure they’re filed in PARS first.')) return;
    e.weekDate = C.shiftWeeks(e.weekDate, n); e.minutes = freshMinutes(e); bannerMsg = ''; save(); render();
  }
  function rollAll() {   // roll only PAST weeks forward; leave the current week alone
    const stale = Object.keys(classes).map((k) => classes[k]).filter(isStale);
    if (!stale.length) { status('All classes are already on the current week.'); return; }
    if (stale.some(hasMarks) && !confirm('Roll past weeks to this week? Any un-filed marks in those weeks will be cleared — file them in PARS first if needed.')) return;
    stale.forEach(roll); bannerMsg = ''; save(); render();
  }

  function render() {
    const list = $('list'), sel = $('classsel'), wb = $('weekbar'), bn = $('banner');
    const keys = Object.keys(classes);
    bn.hidden = !bannerMsg; bn.textContent = bannerMsg;
    if (!keys.length || !cur()) {
      sel.hidden = true; wb.hidden = true; $('sub').textContent = 'No roster loaded'; $('tools').hidden = true; $('foot').hidden = true;
      list.innerHTML = '<div class="empty">Tap <b>⬇︎ Load roster</b> above.<br><br>On your Mac, in the helper, <b>➕ Add</b> each class then <b>📤 Copy bundle</b>, and paste it here — all your classes load at once. You only do this once (re-load when a student adds/drops).</div>';
      return;
    }
    sel.hidden = false; wb.hidden = false; $('tools').hidden = false; $('foot').hidden = false;
    sel.innerHTML = keys.map((k) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(classes[k].roster.label || k)}</option>`).join('');
    const e = cur();
    $('weeklabel').textContent = `${DOW[e.roster.dayOfWeek]} ${fmtDate(e.weekDate)}` + (isStale(e) ? ' (past)' : '');
    $('sub').textContent = `${e.roster.students.length} students` + (keys.length > 1 ? ` · ${keys.length} classes` : '');
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

  function copyMarks() {
    const entries = Object.keys(classes).map((k) => {
      const c = classes[k];
      return { label: c.roster.label, meetingDate: c.weekDate, marks: c.roster.students.map((s) => ({ iin: s.iin, minutes: c.minutes[s.iin] != null ? c.minutes[s.iin] : fullMin(c) })) };
    });
    const blob = C.encodeMarksBundle(entries);
    const done = () => status(`Copied ${entries.length} class(es). On your Mac: select a class in PARS → helper 📥 Paste marks → Fill. Repeat per class. (Marks stay here until you roll the week forward.)`);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(blob).then(done, () => showFallback(blob));
    else showFallback(blob);
  }
  function showFallback(blob) { const ta = $('marksout'); ta.hidden = false; ta.value = blob; ta.focus(); ta.select(); status('Couldn’t auto-copy — tap the box, Select All, Copy.'); }
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
  $('copymarks').addEventListener('click', copyMarks);
  $('clearbtn').addEventListener('click', clearAll);

  // load state safely — a corrupt blob can never brick the app
  try { restore(); autoRollOnOpen(); render(); } catch (_) { classes = {}; current = null; bannerMsg = ''; render(); }
})();
