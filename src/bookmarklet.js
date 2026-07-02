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
  if (!C) { alert('PARS Fill: core failed to load — reinstall the bookmarklet from the helper page.'); return; }

  var BOX_ID = 'pars-fill-overlay';
  function overlay(msg, withPaste) {
    var old = document.getElementById(BOX_ID); if (old) old.remove();
    var box = document.createElement('div');
    box.id = BOX_ID;
    box.style.cssText = 'position:fixed;top:8px;left:8px;right:8px;z-index:2147483647;background:#1c1c1e;color:#fff;padding:14px;border-radius:12px;font:15px -apple-system,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.4)';
    var p = document.createElement('div'); p.textContent = msg; box.appendChild(p);
    if (withPaste) {
      var ta = document.createElement('textarea');
      ta.rows = 3; ta.placeholder = 'Paste the marks here…';
      ta.style.cssText = 'width:100%;margin-top:10px;font:13px ui-monospace,monospace;color:#000';
      box.appendChild(ta);
      var go = document.createElement('button'); go.textContent = 'Fill from pasted marks';
      go.style.cssText = 'margin-top:8px;width:100%;padding:10px;border-radius:8px;border:0;background:#0a84ff;color:#fff;font-size:15px';
      go.addEventListener('click', function () { fillFrom(ta.value); });
      box.appendChild(go);
    }
    var x = document.createElement('button'); x.textContent = 'Close';
    x.style.cssText = 'margin-top:8px;width:100%;padding:8px;border-radius:8px;border:0;background:#3a3a3c;color:#fff';
    x.addEventListener('click', function () { box.remove(); });
    box.appendChild(x);
    document.body.appendChild(box);
  }

  // Guard: only ever act on the real PARS page. Anywhere else, explain and do nothing.
  if (!/(^|\.)pasadena\.edu$/i.test(location.hostname) || location.pathname.toLowerCase().indexOf('pcc_pars') < 0) {
    alert('PARS Fill: open the PARS attendance page (csweb-pub.pasadena.edu/pcc_pars/…) first, then tap this bookmark.');
    return;
  }
  var live = C.parseRoster(document);
  if (!live.students.length) { overlay('No editable roster on this page — pick a class and an OPEN (uncertified) week in PARS, then tap the bookmark again.'); return; }
  if (live.meta.multiMeeting) { overlay('This class meets more than one day this week — the helper fills single-meeting weeks only. Enter this one directly in PARS.'); return; }
  if (!live.meta.scheduledMinutes) { overlay('Couldn’t read the class length from PARS, so no hours will be guessed — enter this week directly in PARS.'); return; }

  function fillFrom(text) {
    var single;
    var bundle = C.decodeMarksBundle(text) || ((single = C.decodeMarks(text)) ? [single] : null);
    if (!bundle) { overlay('That isn’t phone marks — in the PARS Attendance app tap 📋 Copy marks, then tap this bookmark again.', true); return; }
    var entry = C.matchBundleEntry(bundle, live.meta.label, live.meetingDate);
    if (!entry) { overlay('The copied marks (' + bundle.length + ' class(es)) don’t include “' + live.meta.label + '” for this week — check the class + week PARS is showing.', true); return; }
    var marks = {};
    (entry.marks || []).forEach(function (m) { if (m && m.iin != null) marks[m.iin] = { minutes: m.minutes }; });
    var r = C.applyFill(document, C.buildFillPlan(live, marks));
    overlay('Filled ' + r.written + ' student(s) into “' + live.meta.label + '”' + (r.skipped ? ' (' + r.skipped + ' skipped — roster changed?)' : '') + '. REVIEW the values, then tap PARS’s own Save / Certify. Nothing was submitted automatically.');
  }

  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then(fillFrom, function () {
      overlay('Couldn’t read the clipboard (permission declined?) — paste the marks manually:', true);
    });
  } else {
    overlay('Paste the marks from the PARS Attendance app:', true);
  }
})();
