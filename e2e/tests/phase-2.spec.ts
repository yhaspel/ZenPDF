import { expect, test } from '@playwright/test';

import { registerAndLogin, uploadFiles } from './helpers';

function successToast(page: import('@playwright/test').Page, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

test('phase 2: organize (rotate/delete/revert), merge, split', async ({ page }) => {
  await registerAndLogin(page, 'p2');
  await uploadFiles(page, ['text.pdf', 'unicode.pdf']);
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(2);

  // Open the "text" doc and enter Organize mode
  const textCard = page
    .locator('[data-test=doc-card]')
    .filter({ has: page.locator('[data-test=doc-title]', { hasText: 'text' }) });
  await textCard.locator('[data-test=open-doc]').click();
  await expect(page).toHaveURL(/\/app\/doc\//);
  await page.click('[data-test=organize-toggle]');
  await expect(page.locator('[data-test=organize-page]').first()).toBeVisible();

  const toolbar = page.locator('[data-test=organize-toolbar]');

  // Rotate first page → labeled version
  await page.locator('[data-test=organize-page]').nth(0).click();
  await page.click('[data-test=op-rotate]');
  await expect(successToast(page, 'Rotated')).toBeVisible();

  // The success toast fires *before* `viewer.reload()` resolves, and the reload
  // bumps `currentSeq()` — which runs the effect that rebuilds `order` and calls
  // `pages.clear()`. A page clicked in that window gets deselected mid-flight, so
  // `op-delete` says "select one or more pages first" and no confirm dialog ever
  // opens. Wait for the reloaded grid (header shows v2) before selecting again,
  // then re-assert the selection actually stuck.
  await expect(page.getByText(/^v2 · \d+ pages$/)).toBeVisible();

  // Delete a page → labeled version
  await page.locator('[data-test=organize-page]').nth(0).click();
  await expect(toolbar).toContainText('1 selected');
  await page.click('[data-test=op-delete]');
  await page.click('[data-test=confirm-ok]');
  await expect(successToast(page, 'Deleted')).toBeVisible();

  // Undo via version revert (History tab → revert to the original v1)
  await page.click('[data-test=tab-history]');
  await expect(page.locator('[data-test=version-row]')).toHaveCount(3); // v1,v2,v3
  await page.locator('[data-test=revert]').last().click();
  await page.click('[data-test=confirm-ok]');
  await expect(successToast(page, 'Reverted')).toBeVisible();

  // Merge the two docs from the dashboard
  await page.click('[data-test=back]');
  await page.locator('[data-test=select-doc]').nth(0).check();
  await page.locator('[data-test=select-doc]').nth(1).check();
  await page.click('[data-test=merge-btn]');
  await expect(page).toHaveURL(/\/app\/doc\//);
  await expect(page.locator('[data-test=doc-title]')).toContainText('Merged');

  // Split the merged doc by ranges
  await page.click('[data-test=tool-split]');
  await page.fill('[data-test=split-ranges-input]', '1-2,3-4');
  await page.click('[data-test=dialog-apply]');
  await expect(successToast(page, 'Split')).toBeVisible();
});
