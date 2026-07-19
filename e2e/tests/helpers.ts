import { Page, expect } from '@playwright/test';
import path from 'node:path';

export const FIXTURES = path.resolve(__dirname, '../../backend/tests/fixtures/pdfs');

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.local`;
}

/** Register a fresh account and land on the dashboard. Returns the email. */
export async function registerAndLogin(page: Page, prefix = 'user'): Promise<string> {
  const email = uniqueEmail(prefix);
  await page.goto('/auth/register');
  await page.fill('[data-test=name]', 'E2E Tester');
  await page.fill('[data-test=email]', email);
  await page.fill('[data-test=password]', 'strongpass123');
  await page.click('[data-test=submit]');
  await expect(page).toHaveURL(/\/app\/dashboard/);
  return email;
}

export async function uploadFiles(page: Page, names: string[]): Promise<void> {
  const paths = names.map((n) => path.join(FIXTURES, n));
  await page.locator('[data-test=file-input]').setInputFiles(paths);
}
