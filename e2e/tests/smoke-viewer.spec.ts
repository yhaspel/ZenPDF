import path from 'node:path';

import { expect, test } from '@playwright/test';

import { expectPageDrew } from './drew';
import { FIXTURES } from './helpers';

/**
 * The deploy gate for the one defect that hid for ten days.
 *
 * `/app/doc/:id` rendered nothing in production between 2026-08-10 and
 * 2026-08-20 while the local stack was fine, because both blockers were
 * production-only: `script-src 'self'` refused the viewer's feature-detection
 * `<script>`, and nginx served pdf.js's `.mjs` modules as
 * `application/octet-stream`, which `nosniff` makes fatal for a module script.
 * Neither can be reproduced by a test that stops at "the request returned 200",
 * and neither can survive this spec.
 *
 * It is written to run **unchanged against production**:
 * `BASE_URL=https://zenpdf.up.railway.app npx playwright test -g "smoke-viewer"`.
 * That constrains it — no Mailpit, no account, one upload, nothing that leaves
 * anything behind but a guest document that expires on its own. It runs in its
 * own browser context so the 40-requests-per-minute guest throttle is not
 * shared with whatever else the suite is doing.
 */
test('@smoke smoke-viewer: a cold guest opens a PDF and the page draws', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  /**
   * Every viewer module the page pulls, and what the server called it.
   *
   * This is the assertion that would have failed on 2026-08-10 and did not
   * exist: `viewer-*.min.mjs` and `pdf.worker-*.min.mjs` answered 200 with
   * `application/octet-stream` — stock `mime.types` knows neither `.mjs` nor
   * `.wasm` — which `nosniff` makes fatal for a module script. The request log
   * looked perfect and the browser refused every one of them.
   *
   * Scoped to `/assets/`, which is where the library's own modules live and
   * exactly what the nginx fix covers. The Angular dev server also emits `.mjs`
   * of its own (`/@fs/.../vite/dist/client/env.mjs`, with no content-type at
   * all), and asserting on those would fail locally for a reason production
   * does not have.
   */
  const moduleTypes = new Map<string, string>();
  page.on('response', (response) => {
    const url = response.url();
    if (url.endsWith('.mjs') && url.includes('/assets/')) {
      moduleTypes.set(url, response.headers()['content-type'] ?? '');
    }
  });

  try {
    await page.goto('/annotate-pdf');
    await expect(page.locator('[data-test=tool-h1]')).toHaveText('Annotate a PDF');
    // Anonymous-first is a product law (§21): nothing may ask a guest to log in.
    await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

    await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
    await page.click('[data-test=tool-run]');
    await expect(page).toHaveURL(/\/app\/doc\/.*mode=annotate/, { timeout: 90_000 });

    // Into the reading view, which is the surface that was broken.
    const docId = /\/app\/doc\/([^/?]+)/.exec(page.url())![1];
    await page.goto(`/app/doc/${docId}?mode=view`);

    const sample = await expectPageDrew(page);
    // Recorded in the run log so a green result carries its own evidence.
    console.log(
      `smoke-viewer: canvas ${sample.width}×${sample.height}, `
        + `${sample.colours} distinct colours`,
    );

    expect(moduleTypes.size, 'the viewer pulled no .mjs modules at all').toBeGreaterThan(0);
    for (const [url, type] of moduleTypes) {
      expect(type, `${url} was served as ${type || '(no content-type)'}`).toContain(
        'text/javascript',
      );
    }
  } finally {
    await context.close();
  }
});
