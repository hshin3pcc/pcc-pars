'use strict';

/*
 * pcc-pars content script. Injects a floating button + a mobile-first capture panel onto the PARS page,
 * scrapes the roster (via the tested PARSCore), lets Henry mark "All present" + a few outliers, and
 * writes the hours back into the real PARS inputs. It NEVER saves or certifies — Henry reviews and clicks
 * PARS's own Save/Certify, so the funding-compliance step stays a human action.
 */
(function () {
  const C = (typeof PARSCore !== 'undefined' && PARSCore) || (typeof window !== 'undefined' && window.PARSCore);
  if (!C) { console.warn('[PARS Helper] core not loaded'); return; }
  const hasStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  let roster = null;
  // iin -> minutes present (the grid's source of truth). Persisted LOCALLY per class+week (chrome.storage
  // .local, never .sync) so a reload doesn't lose work; the stored value contains student IINs (never
  // names) and is cleared after a successful Fill. Nothing leaves the device.
  let minutes = {};
  let panel = null, listEl = null, statusEl = null, pushBtn = null;

  const fullMin = () => (roster && roster.meta.scheduledMinutes) || 195;
  const unit = () => (roster && roster.meta.unit) || 50;
  const hoursOf = (min) => C.minutesToHours(min, unit());
  const key = () => (roster ? `pars:${roster.meetingDate || 'x'}:${(roster.meta.label || '').replace(/\s+/g, '').slice(0, 48)}` : null);

  function fmtDate(d) { return (d && d.length === 8) ? `${d.slice(4, 6)}/${d.slice(6, 8)}/${d.slice(0, 4)}` : (d || '—'); }
  function saveMarks() { const k = key(); if (k && hasStorage) chrome.storage.local.set({ [k]: minutes }); }
  function loadMarks(cb) { const k = key(); if (k && hasStorage) chrome.storage.local.get([k], (r) => cb((r && r[k]) || null)); else cb(null); }
  function clearMarks() { const k = key(); if (k && hasStorage) chrome.storage.local.remove(k); }   // drop IINs once filled

  // ---- build the shell ----
  function build() {
    const fab = document.createElement('button');
    fab.id = 'parshelper-fab'; fab.textContent = '📋 PARS Helper';
    fab.addEventListener('click', open);
    document.body.appendChild(fab);

    panel = document.createElement('div');
    panel.id = 'parshelper';
    panel.innerHTML =
      '<div class="ph-head"><button class="ph-close" title="Close">×</button>' +
      '<h2 id="ph-title">PARS Helper</h2><div class="ph-sub" id="ph-sub"></div></div>' +
      '<div class="ph-tools">' +
      '<button class="ph-allpresent">✓ All present</button>' +
      '<button class="ph-reload">↻ Reload roster</button>' +
      '</div>' +
      '<div class="ph-tools">' +
      '<button class="ph-tophone">📤 Copy roster for phone</button>' +
      '<button class="ph-fromphone">📥 Paste marks from phone</button>' +
      '</div>' +
      '<div id="ph-rosterbox" style="display:none;padding:10px 12px;background:#fff;border-bottom:1px solid #e3e3e6">' +
      '<div style="font-size:12px;color:#555;margin-bottom:4px">Roster — select all & copy (⌘C), then paste on your phone:</div>' +
      '<textarea id="ph-rosterout" rows="2" readonly style="width:100%;font:11px ui-monospace,monospace"></textarea>' +
      '</div>' +
      '<div class="ph-pastebox" id="ph-pastebox" style="display:none;padding:10px 12px;background:#fff;border-bottom:1px solid #e3e3e6">' +
      '<textarea id="ph-marksin" rows="2" style="width:100%;font:12px ui-monospace,monospace" placeholder="Paste the marks from your phone here…"></textarea>' +
      '<button class="ph-fillpasted" style="margin-top:6px;width:100%">Fill PARS from these phone marks</button>' +
      '</div>' +
      '<div class="ph-list" id="ph-list"></div>' +
      '<div class="ph-foot"><button class="ph-push">Fill PARS</button><div class="ph-status" id="ph-status"></div></div>';
    document.body.appendChild(panel);
    listEl = panel.querySelector('#ph-list');
    statusEl = panel.querySelector('#ph-status');
    pushBtn = panel.querySelector('.ph-push');
    panel.querySelector('.ph-close').addEventListener('click', () => panel.classList.remove('open'));
    panel.querySelector('.ph-allpresent').addEventListener('click', allPresent);
    panel.querySelector('.ph-reload').addEventListener('click', rescan);
    panel.querySelector('.ph-tophone').addEventListener('click', copyRosterForPhone);
    panel.querySelector('.ph-fromphone').addEventListener('click', () => {
      const b = panel.querySelector('#ph-pastebox');
      b.style.display = b.style.display === 'none' ? 'block' : 'none';
      if (b.style.display === 'block') panel.querySelector('#ph-marksin').focus();
    });
    panel.querySelector('.ph-fillpasted').addEventListener('click', fillFromPhone);
    pushBtn.addEventListener('click', push);
  }

  // ---- Phase-2 handoff (Universal Clipboard / AirDrop; no cloud) ----
  function copyRosterForPhone() {
    if (!roster || !roster.students.length) { status('Open a class + an open week, then ↻ Reload roster first.'); return; }
    if (roster.meta.multiMeeting || !roster.meta.scheduledMinutes) { status('This week can’t go to the phone (multi-day or unreadable class length) — record it directly in PARS.'); return; }
    const blob = C.encodeRoster(roster);
    const note = 'Roster copied. On your phone: open the PARS app → ⬇︎ Load roster → Paste.';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(blob).then(() => status(note), () => copyFallback(blob));
    } else copyFallback(blob);
  }
  function copyFallback(blob) {
    const box = panel.querySelector('#ph-rosterbox'); box.style.display = 'block';
    const ta = panel.querySelector('#ph-rosterout'); ta.value = blob; ta.focus(); ta.select();
    status('Couldn’t auto-copy — select the roster text above and copy it (⌘C), then paste on your phone.');
  }
  function fillFromPhone() {
    const payload = C.decodeMarks(panel.querySelector('#ph-marksin').value);
    if (!payload) { status('That doesn’t look like phone marks — re-copy on the phone and paste again.'); return; }
    const live = C.parseRoster(document);
    if (!live.students.length || live.meta.multiMeeting || !live.meta.scheduledMinutes) { status('Open the matching class + open week in PARS, then ↻ Reload roster.'); return; }
    // Fail CLOSED: require BOTH the date AND the class label to be present and to match. Two ensembles can
    // meet the same weekday (same date), and a student enrolled in both shares an IIN — so a date-only match
    // could write one class's marks onto another. Refuse unless class identity is positively confirmed.
    if (!payload.meetingDate || !live.meetingDate || live.meetingDate !== payload.meetingDate) { status(`These marks are for ${payload.meetingDate || '(unknown)'}; PARS shows ${live.meetingDate || '(unknown)'}. Pick the matching open week, then ↻ Reload.`); return; }
    if (!payload.label || !live.meta.label || payload.label !== live.meta.label) { status('Can’t confirm these marks are for the class PARS is showing — pick the matching class, then ↻ Reload.'); return; }
    const marks = {};
    (payload.marks || []).forEach((m) => { if (m && m.iin != null) marks[m.iin] = { minutes: m.minutes }; });
    const r = C.applyFill(document, C.buildFillPlan(live, marks));
    status(`Filled ${r.written} students from the phone${r.skipped ? ` (${r.skipped} skipped — roster changed)` : ''}. Review, then click Save/Certify in PARS.`);
  }

  function open() { if (!roster) rescan(); panel.classList.add('open'); }
  function status(msg) { if (statusEl) statusEl.textContent = msg || ''; }

  function rescan() {
    roster = C.parseRoster(document);
    const defaults = {};
    roster.students.forEach((s) => {
      defaults[s.iin] = Math.round((s.currentHours != null ? s.currentHours : roster.meta.fullHours || 0) * unit());
    });
    loadMarks((saved) => {
      minutes = Object.assign(defaults, saved || {});   // restore any saved-but-unsubmitted marks
      render();
    });
  }

  function allPresent() {
    if (roster.meta.multiMeeting || !roster.meta.scheduledMinutes) return;   // disabled views
    roster.students.forEach((s) => { minutes[s.iin] = fullMin(); }); saveMarks(); render();
  }

  function setMin(iin, val) {
    if (val === '' || val == null || (typeof val === 'string' && !val.trim())) return;   // blank = no change (don't flip to Absent)
    const m = Math.round(Number(val));
    if (!Number.isFinite(m)) return;
    minutes[iin] = Math.max(0, Math.min(fullMin(), m));   // clamp 0..full
    saveMarks();
  }

  function render() {
    const sub = panel.querySelector('#ph-sub');
    panel.querySelector('#ph-title').textContent = (roster.meta.label || 'Class').slice(0, 60);
    sub.textContent = `${fmtDate(roster.meetingDate)} · ${roster.students.length} students · full = ${fullMin()} min → ${roster.meta.fullHours || hoursOf(fullMin())} h`;
    if (!roster.students.length) {
      listEl.innerHTML = '<div class="ph-empty">No editable roster found. Pick a class and an <b>open (uncertified)</b> week in PARS, then ↻ Reload roster.</div>';
      pushBtn.disabled = true; status(''); return;
    }
    if (roster.meta.multiMeeting) {   // class meets >1 day this week — refuse rather than silently fill one
      listEl.innerHTML = '<div class="ph-empty">This class meets <b>more than one day</b> this week. The helper supports single-meeting weeks only — enter multi-day weeks directly in PARS.</div>';
      pushBtn.disabled = true; status(''); return;
    }
    if (!roster.meta.scheduledMinutes) {   // couldn't read class length -> don't guess the hours
      listEl.innerHTML = '<div class="ph-empty">Couldn’t read the class length from PARS, so I won’t guess the hours. Reload, or enter this week directly in PARS.</div>';
      pushBtn.disabled = true; status(''); return;
    }
    pushBtn.disabled = false;
    listEl.innerHTML = '';
    roster.students.forEach((s) => listEl.appendChild(card(s)));
    pushBtn.textContent = `Fill PARS (${roster.students.length})`;
    status('');
  }

  function card(s) {
    const min = minutes[s.iin];
    const present = min >= fullMin(), absent = min <= 0;
    const el = document.createElement('div');
    el.className = 'ph-card' + (absent ? ' absent' : present ? '' : ' partial');
    el.innerHTML =
      `<div class="ph-name"><span>${escapeHtml(s.seq)}. ${escapeHtml(s.name)}</span><span class="ph-hrs">${hoursOf(min)} h</span></div>` +
      '<div class="ph-row">' +
      `<button class="ph-toggle ph-present${present ? ' on' : ''}">Present</button>` +
      `<button class="ph-toggle ph-absent${absent ? ' on' : ''}">Absent</button>` +
      `<div class="ph-min"><label>min present</label><input type="number" inputmode="numeric" min="0" max="${fullMin()}" value="${min}"></div>` +
      '</div>';
    el.querySelector('.ph-present').addEventListener('click', () => { setMin(s.iin, fullMin()); render(); });
    el.querySelector('.ph-absent').addEventListener('click', () => { setMin(s.iin, 0); render(); });
    const inp = el.querySelector('input');
    inp.addEventListener('change', () => { setMin(s.iin, inp.value); render(); });
    return el;
  }

  function push() {
    // Re-scan the LIVE page and guard against a stale grid: if the week/class changed under us, don't
    // write old marks to a different roster. Build the plan against the live DOM (current rowIds/inputs).
    const live = C.parseRoster(document);
    if (!live.students.length || live.meta.multiMeeting || !live.meta.scheduledMinutes) { status('Can’t fill this view — pick a single-meeting, open week, then ↻ Reload roster.'); return; }
    // Guard on BOTH the meeting date AND the class identity: two classes on the same weekday share a date,
    // so a date-only check would let one class's marks be written onto another. Reload if either changed.
    if (live.meetingDate !== roster.meetingDate || live.meta.label !== roster.meta.label) { status('The week/class in PARS changed — click ↻ Reload roster, then Fill again.'); return; }
    const marks = {};
    live.students.forEach((s) => { if (minutes[s.iin] != null) marks[s.iin] = { minutes: minutes[s.iin] }; });
    const r = C.applyFill(document, C.buildFillPlan(live, marks));
    clearMarks();   // the marks are now in PARS — don't keep the IINs at rest
    status(`Filled ${r.written} students into PARS${r.skipped ? ` (${r.skipped} skipped — roster changed)` : ''}. Review, then click PARS's “Save now” / “Certify week”. Nothing was submitted automatically.`);
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  if (document.body) build(); else document.addEventListener('DOMContentLoaded', build);
})();
