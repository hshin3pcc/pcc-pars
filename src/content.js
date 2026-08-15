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
  // Has Henry marked anything this week (now, or restored from storage)? Gates the "All present"
  // overwrite confirm — scraped PARS defaults alone (blank cells read as 0) must NOT trigger it,
  // or a fresh week would nag on the very first tap.
  let touched = false;
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
      '<button class="ph-addclass">➕ Add class to bundle</button>' +
      '<button class="ph-copybundle">📤 Copy bundle (0)</button>' +
      '</div>' +
      '<div class="ph-tools">' +
      '<button class="ph-fromphone">📥 Paste marks from phone</button>' +
      '<button class="ph-clearbundle">🗑 Clear bundle</button>' +
      '</div>' +
      '<div class="ph-tools" id="ph-storedrow" style="display:none">' +
      '<button class="ph-fillstored">📥 Fill from phone marks</button>' +
      '</div>' +
      '<div class="ph-tools">' +
      '<button class="ph-fromchef">🎼 Load marks from chef</button>' +
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
    panel.querySelector('.ph-addclass').addEventListener('click', addToBundle);
    panel.querySelector('.ph-copybundle').addEventListener('click', copyBundle);
    panel.querySelector('.ph-clearbundle').addEventListener('click', clearBundle);
    panel.querySelector('.ph-fromphone').addEventListener('click', () => {
      const b = panel.querySelector('#ph-pastebox');
      b.style.display = b.style.display === 'none' ? 'block' : 'none';
      if (b.style.display === 'block') panel.querySelector('#ph-marksin').focus();
    });
    panel.querySelector('.ph-fillpasted').addEventListener('click', fillFromPhone);
    panel.querySelector('.ph-fillstored').addEventListener('click', fillStored);
    panel.querySelector('.ph-fromchef').addEventListener('click', () => fillFromChef());
    pushBtn.addEventListener('click', push);
    getBundle((arr) => updateBundleCount(arr.length));   // restore the count on open
  }

  // ---- Phase-2 handoff (Universal Clipboard / AirDrop; no cloud) ----
  // Bundle accumulator: add each class (as you click through them in PARS), then Copy the bundle once.
  const BUNDLE_KEY = 'pars.phonebundle';
  function getBundle(cb) { if (hasStorage) chrome.storage.local.get([BUNDLE_KEY], (r) => cb((r && r[BUNDLE_KEY]) || [])); else cb([]); }
  function setBundle(arr, cb) { if (hasStorage) chrome.storage.local.set({ [BUNDLE_KEY]: arr }, cb || (() => {})); else if (cb) cb(); }
  function updateBundleCount(n) { const b = panel && panel.querySelector('.ph-copybundle'); if (b) b.textContent = `📤 Copy bundle (${n})`; }
  function addToBundle() {
    if (!roster || !roster.students.length) { status('Open a class + an open week, then ↻ Reload roster first.'); return; }
    if (roster.meta.multiMeeting || !roster.meta.scheduledMinutes) { status('This week can’t go to the phone (multi-day / unreadable class length) — record it directly in PARS.'); return; }
    const entry = C.toRosterBlob(roster);
    getBundle((arr) => {
      const k = `${entry.label}||${entry.meetingDate}`;
      const next = arr.filter((e) => `${e.label}||${e.meetingDate}` !== k);   // replace if this class is already in
      next.push(entry);
      setBundle(next, () => { updateBundleCount(next.length); status(`Added “${entry.label}” — bundle has ${next.length} class(es). Switch to your next class in PARS, ↻ Reload, Add it; then Copy bundle.`); });
    });
  }
  function copyBundle() {
    getBundle((arr) => {
      if (!arr.length) { status('Bundle is empty — open each class and click “➕ Add class to bundle” first.'); return; }
      const blob = C.encodeBundle(arr);
      const note = `Copied ${arr.length} class(es). On your phone: PARS app → ⬇︎ Load roster → Paste (loads them all).`;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(blob).then(() => status(note), () => copyFallback(blob));
      else copyFallback(blob);
    });
  }
  function clearBundle() { setBundle([], () => { updateBundleCount(0); status('Phone bundle cleared.'); }); }
  function copyFallback(blob) {
    const box = panel.querySelector('#ph-rosterbox'); box.style.display = 'block';
    const ta = panel.querySelector('#ph-rosterout'); ta.value = blob; ta.focus(); ta.select();
    status('Couldn’t auto-copy — select the text above and copy it (⌘C), then paste on your phone.');
  }
  // ---- ONE paste per week: the phone marks bundle (all classes) is kept in chrome.storage.local
  // so every class page can fill without re-pasting. Local-only (never .sync). Each entry's marks
  // are STRIPPED once that class is filled — same "no IINs at rest" discipline as the capture grid
  // (the label/date/filledAt receipt stays so the button can say it's done). Stale entries are
  // inert by construction: the fill matches on label + meeting date, fail closed. ----
  const MARKS_KEY = 'pars.marksbundle';
  function getMarksBundle(cb) { if (hasStorage) chrome.storage.local.get([MARKS_KEY], (r) => cb((r && r[MARKS_KEY]) || null)); else cb(null); }
  function setMarksBundle(obj, cb) { if (hasStorage) chrome.storage.local.set({ [MARKS_KEY]: obj }, cb || (() => {})); else if (cb) cb(); }

  /** Show the stored-fill button only when the stored bundle holds an UNFILLED entry for the class
   *  on screen (other classes / stale weeks simply never match → the button stays hidden). */
  function updateStoredButton(live) {
    const row = panel && panel.querySelector('#ph-storedrow'); if (!row) return;
    getMarksBundle((store) => {
      const entry = store && live && C.matchBundleEntry(store.classes, live.meta.label, live.meetingDate);
      if (entry && entry.marks && entry.marks.length) {
        row.style.display = '';
        row.querySelector('.ph-fillstored').textContent = `📥 Fill from phone marks (${fmtDate(store.savedAt)})`;
      } else row.style.display = 'none';
    });
  }

  /** Fill the live page from one bundle entry, strip its marks (receipt stays), persist, report. */
  function fillEntry(entry, live, store) {
    const marks = {};
    (entry.marks || []).forEach((m) => { if (m && m.iin != null) marks[m.iin] = { minutes: m.minutes }; });
    const r = C.applyFill(document, C.buildFillPlan(live, marks));
    entry.marks = []; entry.filledAt = C.ymdFromDate(new Date());   // no IINs at rest once filled
    setMarksBundle(store, () => updateStoredButton(live));
    const left = (store.classes || []).filter((e) => e && e.marks && e.marks.length).length;
    status(`Filled ${r.written} into “${live.meta.label}”${r.skipped ? ` (${r.skipped} skipped)` : ''}. Review + Save/Certify.` +
      (left ? ` ${left} class(es) still stored — select the next class in PARS and click 📥 Fill from phone marks (no re-paste).` : ' All stored classes are filled.'));
  }

  function fillFromPhone() {
    const text = panel.querySelector('#ph-marksin').value;
    const live = C.parseRoster(document);
    if (!live.students.length || live.meta.multiMeeting || !live.meta.scheduledMinutes) { status('Open the matching class + open week in PARS, then ↻ Reload roster.'); return; }
    // Accept a marks BUNDLE (many classes) or a single-class blob. Either way STORE it first, so
    // this is the only paste of the week — every other class fills from storage with one click.
    const bundle = C.decodeMarksBundle(text);
    const single = bundle ? null : C.decodeMarks(text);
    if (!bundle && !single) { status('That doesn’t look like phone marks — re-copy on the phone and paste again.'); return; }
    const store = { savedAt: C.ymdFromDate(new Date()), classes: bundle || [single] };
    setMarksBundle(store, () => {
      const entry = C.matchBundleEntry(store.classes, live.meta.label, live.meetingDate);
      if (!entry) {
        updateStoredButton(live);
        status(`Stored ${store.classes.length} class(es) of phone marks — but none match “${live.meta.label}” for ${fmtDate(live.meetingDate)}. Select a matching class + week in PARS and click 📥 Fill from phone marks.`);
        return;
      }
      fillEntry(entry, live, store);
    });
  }

  function fillStored() {
    const live = C.parseRoster(document);
    if (!live.students.length || live.meta.multiMeeting || !live.meta.scheduledMinutes) { status('Open the matching class + open week in PARS, then ↻ Reload roster.'); return; }
    getMarksBundle((store) => {
      const entry = store && C.matchBundleEntry(store.classes, live.meta.label, live.meetingDate);
      if (!entry) { updateStoredButton(live); status('No stored phone marks match this class/week — use 📥 Paste marks from phone.'); return; }
      if (!entry.marks || !entry.marks.length) { status(`“${live.meta.label}” was already filled from these phone marks${entry.filledAt ? ` (${fmtDate(entry.filledAt)})` : ''} — re-copy on the phone and paste to fill again.`); return; }
      fillEntry(entry, live, store);
    });
  }

  // ---- Chef bridge (Phase 3): pull the rehearsal's marks straight from chef (the orchestra app,
  // where Henry taps attendance from the podium) into the CAPTURE GRID — not straight into PARS, so
  // review + Fill + Save/Certify stay exactly the human steps they were. The class length sent to
  // chef is the LIVE scraped scheduledMinutes, so chef's present/late math always matches whatever
  // PARS says the class is worth this term (185, 195…), never a hardcoded constant. ----
  function fillFromChef(promptedToken) {
    const live = C.parseRoster(document);
    if (!live.students.length || live.meta.multiMeeting || !live.meta.scheduledMinutes) {
      status('Open the class + an open week in PARS first (single-meeting weeks only), then try chef again.');
      return;
    }
    const d = live.meetingDate;
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    status('Fetching marks from chef…');
    chrome.runtime.sendMessage(
      { type: 'chef-pars', date, fullMinutes: live.meta.scheduledMinutes, token: promptedToken },
      (resp) => {
        if (!resp) { status('Chef bridge unavailable — reload the extension (chrome://extensions).'); return; }
        if (resp.needsToken) {
          const t = window.prompt(resp.badToken
            ? 'Chef rejected that token — paste the current runner token (CHEF_RUNNER_TOKEN in Henry\'s OS .env):'
            : 'One-time setup: paste the chef runner token (CHEF_RUNNER_TOKEN in Henry\'s OS .env). Stored on this Mac only.');
          if (t && t.trim()) fillFromChef(t.trim());
          else status('Chef fill cancelled — no token given.');
          return;
        }
        if (resp.error) { status(`Chef fetch failed: ${resp.error}`); return; }
        if (!resp.rows.length) { status(`Chef has no attendance recorded for ${fmtDate(d)} — mark the rehearsal in chef first (Events → Attend).`); return; }
        const conv = C.chefMarksToMinutes(resp.rows, live.students, live.meta.scheduledMinutes);
        if (!conv.matched) {
          status(`Chef sent ${resp.rows.length} record(s) for ${fmtDate(d)}, but none matched this roster's IDs — check the PCC IDs on chef's member rows.`);
          return;
        }
        // Load into the grid over fresh PARS defaults (same baseline as ↻ Reload roster).
        roster = live;
        const defaults = {};
        live.students.forEach((s) => {
          defaults[s.iin] = Math.round((s.currentHours != null ? s.currentHours : live.meta.fullHours || 0) * unit());
        });
        minutes = Object.assign(defaults, conv.minutes);
        touched = true; saveMarks(); render();
        const misses = conv.unmatchedChef.length
          ? ` ${conv.unmatchedChef.length} chef record(s) had no matching student here: ${conv.unmatchedChef.slice(0, 4).join(', ')}${conv.unmatchedChef.length > 4 ? '…' : ''}.`
          : '';
        status(`Loaded ${conv.matched} of ${resp.rows.length} chef mark(s) into the grid.${misses} Review, then Fill PARS.`);
      }
    );
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
      touched = !!(saved && Object.keys(saved).length);
      render();
    });
  }

  function allPresent() {
    if (roster.meta.multiMeeting || !roster.meta.scheduledMinutes) return;   // disabled views
    if (touched && C.hasNonFullMarks(roster.students, minutes, fullMin()) &&
        !confirm('Set everyone to full? The absences/partials you’ve marked for this week will be overwritten.')) return;
    roster.students.forEach((s) => { minutes[s.iin] = fullMin(); }); touched = true; saveMarks(); render();
  }

  function setMin(iin, val) {
    if (val === '' || val == null || (typeof val === 'string' && !val.trim())) return;   // blank = no change (don't flip to Absent)
    const m = Math.round(Number(val));
    if (!Number.isFinite(m)) return;
    minutes[iin] = Math.max(0, Math.min(fullMin(), m));   // clamp 0..full
    touched = true;
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
    updateStoredButton(roster);   // offer the one-click stored fill when this class's marks are waiting
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
