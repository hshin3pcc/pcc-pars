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
