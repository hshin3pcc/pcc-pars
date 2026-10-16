# PCC PARS Helper

A desktop browser extension that makes PCC **PARS** (Positive Attendance Recording System) attendance
entry fast: mark a scrollable roster — one tap for **All present**, then fix the few outliers — and it
fills the real PARS form for you. It **never saves or certifies**; you review and click PARS's own
*Save now* / *Certify week*, so the funding-compliance step stays a human action.

## Why an extension (not a website)
PARS sits behind PCC's Microsoft 365 SSO (Azure AD App Proxy) and is a client-side form with no API.
So the only way to "push" data is to fill the live form **in your authenticated browser session** — which
is exactly what a content-script extension does. Nothing leaves your machine; no tokens, no server.

## Install (one time)
1. Open `chrome://extensions` (Chrome/Edge/Brave).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this `pcc-pars` folder.

## Use
1. Log into PARS and pick a **class** and an **open (uncertified)** week — the hours cells must be editable.
2. Click the green **📋 PARS Helper** button (bottom-right).
3. **✓ All present** sets everyone to full attendance. Then for the outliers: tap **Absent**, or type the
   **minutes present** (e.g. 5 minutes late on a 195-minute class → type `190`). Hours auto-convert
   (`minutes ÷ 50`, the class's own unit — shown live).
4. Click **Fill PARS** — it writes the hours into the form.
5. **Review**, then click PARS's **Save now** / **Certify week** yourself.

Your in-progress marks are saved locally (per class + week), so a page reload won't lose them; they're
cleared once you Fill.

**Notes / current limits (Phase 1):**
- **Single-meeting weeks only.** If a class meets more than one day in the selected week, the panel says
  so and won't fill — enter those weeks directly in PARS. (Your orchestra meets Mondays, so it's covered.)
- **How it enters time.** PARS reads a bare number as *clock* hours (so typing `3.9` wrongly becomes 4.68
  and pops an alert). The documented way is `/<minutes>` — so the helper writes `/195` for full, `/190`
  for 5 min late, `0` for absent, and PARS converts to hours itself. Spot-check one student on first use.

## Phase 2 — phone capture (built)
Jot attendance on your phone during rehearsal, then push it to PARS from your Mac. **No cloud, no server**
— the handoff is Apple **Universal Clipboard** (copy on one device, paste on the other), so student data
only ever lives on your two devices. The phone app (`pwa/`) works **offline** and remembers your marks.

**Load rosters ONCE per term** (the app tracks the week itself):
1. **Mac (once):** for each class, select it in PARS → helper **➕ Add class to bundle** → then **📤 Copy
   bundle (N)**.
2. **Phone (once):** **PARS Attendance** app → **⬇︎ Load roster** → **Paste** — all classes load together.

**Each rehearsal (no re-loading):**
3. **Phone:** pick the class from the dropdown (it's already on the current week — auto-rolled; ◀ ▶ to
   adjust for holidays/make-ups). **✓ All present**, then **Absent**/minutes for the outliers. Offline-OK.
4. **Phone:** **📋 Copy marks** (covers every class, **every stored week**, at once) — or, when Universal
   Clipboard won't cooperate, **📡 Share marks** → **AirDrop** to the Mac (a tiny `pars-marks-<date>.txt`
   lands in Downloads; Messages/Mail to yourself work too).
5. **Mac:** paste **once** into the helper (**📥 Paste marks from phone**), or click **📂 Open marks file**
   and pick the AirDropped `.txt` — either fills the class on screen and stores the rest. Then per class:
   select it **and the week** in PARS → **📥 Fill from phone marks** (one click, no re-paste) →
   **Save/Certify**. Filled entries drop their marks (no IINs at rest); a fresh paste replaces the stored
   bundle. Because every week is in the bundle, a **past week can be re-filed**: pick that week in PARS
   and click Fill — the match is class + exact date, fail closed, so marks can't land on the wrong week.
6. **Phone:** tap **☐ Filed** on each week once it's in PARS, so the reminder banner stops naming it.

> ### ⚠️ Wi-Fi gotcha — put BOTH devices on `PCC_Campus`
> Universal Clipboard **does not work on `PCC_Staff`.** Verified 2026-08-25: marks copied fine on the
> phone and simply never arrived on the Mac. Moving **both** the phone and the Mac to the public
> `PCC_Campus` network fixed it immediately. Do that before step 4.
>
> Don't be misled by "Universal Clipboard is peer-to-peer, so the network can't matter" — *discovery*
> is Bluetooth LE, but the **transfer** can fall back to infrastructure Wi-Fi, and an enterprise
> network's client isolation / VLAN separation blocks device-to-device while its managed APs squeeze
> AWDL. That reasoning cost twenty minutes of debugging the wrong things.
>
> Already ruled out, so don't re-check them: same Apple ID on both devices, Handoff enabled, Wi-Fi and
> Bluetooth on, payload size (~35 bytes/student — under 3 KB for a full term), and the phone's copy
> step (it correctly reported "Copied N class(es)").
>
> Debugging tip: `networksetup -getairportnetwork en0` reports **"not associated with an AirPort
> network"**, and `ipconfig getsummary` redacts the SSID, whenever the calling process lacks Location
> Services permission — that is *not* evidence the Mac is off Wi-Fi. Use `ifconfig en0` and look for
> `status: active` plus an `inet` address.
>
>
> **2026-10-16: it bit again at home** (both devices on the same home Wi-Fi, restarts didn't help), so
> the clipboard is now optional: the PWA's **📡 Share marks** AirDrops the bundle as a `.txt` and the
> helper's **📂 Open marks file** reads it. The phone-only Shortcut and the **🎼 Load marks from chef**
> bridge remain the other clipboard-free paths. Universal Clipboard is still the fastest when it works.

**Phone-only alternative (no Mac needed): the PARS Fill Shortcut.** Live-tested July 2026: modern iOS
silently kills `javascript:` bookmarklets AND unbound Shortcut actions, so the working path is an Apple
Shortcut ("Run JavaScript on Web Page", input BOUND to Shortcut Input — build order matters; full steps
on `https://<you>.github.io/pcc-pars/pwa/fill.html`). The pasted code is a ~560-char loader that fetches
`pwa/fill.js` from raw.githubusercontent on every run (push-instant updates, no Pages pipeline) and
injects it into the page, where a button tap supplies the user gesture iOS requires for clipboard reads.
Weekly loop: PARS app → **📋 Copy marks** → Safari → class + open week → **Share → PARS Fill** → green
button → Allow paste → review → **Save/Certify**. Same tested core as the extension (fail-closed
label+date matching, single-meeting-week guard, never touches Save/Certify); tests pin the committed
artifacts to the source. The Mac extension remains the desktop path.

**Week history (Phase 2.3, 2026-10-16).** The phone keeps **every week** a class has shown (the header
counts them: "· 6 weeks stored"). ◀ ▶ just turn pages — nothing is cleared, and **📅 This week** / the
on-open **auto-roll** always advance to the current week because a past week is never lost by moving.
The banner still does the reminding: it **names past weeks holding absences/partials that aren't marked
filed** (tap ◀ to revisit, **☐ Filed** once they're in PARS; the iOS app records this receipt itself),
and names all-present weeks it just advanced past, since it can't know those were filed. This exists
because of a real mistake: 10/5 marks were filed by hand onto 9/28 and couldn't be undone — now the
phone's copy of each week is the audit trail, and re-filing the right week is one click. You only
re-load a roster when a student **adds/drops**, and re-loading reconciles **every** stored week. The
extension and Shortcut validate the marks match the class + week showing in PARS before filling.

**Host the phone app (one time):** the PWA needs an https URL. Push this repo to GitHub → enable **Pages**
→ open `https://<you>.github.io/pcc-pars/pwa/` on your iPhone → **Share → Add to Home Screen**. The app
shell is just code (no student data), so hosting it exposes nothing. After installing, it runs offline.
- `npm run build-pwa` copies `src/core.js` into `pwa/` (single source of truth); run it after editing core.
- *(Optional)* drop a 180×180 `pwa/icon.png` + an `apple-touch-icon` link for a nicer home-screen icon; it installs fine without one.

## GitHub Pages troubleshooting

When `https://<you>.github.io/pcc-pars/pwa/` won't load or Settings → Pages shows a failed build,
check in this order:
1. **Is `.nojekyll` still at the repo root?** It's an empty file next to `README.md` — its presence
   tells Pages to publish the tree as plain static files instead of routing it through the Jekyll
   builder. Without it, Pages can fail outright (this happened once: two contentless "Page build
   failed" runs during a GitHub Pages incident, fixed by adding `.nojekyll`). A rebase or root
   cleanup could drop it silently — confirm it's still there before anything else.
2. **Is the deploy queue jammed?** Check the Actions tab (or Settings → Pages) for runs stuck on
   "Queued." This happened once too — two runs stuck queued for over an hour, blocking the lane —
   and the fix was a no-op push (`git commit --allow-empty -m "Redeploy" && git push`) to force a
   fresh deploy; no code change was needed.
3. Only once both of those check out clean is it worth suspecting the site content itself.

## Develop
- `src/core.js` — pure scrape/convert/fill logic (no browser globals; same code runs in the page and in tests).
- `src/content.js` — injects the panel and wires it to the live PARS page.
- `npm install && npm test` — runs the core logic against a real-structure PARS fixture (jsdom).
- **Storage-schema rule (PWA):** `pwa/app.js` keeps everything under one localStorage key (`pars.v2`).
  Phase 2.3 added `weeks`/`filed` per class **additively** (a pre-history entry is folded into `weeks`
  by `migrate()` on restore; `minutes` is kept in sync with `weeks[weekDate]` so older readers still
  work), which is why the key did not need a bump.
  If the stored shape ever changes incompatibly, bump the key **and write a migration read from the old key** —
  a bare key bump looks like a fresh install and silently discards any un-filed week (this bit once:
  `78cf26e` moved `pars.classes`/`pars.current` → `pars.v2` with no migration). Same rule applies to
  the extension's `chrome.storage.local` keys (`pars:<date>:<label>`, `pars.phonebundle`, `pars.marksbundle`).

## Phase 3 — chef bridge (built)

The orchestra now records attendance in **chef** (the ensemble app at `pccorch.onrender.com` — see the
`chef` sibling repo): Henry taps P / L-with-minutes-late / E / A from the podium during rehearsal. This
phase pulls those marks into the helper so PARS entry becomes review-and-click:

1. In PARS: select the class + open week as usual → **📋 PARS Helper** → **🎼 Load marks from chef**.
2. First use only: paste the chef **runner token** (`CHEF_RUNNER_TOKEN` in Henry's OS `.env`) — kept in
   `chrome.storage.local` on this Mac only, and only after a fetch with it succeeds.
3. The helper fetches chef's `/api/runner/pars` for the on-screen **meeting date**, passing the **live
   scraped class length** as the full-session minutes — so chef's math (present = full, late = full −
   minutes missed, excused/absent = 0) always matches what PARS says the class is worth this term,
   never a hardcoded number.
4. Marks land in the **capture grid** (not straight into PARS), matched by student ID — normalized so
   leading-zero IIN differences don't miss, unmatched chef records are *reported never guessed*, and
   students with no chef record keep their current value. Then the normal flow: review → **Fill PARS** →
   PARS's own **Save now / Certify week**.

Privacy stance unchanged: the fetch goes to Henry's own system of record (no third-party service), the
extension still never saves or certifies, and the service worker is the only place the token lives.
