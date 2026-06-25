'use strict';

/*
 * PARS Attendance PWA (Phase 2) — the phone capture app. Fully offline + local: the roster comes in by
 * pasting the blob the Mac extension copied (Apple Universal Clipboard), you mark attendance during/after
 * rehearsal, and you Copy the marks back to paste into the extension. NOTHING leaves your devices — no
 * server, no cloud. State persists in localStorage so it survives closing the app or losing signal.
 */
(function () {
  const C = window.PARSCore;
  const LS_ROSTER = 'pars.roster', LS_MARKS = 'pars.marks';
  let roster = null;     // { label, meetingDate, multiMeeting, scheduledMinutes, fullHours, unit, students:[{iin,name,seq}] }
  let minutes = {};      // iin -> minutes present
  let saveOk = true;

  const $ = (id) => document.getElementById(id);
  const fullMin = () => (roster && roster.scheduledMinutes) || 195;
  const unit = () => (roster && roster.unit) || 50;
  const hoursOf = (m) => C.minutesToHours(m, unit());
  const fmtDate = (d) => (d && d.length === 8) ? `${+d.slice(4, 6)}/${+d.slice(6, 8)}/${d.slice(0, 4)}` : (d || '');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function save() {
    try { localStorage.setItem(LS_ROSTER, JSON.stringify(roster)); localStorage.setItem(LS_MARKS, JSON.stringify(minutes)); saveOk = true; }
    catch (_) { saveOk = false; status('⚠️ Couldn’t save on this device — Copy marks to PARS before closing the app.'); }
  }
  function restore() {
    try {
      roster = JSON.parse(localStorage.getItem(LS_ROSTER) || 'null');
      minutes = JSON.parse(localStorage.getItem(LS_MARKS) || '{}') || {};
    } catch (_) { roster = null; minutes = {}; }
  }

  function hasUnsavedMarks() {
    return !!roster && roster.students.some((s) => minutes[s.iin] != null && minutes[s.iin] !== fullMin());
  }
  function loadRoster(text) {
    const o = C.decodeRoster(text);
    if (!o) return { ok: false };
    if (o.multiMeeting) return { ok: false, err: 'This class meets more than one day this week — record it directly in PARS.' };
    if (!o.scheduledMinutes) return { ok: false, err: 'Couldn’t read the class length — re-copy the roster on your Mac.' };
    const changed = !roster || roster.meetingDate !== o.meetingDate || roster.label !== o.label;
    if (changed && hasUnsavedMarks() && !confirm('Replace the current attendance? Marks you haven’t copied to PARS yet will be cleared.')) return { ok: false, cancelled: true };
    roster = o;
    if (changed) { minutes = {}; roster.students.forEach((s) => { minutes[s.iin] = fullMin(); }); }   // new week -> default all present
    save(); render();
    return { ok: true };
  }
  function clearAll() {
    if (!confirm('Clear the roster + attendance from this phone? Do this once the marks are in PARS.')) return;
    roster = null; minutes = {}; saveOk = true;
    try { localStorage.removeItem(LS_ROSTER); localStorage.removeItem(LS_MARKS); } catch (_) {}
    status(''); render();
  }

  function setMin(iin, v) {
    if (v === '' || v == null || (typeof v === 'string' && !v.trim())) return;   // blank = no change (don't flip to Absent)
    const m = Math.round(Number(v));
    if (!Number.isFinite(m)) return;
    minutes[iin] = Math.max(0, Math.min(fullMin(), m));
    save();
  }
  function allPresent() { if (!roster) return; roster.students.forEach((s) => { minutes[s.iin] = fullMin(); }); save(); render(); }

  function render() {
    const list = $('list');
    if (!roster) {
      $('sub').textContent = 'No roster loaded';
      $('tools').hidden = true; $('foot').hidden = true;
      list.innerHTML = '<div class="empty">Tap <b>⬇︎ Load roster</b> above.<br><br>On your Mac, open PARS and the helper, click <b>📤 Copy roster for phone</b>, then paste it here.</div>';
      return;
    }
    $('sub').textContent = `${roster.label || 'Class'} · ${fmtDate(roster.meetingDate)} · ${roster.students.length} students`;
    $('tools').hidden = false; $('foot').hidden = false;
    list.innerHTML = '';
    roster.students.forEach((s) => list.appendChild(card(s)));
    if (!saveOk) status('⚠️ Couldn’t save on this device — Copy marks to PARS before closing.');
  }

  function card(s) {
    const m = minutes[s.iin] != null ? minutes[s.iin] : fullMin();
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
    const marks = roster.students.map((s) => ({ iin: s.iin, minutes: minutes[s.iin] != null ? minutes[s.iin] : fullMin() }));
    const blob = C.encodeMarks({ label: roster.label, meetingDate: roster.meetingDate, marks });
    const done = () => { status('Marks copied. On your Mac: helper → 📥 Paste marks → Fill PARS.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(blob).then(done, () => showFallback(blob));
    } else { showFallback(blob); }
  }
  function showFallback(blob) {
    const ta = $('marksout'); ta.hidden = false; ta.value = blob; ta.focus(); ta.select();
    status('Couldn’t auto-copy — tap the box, Select All, Copy.');
  }
  function status(msg) { $('status').textContent = msg || ''; }

  // wire up
  restore();
  render();
  $('loadbtn').addEventListener('click', () => { const b = $('loadbox'); b.hidden = !b.hidden; if (!b.hidden) $('rosterpaste').focus(); });
  $('rostercancel').addEventListener('click', () => { $('loadbox').hidden = true; $('loaderr').textContent = ''; });
  $('rosterload').addEventListener('click', () => {
    const r = loadRoster($('rosterpaste').value);
    if (r.ok) { $('loadbox').hidden = true; $('rosterpaste').value = ''; $('loaderr').textContent = ''; }
    else if (r.cancelled) { $('loaderr').textContent = ''; }
    else $('loaderr').textContent = r.err || 'That doesn’t look like a PARS roster. Re-copy it on your Mac and paste again.';
  });
  $('allpresent').addEventListener('click', allPresent);
  $('copymarks').addEventListener('click', copyMarks);
  $('clearbtn').addEventListener('click', clearAll);
})();
