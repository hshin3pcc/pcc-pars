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

**Weekly flow:**
1. **Mac:** in PARS pick the class + week → helper → **📤 Copy roster for phone**.
2. **Phone:** open the **PARS Attendance** app → **⬇︎ Load roster** → **Paste** (Universal Clipboard).
   Mark attendance: **✓ All present**, then tap **Absent** or type minutes for the outliers. (Works with
   no signal; it saves as you go.)
3. **Phone:** **📋 Copy marks for PARS**.
4. **Mac:** helper → **📥 Paste marks from phone** → paste → **Fill PARS from these phone marks** →
   review → PARS **Save / Certify**.

The extension validates that the pasted marks match the class + week showing in PARS before filling.

**Host the phone app (one time):** the PWA needs an https URL. Push this repo to GitHub → enable **Pages**
→ open `https://<you>.github.io/pcc-pars/pwa/` on your iPhone → **Share → Add to Home Screen**. The app
shell is just code (no student data), so hosting it exposes nothing. After installing, it runs offline.
- `npm run build-pwa` copies `src/core.js` into `pwa/` (single source of truth); run it after editing core.
- *(Optional)* drop a 180×180 `pwa/icon.png` + an `apple-touch-icon` link for a nicer home-screen icon; it installs fine without one.

## Develop
- `src/core.js` — pure scrape/convert/fill logic (no browser globals; same code runs in the page and in tests).
- `src/content.js` — injects the panel and wires it to the live PARS page.
- `npm install && npm test` — runs the core logic against a real-structure PARS fixture (jsdom).
