'use strict';

/*
 * Background service worker — the chef bridge's network half. The content
 * script can't fetch chef itself (its fetches run under the PARS page's
 * origin, so CORS blocks them); a service-worker fetch to a host in
 * host_permissions bypasses CORS cleanly.
 *
 * Auth: chef's RUNNER token (same bearer Henry's OS uses), pasted once via
 * the panel prompt and kept in chrome.storage.LOCAL — this machine only,
 * never synced. It grants read of the roster/attendance chef already holds;
 * the extension handles the same data class (student IINs) everywhere else.
 * The token is only persisted after a fetch with it SUCCEEDS.
 */

const DEFAULT_CHEF_URL = 'https://pccorch.onrender.com';
const TOKEN_KEY = 'pars.cheftoken';
const URL_KEY = 'pars.chefurl'; // optional override, set via chrome.storage if chef ever moves

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'chef-pars') return;
  (async () => {
    try {
      const store = await chrome.storage.local.get([TOKEN_KEY, URL_KEY]);
      const token = (msg.token || store[TOKEN_KEY] || '').trim();
      const base = String(store[URL_KEY] || DEFAULT_CHEF_URL).replace(/\/+$/, '');
      if (!token) { sendResponse({ needsToken: true }); return; }
      const q = new URLSearchParams({
        ensemble: 'pcc-orchestra',
        from: msg.date, to: msg.date,
        full_minutes: String(msg.fullMinutes || ''),
      });
      const res = await fetch(`${base}/api/runner/pars?${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { sendResponse({ needsToken: true, badToken: true }); return; }
      if (!res.ok) { sendResponse({ error: body.error || `HTTP ${res.status}` }); return; }
      if (msg.token) await chrome.storage.local.set({ [TOKEN_KEY]: token });
      sendResponse({ ok: true, rows: body.rows || [], fullMinutes: body.full_minutes });
    } catch (e) {
      sendResponse({ error: `network: ${(e && e.message) || e}` });
    }
  })();
  return true; // keep the message channel open for the async response
});
