import { expect, test } from '@playwright/test';

import { uniqueEmail } from './helpers';

test('@smoke phase 0: register, login, session guard', async ({ page }) => {
  const email = uniqueEmail('p0');

  // Register → lands on dashboard
  await page.goto('/auth/register');
  await page.fill('[data-test=name]', 'Zero');
  await page.fill('[data-test=email]', email);
  await page.fill('[data-test=password]', 'strongpass123');
  // Required at signup, and unticked by default (§9A).
  await page.check('[data-test=accept-terms]');
  await page.click('[data-test=submit]');
  await expect(page).toHaveURL(/\/app\/dashboard/);

  // The "Run demo job" button that used to be clicked here is gone: its
  // endpoint was DEBUG-gated and 404ed in production, so the button was broken
  // for every real user. The async pipeline is exercised for real by the
  // page-operation specs.

  // Logout → login page.
  await page.click('[data-test=logout]');
  await expect(page).toHaveURL(/\/auth\/login/);

  // ⚠ Rewritten in Phase 2B — supersedes phase-00's "`/app/**` redirects
  // unauthenticated users". The app-wide guard is gone: only the three
  // account-only routes redirect, and a rejection routes to **register** with
  // a reason rendered as copy, never a bare login wall (§7, §21.3).
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/auth\/register\?.*reason=library/);
  await expect(page.locator('[data-test=register-reason]')).toBeVisible();

  // Log back in
  await page.goto('/auth/login');
  await page.fill('[data-test=email]', email);
  await page.fill('[data-test=password]', 'strongpass123');
  await page.click('[data-test=submit]');
  await expect(page).toHaveURL(/\/app\/dashboard/);
});

test('phase 0 (2B): /app/doc/:id is NOT gated — it renders for a guest', async ({ page }) => {
  // The other half of the superseded criterion: the workspace route must render
  // for either principal. A guest with no document lands on the workspace shell
  // rather than being bounced to a login form.
  await page.context().clearCookies();
  await page.goto('/app/doc/00000000-0000-0000-0000-000000000000');
  await expect(page).toHaveURL(/\/app\/doc\//);
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});
