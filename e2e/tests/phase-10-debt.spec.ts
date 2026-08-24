import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { registerAndLogin, uploadFiles } from './helpers';

/**
 * The two product bugs the phase-10 debt review found (§10.2).
 *
 * Both are about what happens past the first screenful: a library bigger than
 * one page, and a document longer than one viewport of thumbnails.
 */
test('phase 10: a library larger than one page can be read to the end', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await registerAndLogin(page, 'p10pager');

  // 62 documents: past DRF's PAGE_SIZE of 50, with a remainder small enough
  // that a second "Load more" must *not* appear. Seeded through the API with
  // a real fixture — a hand-built PDF string is refused by validation, which
  // is the ingest chain doing its job.
  const token = await page.evaluate(() => localStorage.getItem('zen_access') ?? '');
  const pdf = readFileSync(
    path.resolve(__dirname, '../../backend/tests/fixtures/pdfs/text.pdf'),
  );
  for (let i = 0; i < 62; i++) {
    const res = await page.request.post('/api/documents/', {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: `pager-${i}.pdf`, mimeType: 'application/pdf', buffer: pdf },
        title: `Pager ${String(i).padStart(3, '0')}`,
      },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  await page.goto('/app/dashboard');
  await expect(page.locator('[data-test=doc-count]')).toContainText('of 62', {
    timeout: 60_000,
  });
  // One page, and the honest count beside it — the bug was that this was the
  // whole library as far as the UI was concerned.
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(50);
  await expect(page.locator('[data-test=doc-count]')).toContainText('Showing 50');

  await page.click('[data-test=load-more]');
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(62, {
    timeout: 60_000,
  });
  await expect(page.locator('[data-test=doc-count]')).toContainText('Showing 62 of 62');
  // …and it stops offering more when there is none.
  await expect(page.locator('[data-test=load-more]')).toHaveCount(0);
});

test('phase 10: a long document does not fetch every thumbnail at once', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await registerAndLogin(page, 'p10thumbs');
  await uploadFiles(page, ['large-generated.pdf']);
  await expect(page.locator('[data-test=doc-card]').first()).toBeVisible({
    timeout: 60_000,
  });

  const thumbnailRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/thumbnail/')) thumbnailRequests.push(req.url());
  });

  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);
  await expect(page.locator('[data-test=rail-thumb]').first()).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);

  const rendered = await page.locator('[data-test=rail-thumb]').count();
  // The assertion is the *ratio*, not a count: however many pages the rail
  // holds, only the ones near the viewport may have been fetched. Every tile
  // used to fire its own authed GET on construction, which past 120 of them
  // is a 429 and a rail that never finishes arriving.
  expect(rendered).toBeGreaterThan(10);
  expect(thumbnailRequests.length).toBeLessThan(rendered);
});

/**
 * …and when it *is* refused, it waits rather than giving up (2026-08-23).
 *
 * The other half of L9. Lazy loading made the 429 rarer; it did not make it
 * impossible — a guest gets 40 requests a minute — and until now the first
 * refusal put a tile straight into its failed state. A rail that met the limit
 * became a wall of retry buttons, which is a manual backoff performed by the
 * person.
 *
 * The refusal is injected here rather than by lowering `THROTTLE_GUEST`: the
 * dev-env route needs the api container restarted, and what is under test is
 * what the tile does with a 429, not that the server can produce one — which
 * `test_throttling.py` already proves.
 */
test('phase 10: a throttled rail waits and fills, rather than showing a wall of retries',
  async ({ page }) => {
    test.setTimeout(300_000);
    await registerAndLogin(page, 'p10backoff');
    await uploadFiles(page, ['large-generated.pdf']);
    await expect(page.locator('[data-test=doc-card]').first()).toBeVisible({
      timeout: 60_000,
    });

    // Two refusals per tile, then through: inside the four attempts a tile is
    // allowed, so every one of them must arrive without anybody clicking.
    const refused = new Map<string, number>();
    await page.route('**/thumbnail/**', async (route) => {
      const url = route.request().url();
      const seen = refused.get(url) ?? 0;
      if (seen < 2) {
        refused.set(url, seen + 1);
        await route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1', 'content-type': 'application/json' },
          body: JSON.stringify({ error: { code: 'throttled', message: 'Slow down.' } }),
        });
        return;
      }
      await route.continue();
    });

    await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
    await expect(page).toHaveURL(/\/app\/doc\//);
    await expect(page.locator('[data-test=rail-thumb]').first()).toBeVisible({
      timeout: 60_000,
    });

    // Refused, and still in its loading state — the distinction is the fix.
    await expect(page.locator('[data-test=thumb-failed]')).toHaveCount(0);
    await expect(page.locator('[data-test=thumb-loading]').first()).toBeVisible();

    // It arrives on its own.
    await expect(page.locator('[data-test=rail-thumb] img').first()).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(3000);

    expect(refused.size).toBeGreaterThan(1);
    await expect(page.locator('[data-test=thumb-failed]')).toHaveCount(0);
  });
test('phase 10: a server blip does not log you out', async ({ page }) => {
  test.setTimeout(180_000);
  // `AuthFacade.loadUser` used to end the session on **any** error from
  // `/api/users/me/`, not just a rejected credential. So a 500 from a busy box,
  // a 429, or a request aborted because somebody clicked a link while it was in
  // flight silently deleted `zen_access` and `zen_refresh` — and the next
  // guarded route bounced to `/auth/register` wearing a stranger's chrome, with
  // no sign-out anywhere.
  //
  // It was found as an intermittent e2e failure that looked like three
  // different flakes: `uploadFiles` timing out on `[data-test=file-input]`, ~1
  // in 3 on a loaded machine. A probe trapping every write to `zen_*` caught
  // `TokenService.clear` under `AuthFacade.clearSession` under that error
  // callback, on a run where four unrelated endpoints were answering 500.
  //
  // Induced here rather than waited for: one 500 on the *next* `/users/me/`,
  // which is deterministic and fails on the unfixed build.
  await registerAndLogin(page, 'p10blip');

  let blipped = false;
  await page.route('**/api/users/me/', async (route) => {
    if (blipped) return route.continue();
    blipped = true;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
  });

  // A fresh load, so `loadUser()` runs and meets the 500.
  await page.goto('/app/settings');
  await expect(page.locator('[data-test=nav-email]')).toBeVisible();
  expect(blipped, 'the 500 never fired, so this asserts nothing').toBe(true);

  const stored = await page.evaluate(() => ({
    access: !!localStorage.getItem('zen_access'),
    refresh: !!localStorage.getItem('zen_refresh'),
  }));
  expect(stored, 'a 500 from /users/me must not end the session').toEqual({
    access: true, refresh: true,
  });

  // And the session is still usable: a guarded route renders instead of
  // bouncing to the register page.
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/app\/dashboard/);
  await expect(page.locator('[data-test=file-input]')).toHaveCount(1);
});
