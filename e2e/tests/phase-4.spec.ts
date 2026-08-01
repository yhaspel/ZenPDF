import { expect, test } from '@playwright/test';
import path from 'node:path';

import { FIXTURES, registerAndLogin, uploadFiles } from './helpers';

/**
 * Phase 4 — content editing (phase-04 "Tests → E2E").
 *
 * Edit a paragraph → save → text visibly changed → find & replace 1 of 3
 * matches → add page numbers → set title metadata → all versions labeled and
 * revertible.
 */

// The overlay renders a full page; the default 720 px viewport cannot reach the
// lower half of it (see phase-3.spec.ts).
test.use({ viewport: { width: 1440, height: 1100 } });

function successToast(page: import('@playwright/test').Page, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

async function openEditMode(page: import('@playwright/test').Page) {
  await page.click('[data-test=edit-toggle]');
  await expect(page.locator('[data-test=edit-mode]')).toBeVisible();
  await expect(page.locator('[data-test=page-overlay]')).toBeVisible({ timeout: 30_000 });
  // Wait for the page raster: interacting before it lands means clicking at
  // coordinates whose content is not there yet.
  await expect(page.locator('[data-test=page-overlay] img')).toBeVisible({
    timeout: 30_000,
  });
}

test('phase 4: edit a paragraph, replace text, stamp numbers, set metadata', async ({
  page,
}) => {
  await registerAndLogin(page, 'p4');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  await openEditMode(page);

  // --- 1. Click a text block and rewrite it. ---
  // Blocks are outlined on the overlay; clicking one opens the inline editor.
  await page.locator('[data-test=overlay-item]').first().click();
  const editor = page.locator('[data-test=block-editor-input]');
  await expect(editor).toBeVisible();
  await editor.fill('Rewritten by the editor');
  await page.click('[data-test=block-editor-ok]');

  await expect(page.locator('[data-test=edit-save]')).toContainText('1 change');
  await page.click('[data-test=edit-save]');
  await expect(successToast(page, 'Text updated')).toBeVisible({ timeout: 60_000 });

  // The change is in the file, not just on screen. Asserted by searching the
  // saved document rather than by re-opening "the first block": redact-and-
  // reinsert appends the replacement as a new block, so block order after an
  // edit is not the order before it.
  await page.fill('[data-test=replace-find-input]', 'Rewritten by the editor');
  await page.click('[data-test=find-preview]');
  await expect(page.locator('[data-test=replace-count]')).toContainText('1 match', {
    timeout: 60_000,
  });

  // --- 2. Find & replace: preview, untick one, apply the rest. ---
  await page.fill('[data-test=replace-find-input]', 'quick');
  await page.fill('[data-test=replace-input]', 'rapid');
  await page.click('[data-test=find-preview]');
  // text.pdf says "The quick brown fox…" once per page, so exactly 3. Asserting
  // the number (rather than reading whatever is on screen) is what makes this
  // wait for the *new* report instead of counting the previous one's rows.
  const matches = page.locator('[data-test=replace-match]');
  await expect(matches).toHaveCount(3, { timeout: 60_000 });

  // Untick one — the review step exists precisely so this is possible.
  await matches.first().locator('[data-test=replace-toggle]').uncheck();
  await expect(page.locator('[data-test=replace-apply]')).toContainText('Replace 2 match');
  await page.click('[data-test=replace-apply]');
  await expect(successToast(page, 'Replaced')).toBeVisible({ timeout: 60_000 });

  // --- 3. Page numbers, honouring skip-first. ---
  await page.click('[data-test=tab-stamps]');
  await page.fill('[data-test=pn-format]', 'Page {page} of {total}');
  await page.click('[data-test=pn-apply]');
  await expect(successToast(page, 'Page numbers added')).toBeVisible({ timeout: 60_000 });

  // --- 4. Metadata. ---
  await page.click('[data-test=tab-info]');
  await page.fill('[data-test=meta-title]', 'Quarterly report');
  await page.fill('[data-test=meta-author]', 'E2E Tester');
  await page.click('[data-test=meta-apply]');
  await expect(successToast(page, 'Metadata updated')).toBeVisible({ timeout: 60_000 });

  // --- 5. Every step is a labeled, revertible version. ---
  await page.click('[data-test=edit-toggle]');
  await page.click('[data-test=tab-history]');
  const versions = page.locator('[data-test=version-row]');
  // Original, Edited text, Replaced, Page numbers, Metadata.
  await expect(versions).toHaveCount(5);
  await expect(versions.nth(0)).toContainText('Metadata updated');
  await expect(versions.nth(1)).toContainText('Page numbers');
  await expect(versions.nth(2)).toContainText('Replaced');
  await expect(versions.nth(3)).toContainText('Edited text');
  await expect(page.locator('[data-test=revert]').first()).toBeVisible();
});

test('phase 4: the scanned-page gate blocks the editor and offers OCR', async ({ page }) => {
  await registerAndLogin(page, 'p4scan');
  await uploadFiles(page, ['scanned.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await openEditMode(page);

  const gate = page.locator('[data-test=scanned-gate]');
  await expect(gate).toBeVisible({ timeout: 30_000 });
  await expect(gate).toContainText('This page is a scan');

  // The CTA ships disabled until Phase 6 lands OCR — with a tooltip that says so.
  const cta = page.locator('[data-test=scanned-ocr-cta]');
  await expect(cta).toBeDisabled();
  await expect(cta).toHaveAttribute('title', 'coming with OCR tool');
});

test('phase 4: whiteout states plainly that it is not redaction', async ({ page }) => {
  await registerAndLogin(page, 'p4white');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await openEditMode(page);

  await page.click('[data-test=mode-whiteout]');
  const note = page.locator('[data-test=whiteout-note]');
  await expect(note).toBeVisible();
  await expect(note).toContainText('hides');
  await expect(note).toContainText('Redact');
});

test('phase 4: a guest watermarks from the public tool page with no login prompt', async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto('/watermark-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Add a watermark to a PDF');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page.locator('[data-test=tool-result]')).toBeVisible({ timeout: 60_000 });

  const download = page.waitForEvent('download');
  await page.click('[data-test=tool-download]');
  expect((await download).suggestedFilename()).toContain('.pdf');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 4: a guest adds page numbers from the public tool page', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/add-page-numbers');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Add page numbers to a PDF');

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page.locator('[data-test=tool-result]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 4: /edit-pdf hands a guest straight into the editor', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/edit-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Edit a PDF');

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page).toHaveURL(/\/app\/doc\/.*mode=edit/, { timeout: 60_000 });
  await expect(page.locator('[data-test=edit-mode]')).toBeVisible();
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});
