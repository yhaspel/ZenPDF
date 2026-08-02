import { expect, test } from '@playwright/test';
import path from 'node:path';

import { FIXTURES, IMAGES, registerAndLogin, uploadFiles } from './helpers';

/**
 * Phase 6 — OCR, conversion and compare (phase-06 "Tests → E2E").
 *
 * Upload a scan → OCR (progress) → select text in the viewer → export Word →
 * compare the original against the OCR'd copy → import a file that is not a
 * PDF. Plus the guest paths through the new tool pages.
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

test('phase 6: OCR a scan, then read, edit and export it', async ({ page }) => {
  test.setTimeout(180_000);
  await registerAndLogin(page, 'p6');
  await uploadFiles(page, ['scanned.pdf']);
  await openDoc(page);

  // --- 1. The editor refuses a scan, and offers the way out. ---
  await page.click('[data-test=edit-toggle]');
  const gate = page.locator('[data-test=scanned-gate]');
  await expect(gate).toBeVisible({ timeout: 30_000 });
  const cta = page.locator('[data-test=scanned-ocr-cta]');
  await expect(cta).toBeEnabled();          // Phase 4 shipped it disabled
  await cta.click();

  // --- 2. …which lands in the OCR panel. ---
  await expect(page.locator('[data-test=convert-mode]')).toBeVisible();
  await expect(page.locator('[data-test=ocr-lang-eng]')).toBeVisible();
  await page.click('[data-test=ocr-run]');
  await expect(successToast(page, 'Text recognised')).toBeVisible({ timeout: 120_000 });

  // --- 3. The text is really there: the editor now opens on it. ---
  await page.click('[data-test=convert-toggle]');   // leave convert mode
  await page.click('[data-test=edit-toggle]');
  await expect(page.locator('[data-test=scanned-gate]')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('[data-test=overlay-item]').first()).toBeVisible({
    timeout: 60_000,
  });

  // …and the document's own search finds a word that only OCR could have added.
  await page.click('[data-test=edit-toggle]');
  await page.fill('[data-test=find-input]', 'Scanned');
  await page.click('[data-test=find-btn]');
  await expect(page.locator('[data-test=find-count]')).not.toContainText('0 result', {
    timeout: 60_000,
  });

  // --- 4. Export it as Word. ---
  await page.click('[data-test=convert-toggle]');
  await page.click('[data-test=export-docx]');
  await expect(page.locator('[data-test=export-download]')).toBeVisible({ timeout: 120_000 });
  const download = page.waitForEvent('download');
  await page.click('[data-test=export-download]');
  expect((await download).suggestedFilename()).toBe('document.docx');
});

test('phase 6: compare two documents and click through the changes', async ({ page }) => {
  await registerAndLogin(page, 'p6cmp');
  await uploadFiles(page, ['compare-a.pdf', 'compare-b.pdf']);
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(2);
  await openDoc(page);

  await page.click('[data-test=compare-toggle]');
  await expect(page.locator('[data-test=compare-mode]')).toBeVisible();

  // Whichever of the pair was opened, the picker offers the other one — it
  // filters out the document being compared.
  await page.selectOption('[data-test=compare-other]', { index: 1 });
  await page.click('[data-test=compare-run]');
  await expect(page.locator('[data-test=compare-summary]')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-test=compare-summary]')).toContainText('differ');

  // The change list is populated and clicking an entry selects it.
  const changes = page.locator('[data-test=compare-change]');
  await expect(changes.first()).toBeVisible();
  const count = await changes.count();
  expect(count).toBeGreaterThan(0);
  await changes.first().click();

  // The visual filter shows the stamped box that has no text change at all.
  await page.click('[data-test=compare-view-visual]');
  await expect(page.locator('[data-test=compare-change]').first()).toBeVisible();
  await page.click('[data-test=compare-view-text]');
  await expect(page.locator('[data-test=compare-change]').first()).toBeVisible();
});

test('phase 6: importing a file that is not a PDF converts it', async ({ page }) => {
  await registerAndLogin(page, 'p6imp');

  // A PNG through the dashboard dropzone — the unified import path.
  await page.locator('[data-test=file-input]').setInputFiles(
    path.join(IMAGES, 'sample.png'),
  );
  await expect(successToast(page, 'Converted to PDF')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(1);
});

test('phase 6: the URL import refuses an address inside the network', async ({ page }) => {
  await registerAndLogin(page, 'p6ssrf');

  await page.fill('[data-test=import-url]', 'http://169.254.169.254/latest/meta-data/');
  await page.click('[data-test=import-url-btn]');
  await expect(page.locator('[data-test=toast-error]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(0);
});

test('phase 6: a guest OCRs a scan from /ocr-pdf with no login prompt', async ({ page }) => {
  test.setTimeout(180_000);
  await page.context().clearCookies();
  await page.goto('/ocr-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Make a scanned PDF searchable');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'scanned.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page.locator('[data-test=tool-result]')).toBeVisible({ timeout: 120_000 });

  const download = page.waitForEvent('download');
  await page.click('[data-test=tool-download]');
  expect((await download).suggestedFilename()).toContain('.pdf');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 6: a guest converts a PDF to Word from /pdf-to-word', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/pdf-to-word');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Convert PDF to Word');

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page.locator('[data-test=tool-result]')).toBeVisible({ timeout: 120_000 });

  const download = page.waitForEvent('download');
  await page.click('[data-test=tool-download-converted]');
  expect((await download).suggestedFilename()).toBe('document.docx');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 6: a guest turns an image into a PDF from /jpg-to-pdf', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/jpg-to-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Convert images to PDF');

  await page.locator('[data-test=file-input]').setInputFiles(
    path.join(IMAGES, 'sample.png'),
  );
  await page.click('[data-test=tool-run]');
  await expect(page.locator('[data-test=tool-result]')).toBeVisible({ timeout: 120_000 });

  const download = page.waitForEvent('download');
  await page.click('[data-test=tool-download]');
  expect((await download).suggestedFilename()).toContain('.pdf');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 6: every new tool page is reachable and self-describing', async ({ page }) => {
  const pages: [string, string][] = [
    ['/ocr-pdf', 'Make a scanned PDF searchable'],
    ['/pdf-to-word', 'Convert PDF to Word'],
    ['/word-to-pdf', 'Convert Word to PDF'],
    ['/jpg-to-pdf', 'Convert images to PDF'],
    ['/pdf-to-jpg', 'Convert PDF to images'],
    ['/html-to-pdf', 'Convert HTML to PDF'],
    ['/compare-pdf', 'Compare two PDFs'],
    ['/repair-pdf', 'Repair a damaged PDF'],
  ];
  await page.context().clearCookies();
  for (const [url, h1] of pages) {
    await page.goto(url);
    await expect(page.locator('[data-test=tool-h1]')).toHaveText(h1);
    await expect(page.locator('[data-test=dropzone]')).toBeVisible();
    await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
  }
});
