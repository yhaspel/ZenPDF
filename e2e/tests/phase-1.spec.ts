import { expect, test } from '@playwright/test';

import { registerAndLogin, uploadFiles } from './helpers';

test('@smoke phase 1: upload, view, search, rename, trash, restore', async ({ page }) => {
  await registerAndLogin(page, 'p1');

  // Upload two PDFs
  await uploadFiles(page, ['text.pdf', 'unicode.pdf']);
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(2);

  // Open the "text" document
  const textCard = page
    .locator('[data-test=doc-card]')
    .filter({ has: page.locator('[data-test=doc-title]', { hasText: 'text' }) });
  await textCard.locator('[data-test=open-doc]').click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  // Thumbnail rail loads; jump to a page
  await expect(page.locator('[data-test=rail-thumb]').first()).toBeVisible();
  await page.locator('[data-test=rail-thumb]').nth(1).click();

  // Server-side find → hit count
  await page.fill('[data-test=find-input]', 'ZenPDF');
  await page.click('[data-test=find-btn]');
  await expect(page.locator('[data-test=find-count]')).toContainText('result');

  // Rename in the workspace top bar
  await page.click('[data-test=doc-title]');
  await page.fill('[data-test=title-input]', 'Renamed Report');
  await page.press('[data-test=title-input]', 'Enter');
  await expect(page.locator('[data-test=doc-title]')).toHaveText('Renamed Report');

  // Back to library, trash the renamed doc
  await page.click('[data-test=back]');
  const renamed = page
    .locator('[data-test=doc-card]')
    .filter({ has: page.locator('[data-test=doc-title]', { hasText: 'Renamed Report' }) });
  await renamed.locator('[data-test=doc-menu]').click();
  await renamed.locator('[data-test=trash]').click();
  await page.click('[data-test=confirm-ok]');
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(1);

  // Trash view → restore
  await page.click('[data-test=trash-toggle]');
  const trashed = page
    .locator('[data-test=doc-card]')
    .filter({ has: page.locator('[data-test=doc-title]', { hasText: 'Renamed Report' }) });
  await trashed.locator('[data-test=doc-menu]').click();
  await trashed.locator('[data-test=restore]').click();
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(0);

  // Back in the library it is restored
  await page.click('[data-test=trash-toggle]');
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(2);
});
