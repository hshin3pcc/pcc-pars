'use strict';

/*
 * Compose src/core.js + src/bookmarklet.js into a single `javascript:` URL and generate the hosted
 * install page pwa/fill.html (GitHub Pages serves it next to the PWA).
 *
 *   npm run build-bookmarklet
 *
 * Exported as build() so the test suite can assert the COMMITTED page is current — the same
 * twin-file discipline as pwa/core.js (the shipped artifact must be built from the tested source).
 * A syntax error in either source fails the build (and the suite) via the new Function parse gate.
 */

const fs = require('fs');
const path = require('path');

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function build() {
  const root = path.join(__dirname, '..');
  const core = fs.readFileSync(path.join(root, 'src', 'core.js'), 'utf8');
  const wrap = fs.readFileSync(path.join(root, 'src', 'bookmarklet.js'), 'utf8');
  const src = '(function(){\n' + core + '\n' + wrap + '\n})();';
  new Function(src); // parse gate — refuse to emit a bookmarklet that won't run
  const url = 'javascript:' + encodeURIComponent(src);
  // Shortcuts variant — for the Apple Shortcuts "Run JavaScript on Web Page" action (iOS
  // blocks/neuters javascript: bookmarks; the Shortcut is the sanctioned path). Live testing
  // showed BIG pasted scripts get truncated somewhere in the Notes→copy→paste chain ("Unexpected
  // end of script" for both an 11KB multi-line and a 30KB one-line payload), so the pasted code is
  // a ~300-char STUB that fetches the full composed source (pwa/fill.js, served by the same
  // GitHub Pages origin the PWA already trusts; ACAO:* so the cross-origin fetch works from the
  // PARS page) and evals it. cache:"no-store" keeps it current — a `git push` updates every
  // installed Shortcut with no re-paste. The fetched fill.js calls completion() itself; the stub's
  // catch completes with the error so the Shortcut never hangs.
  // No completion() tail here: the wrapper's finish() calls completion() at TERMINAL points only.
  // An unconditional tail ended the Shortcut before the async clipboard path ran (live-observed:
  // checkmark, no overlay — the action's contract is "wait until completion() is called").
  const fillJs = src + '\n';
  new Function('completion', fillJs); // parse gate for the served file
  // raw.githubusercontent (NOT the Pages URL): raw serves the pushed commit INSTANTLY with
  // ACAO:* — no deploy pipeline at all. The Pages URL sat behind "pages build and deployment",
  // whose deploy service spent an entire evening rejecting artifacts ("Deployment failed, try
  // again later") while raw served the same bytes the moment they were pushed.
  const FILL_URL = 'https://raw.githubusercontent.com/hshin3pcc/pcc-pars/main/pwa/fill.js';
  // "?v="+Date.now(): a UNIQUE query per run gives the CDN a cache-miss every time, so the
  // phone always executes the freshly pushed code. (cache:"no-store" only bypasses the BROWSER
  // cache — live debugging showed the edge kept serving a stale fill.js for its max-age.)
  // The stub injects fill.js as an INLINE <script> so it executes in the PAGE world: listeners
  // survive the Shortcut's completion, and a button tap there is a real user gesture (unlocks
  // navigator.clipboard.readText with iOS's Allow-Paste bubble). Can't use <script src=raw…> —
  // raw serves text/plain with nosniff, which blocks external script tags; fetch + inline is fine.
  const shortcutSrc = 'fetch("' + FILL_URL + '?v="+Date.now(),{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("HTTP "+r.status);return r.text()}).then(function(t){var s=document.createElement("script");s.textContent=t;(document.head||document.documentElement).appendChild(s);if(typeof completion==="function")completion("PARS Fill loaded - use the panel on the page")}).catch(function(e){if(typeof completion==="function")completion("PARS Fill: could not load the code ("+e+") - check the connection and try again")});';
  new Function('completion', shortcutSrc); // parse gate for the stub too

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PARS Fill — phone bookmarklet</title>
<style>body{font:16px -apple-system,sans-serif;max-width:640px;margin:24px auto;padding:0 16px;color:#111}
textarea{width:100%;font:11px ui-monospace,monospace}ol li{margin:8px 0}
button{padding:10px 14px;border-radius:8px;border:0;background:#0a84ff;color:#fff;font-size:15px}
.note{color:#666;font-size:13px}</style></head>
<body>
<h1>📋 PARS Fill — on your phone</h1>
<p>Fills the PARS attendance form <b>right on your iPhone</b> from the marks you copied in the
PARS Attendance app — no Mac needed. It never taps Save/Certify: you review the values and do that
yourself, per class, always.</p>
<h2>Install (one time)</h2>
<ol>
<li>Copy the bookmarklet code: <button id="copy">Copy code</button> <b id="ok"></b></li>
<li>In Safari, bookmark <i>any</i> page (Share → Add Bookmark) and name it <b>PARS Fill</b>.</li>
<li>Open Bookmarks (book icon) → Edit → <b>PARS Fill</b> → replace its URL with the copied code → Done.</li>
</ol>
<h2>Each week</h2>
<ol>
<li>PARS Attendance app → <b>📋 Copy marks</b> (covers every class).</li>
<li>Open PARS in Safari, log in, select the class + open week.</li>
<li>Tap the address bar, type <b>PARS Fill</b>, tap the bookmark. Allow the paste when Safari asks.</li>
<li>Review the filled values → tap PARS's own <b>Save / Certify</b>. Next class: select it in PARS,
tap the bookmark again (the copied marks cover all classes).</li>
</ol>
<textarea rows="6" readonly id="code">${url}</textarea>
<h2>If the bookmark does nothing / shows "JavaScript is not allowed"</h2>
<p>Newer iOS versions block <code>javascript:</code> bookmarks. Use the <b>Shortcut</b> instead — Apple's
sanctioned path. The pasted code is a tiny loader; the real code is served from this site (updates
automatically, and it's the same tested core as everything else):</p>
<ol>
<li>Copy the Shortcut code: <button id="copy2">Copy Shortcut code</button> <b id="ok2"></b></li>
<li><b>Shortcuts</b> app → <b>+</b> → search for the action <b>Run JavaScript on Web Page</b> → add it
→ paste the code into its script field.</li>
<li>Name it <b>PARS Fill</b>. In the shortcut's info (ⓘ) panel turn on <b>Show in Share Sheet</b>.</li>
<li>If iOS asks: Settings → Shortcuts → Advanced → enable <b>Allow Running Scripts</b>.</li>
<li>Each week: on the PARS page in Safari → <b>Share</b> → <b>PARS Fill</b> → allow the paste → review
→ Save/Certify.</li>
</ol>
<textarea rows="4" readonly id="code2">${escHtml(shortcutSrc)}</textarea>
<p class="note">Generated by <code>npm run build-bookmarklet</code> — do not edit by hand. The code is
built from the same tested core as the desktop extension (fail-closed class matching), runs only on the
PARS page, and contains no student data.</p>
<script>function wireCopy(btn,box,ok){document.getElementById(btn).addEventListener('click',function(){var t=document.getElementById(box);t.select();if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t.value).then(function(){document.getElementById(ok).textContent='✓ copied'})}else{document.execCommand('copy');document.getElementById(ok).textContent='✓ copied'}})}wireCopy('copy','code','ok');wireCopy('copy2','code2','ok2');</script>
</body></html>
`;
  return { url, html, bytes: url.length, shortcutSrc, fillJs };
}

if (require.main === module) {
  const { html, bytes, fillJs, shortcutSrc } = build();
  fs.writeFileSync(path.join(__dirname, '..', 'pwa', 'fill.html'), html);
  fs.writeFileSync(path.join(__dirname, '..', 'pwa', 'fill.js'), fillJs);
  console.log(`pwa/fill.html + pwa/fill.js written — bookmarklet ${bytes} bytes, Shortcut stub ${shortcutSrc.length} chars (parse-checked).`);
}

module.exports = { build };
