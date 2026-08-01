import { test, expect } from '@playwright/test';
import { registerAndLogin, uploadFiles } from './helpers';

test('debug fill save', async ({ page }) => {
  page.on('response', async (r) => {
    if (r.url().includes('/operations/') || r.url().includes('/jobs/')) {
      let body = ''; try { body = (await r.text()).slice(0, 300); } catch { /* */ }
      console.log('HTTP', r.status(), r.url().slice(-40), body);
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0, 200)); });
  await registerAndLogin(page, 'dbg');
  await uploadFiles(page, ['form-multi.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await page.click('[data-test=forms-toggle]');
  await expect(page.locator('.annotationLayer [name="attendee"]')).toBeVisible({ timeout: 60000 });
  await page.locator('.annotationLayer [name="attendee"]').fill('Ada Lovelace');
  await expect(page.locator('[data-test=field-attendee]')).toHaveValue('Ada Lovelace');
  await page.click('[data-test=form-save]');
  await page.waitForTimeout(15000);
  console.log('TOASTS', await page.locator('[data-test^=toast]').allTextContents());
});
