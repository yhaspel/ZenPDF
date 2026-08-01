import { expect, test } from '@playwright/test';
import path from 'node:path';

import { FIXTURES, uniqueEmail } from './helpers';

/**
 * Phase 2B — the whole product with no account (01-architecture.md §21).
 *
 * Cold browser, no storage state: land on a public tool page, merge two PDFs,
 * download the result, continue into the workspace, rotate a page, register,
 * and watch the work follow you into the new account — then log out and back in
 * and find it still there.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test('phase 2b: guest merges, works, registers and keeps the files', async ({ page }) => {
  // --- 1. A cold visitor lands on the tool page. No login prompt anywhere. ---
  await page.goto('/merge-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Merge PDF files');
  await expect(page.locator('[data-test=tool-widget]')).toBeVisible();
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
  await expect(page.locator('[data-test=register-form]')).toHaveCount(0);
  // Nothing is minted by merely looking at the page (§21.2).
  expect(await page.evaluate(() => localStorage.getItem('zen_guest'))).toBeNull();

  // --- 2. Drop two PDFs and merge. ---
  await page.locator('[data-test=file-input]').setInputFiles([
    path.join(FIXTURES, 'text.pdf'),
    path.join(FIXTURES, 'unicode.pdf'),
  ]);
  await expect(page.locator('[data-test=picked-list] li')).toHaveCount(2);
  await page.click('[data-test=tool-run]');

  await expect(page.locator('[data-test=tool-result]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=result-title]')).toContainText('Merged');
  // The first write minted a guest session and the client kept the token.
  expect(await page.evaluate(() => localStorage.getItem('zen_guest'))).toBeTruthy();
  // Value delivered → the signup prompt is allowed to appear (§21.5).
  await expect(page.locator('[data-test=tool-upsell]')).toBeVisible();

  // --- 3. Download the merged file in place. ---
  const download = page.waitForEvent('download');
  await page.click('[data-test=tool-download]');
  expect((await download).suggestedFilename()).toContain('.pdf');

  // --- 4. Continue into the workspace as a guest and rotate a page. ---
  await page.click('[data-test=tool-open-workspace]');
  await expect(page).toHaveURL(/\/app\/doc\//);
  // /app/doc/:id renders for a guest — no redirect to a login form.
  await expect(page.locator('[data-test=guest-banner]')).toBeVisible();
  await expect(page.locator('[data-test=guest-time-left]')).toContainText('left');

  await page.click('[data-test=organize-toggle]');
  await page.locator('[data-test=organize-page]').nth(0).click();
  await page.click('[data-test=op-rotate]');
  await expect(
    page.locator('[data-test=toast-success]').filter({ hasText: 'Rotated' }),
  ).toBeVisible();

  // --- 5. The account-only routes redirect, and say why. ---
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/auth\/register\?.*reason=library/);
  await expect(page.locator('[data-test=register-reason]')).toContainText('library');

  // --- 6. Register: the guest session is claimed inline. ---
  const email = uniqueEmail('p2b');
  await page.fill('[data-test=name]', 'Guest Turned User');
  await page.fill('[data-test=email]', email);
  await page.fill('[data-test=password]', 'strongpass123');
  await page.click('[data-test=submit]');

  await expect(page).toHaveURL(/\/app\/dashboard/, { timeout: 30_000 });
  // The payoff must be visible, not silent (§21.5).
  await expect(page.locator('[data-test=claim-banner]')).toBeVisible();
  // The claimed documents are in the new library: 2 uploads + 1 merged.
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(3);
  // The client discarded its guest token — writing into a claimed session would
  // let guest_purge delete a logged-in user's files (§21.5).
  expect(await page.evaluate(() => localStorage.getItem('zen_guest'))).toBeNull();

  // --- 7. Log out and back in: still there. ---
  await page.click('[data-test=logout]');
  await expect(page).toHaveURL(/\/auth\/login/);
  await page.fill('[data-test=email]', email);
  await page.fill('[data-test=password]', 'strongpass123');
  await page.click('[data-test=submit]');
  await expect(page).toHaveURL(/\/app\/dashboard/);
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(3);
});

test('phase 2b: every tool page is reachable and self-describing', async ({ page }) => {
  const slugs = [
    'merge-pdf',
    'split-pdf',
    'compress-pdf',
    'rotate-pdf',
    'delete-pdf-pages',
    'extract-pdf-pages',
    'organize-pdf',
  ];
  const titles = new Set<string>();
  for (const slug of slugs) {
    await page.goto(`/${slug}`);
    await expect(page.locator('[data-test=tool-h1]')).toBeVisible();
    await expect(page.locator('[data-test=tool-widget]')).toBeVisible();
    await expect(page.locator('[data-test=faq-item]').first()).toBeVisible();
    titles.add(await page.title());
  }
  expect(titles.size).toBe(slugs.length);

  // Generated from the route table, and crawl rules match §21.6.
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  for (const slug of slugs) {
    expect(xml).toContain(`/${slug}<`);
  }
  const robots = await (await page.request.get('/robots.txt')).text();
  expect(robots).toContain('Disallow: /app/');
  expect(robots).toContain('Disallow: /s/');
  expect(robots).toContain('Disallow: /api/');
});

test('phase 2b: a guest completes split end-to-end with no login prompt', async ({ page }) => {
  await page.goto('/split-pdf');
  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page.locator('[data-test=tool-result]')).toBeVisible({ timeout: 60_000 });
  // text.pdf is 3 pages → 3 documents.
  await expect(page.locator('[data-test=result-title]')).toHaveCount(3);
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});
