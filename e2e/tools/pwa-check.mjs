/**
 * Is ZenPDF installable, as Chrome itself judges it? (design contract §5)
 *
 * Loads the site in Chromium, waits for the service worker to activate, and
 * asks Chrome over CDP for the parsed manifest and its installability errors.
 * Exit 0 only for an active worker, no manifest errors and no installability
 * errors. It needs a production build — the worker is off under `ng serve`.
 *
 *   node tools/pwa-check.mjs http://localhost:3100            # local build behind nginx
 *   node tools/pwa-check.mjs https://zenpdf.up.railway.app    # production
 *
 * What it cannot see is the install icon in the address bar:
 * `beforeinstallprompt` never fires under automation. With both error lists
 * empty that is not a defect — confirm the icon in a real Chrome profile
 * instead of editing the manifest to chase it.
 */
import { chromium } from '@playwright/test';

const base = process.argv[2]?.replace(/\/$/, '');
if (!base) {
  console.error('usage: node tools/pwa-check.mjs <baseUrl>');
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console.error:', m.text());
});

// `load`, not `networkidle`: the app talks to /api from the first paint, and
// behind a local nginx with no API those requests hang rather than fail.
await page.goto(`${base}/`, { waitUntil: 'load' });
// `registerWhenStable:30000` can hold registration back for up to 30 s.
const sw = await page.evaluate(() =>
  Promise.race([
    navigator.serviceWorker.ready.then((r) => ({
      scope: r.scope,
      state: r.active?.state,
      script: r.active?.scriptURL,
    })),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('service worker not active within 45s')), 45_000),
    ),
  ]),
);
const cdp = await context.newCDPSession(page);
const manifest = await cdp.send('Page.getAppManifest');
const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
console.log(
  JSON.stringify(
    { sw, manifestUrl: manifest.url, manifestErrors: manifest.errors, installabilityErrors },
    null,
    2,
  ),
);
await browser.close();

const ok =
  ['activating', 'activated'].includes(sw.state) &&
  manifest.errors.length === 0 &&
  installabilityErrors.length === 0;
process.exit(ok ? 0 : 1);
