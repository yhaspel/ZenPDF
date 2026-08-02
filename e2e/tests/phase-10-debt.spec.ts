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
