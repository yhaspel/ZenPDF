/**
 * ZenPDF's service worker: Angular's (`ngsw-worker.js`), with the API and every
 * other origin taken out of its hands.
 *
 * Angular's worker answers every fetch the page makes, and one it has nothing
 * cached for it re-issues itself. For ZenPDF that is all cost:
 *
 *   - `/api/` is per-user and is never cached (ngsw-config.json has no
 *     `dataGroups`, deliberately), so the worker could only ever pass it on —
 *     including 120 MB uploads and pdf.js's ranged document reads, each held
 *     open inside a worker event for as long as it takes.
 *   - A request the worker re-issues is governed by *this script's* CSP, whose
 *     `connect-src` is `'self'`. Every cross-origin request the page itself is
 *     allowed to make — the ad hosts the day ads are switched on — would be
 *     refused once it came from here instead.
 *
 * Registered before Angular's listener, this one ends the event for those
 * requests without answering it, so the browser performs them exactly as it
 * would with no worker installed. Everything else — the shell, the hashed
 * chunks, fonts, icons, pdf.js assets — is Angular's.
 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) {
    event.stopImmediatePropagation();
  }
});

importScripts('./ngsw-worker.js');
