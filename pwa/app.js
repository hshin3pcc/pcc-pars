'use strict';

/*
 * PARS Attendance PWA (Phase 2.1) — phone capture for MULTIPLE classes at once. Paste the bundle the Mac
 * extension copied (all your classes) and switch between them with the dropdown — perfect for back-to-back
 * rehearsals where you can't return to the computer. Fully offline + local: state persists in localStorage,
 * and Copy marks hands everything back via Apple Universal Clipboard. NOTHING leaves your devices.
 */
(function () {
  const C = window.PARSCore;
  const LS = 'pars.classes', LS_CUR = 'pars.current';
  // classes: { [classKey]: { roster (flat blob), minutes: {iin->min} } } ; current = the selected classKey
  let classes = {};
  let current = null;
  let saveOk = true;

  const $ = (id) => document.getElementById(id);
  const keyOf = (r) => `${r.label || '?'}||${r.meetingDate || '?'}`;
  const cur = () => (current && classes[current]) || null;
  const fullMin = () => (cur() ? cur().roster.scheduledMinutes : 195) || 195;
  const unit = () => (cur() ? cur().roster.unit : 50) || 50;
  const hoursOf = (m) => C.minutesToHours(m, unit());
  const fmtDate = (d) => (d && d.length === 8) ? `${+d.slice(4, 6)}/${+d.slice(6, 8)}/${d.slice(0, 4)}` : (d || '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function save() {
    try { localStorage.setItem(LS, JSON.stringify(classes)); localStorage.setItem(LS_CUR, current || ''); saveOk = true; }
    catch (_) { saveOk = false; status('⚠️ Couldn’t save on this device — Copy marks to PARS before closing the app.'); }
  }
  function restore() {
    try { classes = JSON.parse(localStorage.getItem(LS) || '{}') || {}; current = localStorage.getItem(LS_CUR) || null; } catch (_) { classes = {}; current = null; }
    if (!current || !classes[current]) current = Object.keys(classes)[0] || null;
  }

  function addRoster(r) {
    if (!r || !Array.isArray(r.students)) return { skipped: 'invalid' };
    if (r.multiMeeting) return { skipped: `${r.label || 'a class'}: meets multiple days this week` };
    if (!r.scheduledMinutes) return { skipped: `${r.label || 'a class'}: class length unreadable` };
    r = Object.assign({}, r, { students: r.students.filter((s) => s && s.iin != null) });   // drop malformed students
    const k = keyOf(r);
    // Reconcile marks to THIS roster's students: keep a mark only for an IIN still present (genuine re-load),
    // default new IINs to full. This both preserves marks on a true re-load and prevents a same-key collision
    // from carrying another class's marks (foreign IINs are dropped).
    const old = (classes[k] && classes[k].minutes) || {};
    const m = {};
    r.students.forEach((s) => { m[s.iin] = (old[s.iin] != null) ? old[s.iin] : r.scheduledMinutes; });
    classes[k] = { roster: r, minutes: m };
    return { key: k };
  }

  /** Load a bundle (all classes) or a single roster blob; merge into the stored classes. */
  function loadRoster(text) {
    const bundle = C.decodeBundle(text);
    const list = bundle || (C.decodeRoster(text) ? [C.decodeRoster(text)] : null);
    if (!list) return { ok: false };
    let added = 0; const skipped = [];
    let firstKey = null;
    list.forEach((r) => { const res = addRoster(r); if (res.key) { added++; if (!firstKey) firstKey = res.key; } else if (res.skipped) skipped.push(res.skipped); });
    if (!added) return { ok: false, err: skipped[0] || 'No usable classes in that paste.' };
    if (!current || !classes[current]) current = firstKey;
    save(); render();
    return { ok: true, added, skipped };
  }

  function setMin(iin, v) {
    if (!cur()) return;
    if (v === '' || v == null || (typeof v === 'string' && !v.trim())) return;   // blank = no change
    const m = Math.round(Number(v));
    if (!Number.isFinite(m)) return;
    cur().minutes[iin] = Math.max(0, Math.min(fullMin(), m));
    save();
  }
  function allPresent() { if (!cur()) return; cur().roster.students.forEach((s) => { cur().minutes[s.iin] = fullMin(); }); save(); render(); }

  function render() {
    const list = $('list'), sel = $('classsel');
    const keys = Object.keys(classes);
    if (!keys.length) {
      sel.hidden = true; $('sub').textContent = 'No roster loaded'; $('tools').hidden = true; $('foot').hidden = true;
      list.innerHTML = '<div class="empty">Tap <b>⬇︎ Load roster</b> above.<br><br>On your Mac, in the helper, <b>➕ Add</b> each class then <b>📤 Copy bundle</b>, and paste it here — all your classes load at once.</div>';
      return;
    }
    // class dropdown
    sel.hidden = keys.length < 1 ? true : false;
    sel.innerHTML = keys.map((k) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(classes[k].roster.label || k)} — ${esc(fmtDate(classes[k].roster.meetingDate))}</option>`).join('');
    const r = cur().roster;
    $('sub').textContent = `${fmtDate(r.meetingDate)} · ${r.students.length} students` + (keys.length > 1 ? ` · ${keys.length} classes loaded` : '');
    $('tools').hidden = false; $('foot').hidden = false;
    list.innerHTML = '';
    r.students.forEach((s) => list.appendChild(card(s)));
    if (!saveOk) status('⚠️ Couldn’t save on this device — Copy marks to PARS before closing.');
  }

  function card(s) {
    const m = cur().minutes[s.iin] != null ? cur().minutes[s.iin] : fullMin();
    const present = m >= fullMin(), absent = m <= 0;
    const el = document.createElement('div');
    el.className = 'card' + (absent ? ' absent' : present ? '' : ' partial');
    el.innerHTML =
      `<div class="name"><span>${esc(s.seq)}. ${esc(s.name)}</span><span class="hrs">${hoursOf(m)} h</span></div>` +
      '<div class="ctrls">' +
      `<button class="present${present ? ' on' : ''}">Present</button>` +
      `<button class="absent-btn${absent ? ' on' : ''}">Absent</button>` +
      `<div class="min"><label>min</label><input type="number" inputmode="numeric" min="0" max="${fullMin()}" value="${m}"></div>` +
      '</div>';
    el.querySelector('.present').addEventListener('click', () => { setMin(s.iin, fullMin()); render(); });
    el.querySelector('.absent-btn').addEventListener('click', () => { setMin(s.iin, 0); render(); });
    const inp = el.querySelector('input');
    inp.addEventListener('change', () => { setMin(s.iin, inp.value); render(); });
    return el;
  }

  function copyMarks() {
    const entries = Object.keys(classes).map((k) => {
      const c = classes[k];
      return { label: c.roster.label, meetingDate: c.roster.meetingDate, marks: c.roster.students.map((s) => ({ iin: s.iin, minutes: c.minutes[s.iin] != null ? c.minutes[s.iin] : c.roster.scheduledMinutes })) };
    });
    const blob = C.encodeMarksBundle(entries);
    const done = () => status(`Copied ${entries.length} class(es). On your Mac: select a class in PARS → helper 📥 Paste marks → Fill. Repeat per class.`);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(blob).then(done, () => showFallback(blob));
    else showFallback(blob);
  }
  function showFallback(blob) { const ta = $('marksout'); ta.hidden = false; ta.value = blob; ta.focus(); ta.select(); status('Couldn’t auto-copy — tap the box, Select All, Copy.'); }
  function clearAll() {
    if (!confirm('Clear ALL classes + attendance from this phone? Do this once the marks are in PARS.')) return;
    classes = {}; current = null; saveOk = true;
    try { localStorage.removeItem(LS); localStorage.removeItem(LS_CUR); } catch (_) {}
    status(''); render();
  }
  function status(msg) { $('status').textContent = msg || ''; }

  // wire up
  restore();
  render();
  $('loadbtn').addEventListener('click', () => { const b = $('loadbox'); b.hidden = !b.hidden; if (!b.hidden) $('rosterpaste').focus(); });
  $('rostercancel').addEventListener('click', () => { $('loadbox').hidden = true; $('loaderr').textContent = ''; });
  $('rosterload').addEventListener('click', () => {
    const r = loadRoster($('rosterpaste').value);
    if (r.ok) { $('loadbox').hidden = true; $('rosterpaste').value = ''; $('loaderr').textContent = ''; status(`Loaded ${r.added} class(es)${r.skipped && r.skipped.length ? ` · skipped: ${r.skipped.join('; ')}` : ''}.`); }
    else $('loaderr').textContent = r.err || 'That doesn’t look like a PARS roster/bundle. Re-copy it on your Mac and paste again.';
  });
  $('classsel').addEventListener('change', (e) => { current = e.target.value; save(); render(); });
  $('allpresent').addEventListener('click', allPresent);
  $('copymarks').addEventListener('click', copyMarks);
  $('clearbtn').addEventListener('click', clearAll);
})();
