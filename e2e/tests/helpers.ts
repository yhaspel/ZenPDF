import { Page, expect } from '@playwright/test';
import path from 'node:path';

export const FIXTURES = path.resolve(__dirname, '../../backend/tests/fixtures/pdfs');
/** The one fixture that is deliberately not a PDF (phase-06 image import). */
export const IMAGES = path.resolve(__dirname, '../../backend/tests/fixtures/images');

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


export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** The most recent message to `address`, with its plain-text body. */
export async function mailFor(
  address: string,
): Promise<{ subject: string; body: string }> {
  const { request } = await import('@playwright/test');
  const api = await request.newContext();
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const list = await api.get(
        `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
      const body = await list.json();
      if (body.messages?.length) {
        const detail = await api.get(`${MAILPIT}/api/v1/message/${body.messages[0].ID}`);
        const message = await detail.json();
        return { subject: body.messages[0].Subject, body: message.Text ?? '' };
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`no mail arrived for ${address}`);
  } finally {
    await api.dispose();
  }
}

/**
 * Confirm the signed-in account's address through Mailpit (phase-09 §9B).
 *
 * Sending a document for signature requires a verified sender — mail goes out
 * in that person's name — so any spec that *sends* has to do this first. It
 * gates nothing else: uploading and every tool work unverified.
 */
export async function verifyEmail(page: Page, email: string): Promise<void> {
  await page.goto('/app/settings');
  await page.click('[data-test=resend-verification]');
  const message = await mailFor(email);
  const link = /https?:\/\/[^\s]+\/verify-email\/[^\s]+/.exec(message.body);
  if (!link) throw new Error(`no verification link in: ${message.body.slice(0, 200)}`);
  await page.goto(link[0]);
  await expect(page.locator('[data-test=verified]')).toBeVisible({ timeout: 60_000 });
}

/** Register, log in and confirm the address — for specs that send mail. */
export async function registerVerifiedAndLogin(
  page: Page, prefix = 'user',
): Promise<string> {
  const email = await registerAndLogin(page, prefix);
  await verifyEmail(page, email);
  await page.goto('/app/dashboard');
  return email;
}
