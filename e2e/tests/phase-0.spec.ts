import { expect, test } from '@playwright/test';

import { uniqueEmail } from './helpers';

test('phase 0: register, login, session guard', async ({ page }) => {
  const email = uniqueEmail('p0');

  // Register → lands on dashboard
  await page.goto('/auth/register');
  await page.fill('[data-test=name]', 'Zero');
  await page.fill('[data-test=email]', email);
  await page.fill('[data-test=password]', 'strongpass123');
  await page.click('[data-test=submit]');
  await expect(page).toHaveURL(/\/app\/dashboard/);

  // Demo job → toast (proves async pipeline)
  await page.click('[data-test=demo-job]');
  await expect(page.locator('[data-test=toast-success]')).toBeVisible();

  // Logout → login page; guard blocks /app
  await page.click('[data-test=logout]');
  await expect(page).toHaveURL(/\/auth\/login/);
  await page.goto('/app/dashboard');
  await expect(page).toHaveURL(/\/auth\/login/);

  // Log back in
  await page.fill('[data-test=email]', email);
  await page.fill('[data-test=password]', 'strongpass123');
  await page.click('[data-test=submit]');
  await expect(page).toHaveURL(/\/app\/dashboard/);
});
