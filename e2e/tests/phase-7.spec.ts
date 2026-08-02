import { expect, test } from '@playwright/test';
import path from 'node:path';

import { FIXTURES, registerAndLogin, uploadFiles } from './helpers';

/**
 * Phase 7 — security and redaction (phase-07 "Tests → E2E").
 *
 * Protect a document → reopen it (password prompt) → unlock → redact every
 * email address via the preset (review shows 3, untick 1, apply 2) → download
 * → prove the text is gone → sanitize a booby-trapped file. Plus the guest
 * paths through the three new tool pages.
 */

test.use({ viewport: { width: 1440, height: 1100 } });

type PWPage = import('@playwright/test').Page;

function successToast(page: PWPage, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

async function openDoc(page: PWPage) {
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);
}

async function openProtect(page: PWPage) {
  await page.click('[data-test=protect-toggle]');
  await expect(page.locator('[data-test=protect-mode]')).toBeVisible();
}

test('phase 7: protect a document, reopen it, unlock it, then work on it', async ({ page }) => {
  test.setTimeout(180_000);
  await registerAndLogin(page, 'p7');
  await uploadFiles(page, ['text.pdf']);
  await openDoc(page);

  // --- 1. Protect: owner password, open password, restrictions. ---
  await openProtect(page);
  await page.fill('[data-test=owner-password]', 'owner-key-9999');
  await expect(page.locator('[data-test=strength]')).toContainText('Strong');
  await page.fill('[data-test=user-password]', 'open-sesame-42');
  await page.fill('[data-test=confirm-password]', 'open-sesame-4');
  await expect(page.locator('[data-test=mismatch]')).toBeVisible();
  await page.fill('[data-test=confirm-password]', 'open-sesame-42');
  await expect(page.locator('[data-test=mismatch]')).toHaveCount(0);

  await page.selectOption('[data-test=perm-print]', 'none');
  await page.uncheck('[data-test=perm-copy]');
  await page.click('[data-test=apply-protection]');
  await expect(successToast(page, 'Document protected')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=encrypted-banner]')).toBeVisible({ timeout: 60_000 });

  // --- 2. Reopen it: the session password is in memory, so a reload asks. ---
  await page.reload();
  await expect(page.locator('[data-test=pdf-password]')).toBeVisible({ timeout: 60_000 });
  await page.fill('[data-test=pdf-password]', 'open-sesame-42');
  await page.click('[data-test=pdf-password-submit]');

  // --- 3. Remove the password entirely, with the session password. ---
  await expect(page.locator('[data-test=encrypted-banner]')).toContainText('Unlocked');
  await openProtect(page);
  await page.fill('[data-test=unlock-password]', 'open-sesame-42');
  await page.click('[data-test=remove-password]');
  await expect(successToast(page, 'Password removed')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=encrypted-banner]')).toHaveCount(0, { timeout: 60_000 });
});

test('phase 7: editing an unlocked document says the password came off', async ({ page }) => {
  test.setTimeout(180_000);
  await registerAndLogin(page, 'p7edit');
  await uploadFiles(page, ['text.pdf']);
  await openDoc(page);

  await openProtect(page);
  await page.fill('[data-test=owner-password]', 'owner-key-9999');
  await page.fill('[data-test=user-password]', 'open-sesame-42');
  await page.fill('[data-test=confirm-password]', 'open-sesame-42');
  await page.click('[data-test=apply-protection]');
  await expect(successToast(page, 'Document protected')).toBeVisible({ timeout: 60_000 });

  // The banner says what is about to happen *before* it happens.
  const banner = page.locator('[data-test=encrypted-banner]');
  await expect(banner).toContainText('Editing it removes the password', { timeout: 60_000 });

  // An ordinary operation runs with the session password — nothing re-prompts.
  await page.click('[data-test=protect-toggle]');
  await page.click('[data-test=organize-toggle]');
  await page.locator('[data-test=organize-page]').first().click();
  await page.click('[data-test=op-rotate]');
  await expect(successToast(page, 'Rotated')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=pdf-password]')).toHaveCount(0);

  // …and the history records that the protection came off, rather than the
  // document quietly ceasing to be protected.
  await expect(banner).toHaveCount(0, { timeout: 60_000 });
  await page.click('[data-test=organize-toggle]');
  await page.click('[data-test=tab-history]');
  await expect(page.locator('[data-test=version-row]').first()).toContainText(
    'password removed',
  );
});

test('phase 7: redact every email but one, and prove the text is gone', async ({ page }) => {
  test.setTimeout(180_000);
  await registerAndLogin(page, 'p7redact');
  await uploadFiles(page, ['pii.pdf']);
  await openDoc(page);

  await openProtect(page);
  await page.click('[data-test=tab-redact]');

  // --- 1. Review before removing: three matches, one unticked. ---
  await page.click('[data-test=preset-email]');
  await page.click('[data-test=redact-preview]');
  const review = page.locator('[data-test=redact-review]');
  await expect(review).toBeVisible({ timeout: 60_000 });
  await expect(review.locator('[data-test=match-row]')).toHaveCount(3);
  await expect(review).toContainText('3 selected');
  await review.locator('input[type=checkbox]').nth(1).uncheck();
  await expect(review).toContainText('2 selected');

  // --- 2. Apply: irreversible, so it asks for the document's name. ---
  await page.click('[data-test=apply-redaction]');
  await expect(page.locator('[data-test=confirm-host]')).toBeVisible();
  await expect(page.locator('[data-test=confirm-ok]')).toBeDisabled();
  await page.fill('[data-test=confirm-text]', 'pii');
  await page.click('[data-test=confirm-ok]');

  // --- 3. The clean copy is a new document, with no history to leak. ---
  await expect(successToast(page, 'Removed')).toBeVisible({ timeout: 120_000 });
  await expect(page).toHaveURL(/\/app\/doc\//);
  await expect(page.locator('[data-test=doc-title]')).toContainText('(redacted)', {
    timeout: 60_000,
  });
  await page.click('[data-test=tab-history]');
  await expect(page.locator('[data-test=version-row]')).toHaveCount(1);

  // --- 4. The removed text is genuinely not findable; the kept one is. ---
  await page.click('[data-test=tab-thumbs]');
  await page.fill('[data-test=find-input]', 'dana.cohen');
  await page.click('[data-test=find-btn]');
  await expect(page.locator('[data-test=find-count]')).toHaveText('0 result(s)', {
    timeout: 60_000,
  });
  await page.fill('[data-test=find-input]', 'r.levi');
  await page.click('[data-test=find-btn]');
  await expect(page.locator('[data-test=find-count]')).toHaveText('1 result(s)');

  // --- 5. And it downloads. ---
  const download = page.waitForEvent('download');
  await page.click('[data-test=download]');
  expect((await download).suggestedFilename()).toContain('.pdf');
});

test('phase 7: sanitize reports what it actually removed', async ({ page }) => {
  test.setTimeout(120_000);
  await registerAndLogin(page, 'p7clean');
  await uploadFiles(page, ['booby-trapped.pdf']);
  await openDoc(page);

  await openProtect(page);
  await page.click('[data-test=tab-sanitize]');
  await page.check('[data-test=sanitize-links_external]');
  await page.click('[data-test=apply-sanitize]');

  // The toast is a report, not a reassurance: a user about to send a contract
  // wants to know it *had* a script in it.
  const toast = successToast(page, 'Removed');
  await expect(toast).toBeVisible({ timeout: 60_000 });
  await expect(toast).toContainText('script');
  await expect(toast).toContainText('attachment');
  await expect(toast).toContainText('outbound link');
});

test('phase 7: a guest protects a PDF from /protect-pdf with no login prompt', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.context().clearCookies();
  await page.goto('/protect-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Password-protect a PDF');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page).toHaveURL(/\/app\/doc\/.*mode=protect/, { timeout: 60_000 });
  await expect(page.locator('[data-test=protect-mode]')).toBeVisible();

  await page.fill('[data-test=owner-password]', 'guest-owner-key');
  await page.click('[data-test=apply-protection]');
  await expect(successToast(page, 'Document protected')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 7: a guest redacts from /redact-pdf, landing on the redact tab', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.context().clearCookies();
  await page.goto('/redact-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Redact a PDF');

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'pii.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page).toHaveURL(/\/app\/doc\/.*tab=redact/, { timeout: 60_000 });
  await expect(page.locator('[data-test=redact-preview]')).toBeVisible();

  await page.click('[data-test=preset-ssn]');
  await page.click('[data-test=redact-preview]');
  await expect(page.locator('[data-test=redact-review]')).toContainText('1 match', {
    timeout: 60_000,
  });
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 7: the three new tool pages are reachable and self-describing', async ({
  page,
}) => {
  const pages: [string, string][] = [
    ['/protect-pdf', 'Password-protect a PDF'],
    ['/unlock-pdf', 'Remove a password from a PDF'],
    ['/redact-pdf', 'Redact a PDF'],
  ];
  await page.context().clearCookies();
  for (const [url, h1] of pages) {
    await page.goto(url);
    await expect(page.locator('[data-test=tool-h1]')).toHaveText(h1);
    await expect(page.locator('[data-test=dropzone]')).toBeVisible();
    await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
  }
});
