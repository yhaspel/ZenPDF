import { expect, test } from '@playwright/test';
import path from 'node:path';

import { FIXTURES, registerAndLogin, uploadFiles } from './helpers';

/**
 * Phase 5 — forms (phase-05 "Tests → E2E").
 *
 * Open the form fixture → fill four field types in-browser → save → reload
 * shows the values → export JSON → flatten → download. Plus the form builder,
 * the XFA warning, and the guest path through `/fill-pdf-form`.
 */

test.use({ viewport: { width: 1440, height: 1100 } });

type PWPage = import('@playwright/test').Page;

function successToast(page: PWPage, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

async function openFormsMode(page: PWPage) {
  await page.click('[data-test=forms-toggle]');
  await expect(page.locator('[data-test=forms-mode]')).toBeVisible();
}

/** The widget PDF.js rendered for a field — `element.name` is the field name. */
function widget(page: PWPage, name: string) {
  return page.locator(`.annotationLayer [name="${name}"]`);
}

async function waitForWidgets(page: PWPage) {
  await expect(page.locator('[data-test=forms-viewer]')).toBeVisible();
  await expect(widget(page, 'attendee')).toBeVisible({ timeout: 60_000 });
}

test('phase 5: fill four field types in the page, save, reload, export, flatten', async ({
  page,
}) => {
  await registerAndLogin(page, 'p5');
  await uploadFiles(page, ['form-multi.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  await openFormsMode(page);
  await waitForWidgets(page);

  // --- 1. Fill four kinds of widget, in the rendered page. ---
  await widget(page, 'attendee').fill('Ada Lovelace');
  await widget(page, 'vegetarian').check();
  await widget(page, 'ticket').selectOption('speaker');
  await widget(page, 'track').selectOption('frontend');

  // The panel mirrors the viewer's form layer, which is what proves the two
  // are the same session rather than two disconnected copies of the form.
  await expect(page.locator('[data-test=field-attendee]')).toHaveValue('Ada Lovelace');
  await expect(page.locator('[data-test=field-vegetarian]')).toBeChecked();

  // --- 2. Save: one job, one version. ---
  await page.click('[data-test=form-save]');
  await expect(successToast(page, 'Form saved')).toBeVisible({ timeout: 60_000 });

  // --- 3. The values came back from the *file*, not from local state. ---
  await expect(page.locator('[data-test=field-attendee]')).toHaveValue('Ada Lovelace', {
    timeout: 60_000,
  });
  await expect(page.locator('[data-test=field-ticket]')).toHaveValue('speaker');
  await expect(page.locator('[data-test=field-track]')).toHaveValue('frontend');

  // --- 4. Export the data. ---
  const exported = page.waitForEvent('download');
  await page.click('[data-test=form-export-json]');
  expect((await exported).suggestedFilename()).toBe('form-data.json');

  // --- 5. Flatten — the fields go, the values stay. ---
  await page.click('[data-test=form-flatten]');
  await page.click('[data-test=confirm-ok]');
  await expect(successToast(page, 'Form flattened')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=no-form]')).toBeVisible({ timeout: 60_000 });

  // --- 6. Download the finished document. ---
  const download = page.waitForEvent('download');
  await page.click('[data-test=download]');
  expect((await download).suggestedFilename()).toContain('.pdf');

  // --- 7. Every step is a labeled version. ---
  await page.click('[data-test=forms-toggle]');
  await page.click('[data-test=tab-history]');
  const versions = page.locator('[data-test=version-row]');
  await expect(versions).toHaveCount(3); // Original, Form filled, Flattened form
  await expect(versions.nth(0)).toContainText('Flattened form');
  await expect(versions.nth(1)).toContainText('Form filled');
});

test('phase 5: build fields on a document that has none, then fill them', async ({ page }) => {
  await registerAndLogin(page, 'p5build');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await openFormsMode(page);

  await expect(page.locator('[data-test=no-form]')).toBeVisible({ timeout: 60_000 });

  await page.click('[data-test=tab-build]');
  const overlay = page.locator('[data-test=page-overlay]');
  await expect(overlay.locator('img')).toBeVisible({ timeout: 30_000 });
  const box = (await overlay.boundingBox())!;

  async function drawField(type: string, top: number) {
    await page.click(`[data-test=field-type-${type}]`);
    await page.mouse.move(box.x + 80, box.y + top);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + top + 28);
    await page.mouse.up();
    await expect(page.locator('[data-test=field-properties]')).toBeVisible();
  }

  await drawField('text', 420);
  await page.fill('[data-test=prop-name]', 'attendee');
  await page.click('[data-test=prop-apply]');

  await drawField('checkbox', 480);
  await page.fill('[data-test=prop-name]', 'vegetarian');
  await page.click('[data-test=prop-apply]');

  // Both fields, one job, one version — the phase is explicit that a builder
  // session is a single `edit_form_fields_batch`.
  await expect(page.locator('[data-test=fields-save]')).toContainText('2 field change');
  await page.click('[data-test=fields-save]');
  await expect(successToast(page, 'Form fields saved')).toBeVisible({ timeout: 60_000 });

  await page.click('[data-test=tab-fill]');
  await expect(page.locator('[data-test=field-attendee]')).toBeVisible({ timeout: 60_000 });
  await page.fill('[data-test=field-attendee]', 'Grace Hopper');
  await page.click('[data-test=form-save]');
  await expect(successToast(page, 'Form saved')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=field-attendee]')).toHaveValue('Grace Hopper', {
    timeout: 60_000,
  });
});

test('phase 5: an XFA form is filled with a warning, not silently', async ({ page }) => {
  await registerAndLogin(page, 'p5xfa');
  await uploadFiles(page, ['xfa-form.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await openFormsMode(page);

  const warning = page.locator('[data-test=xfa-warning]');
  await expect(warning).toBeVisible({ timeout: 60_000 });
  await expect(warning).toContainText('XFA');
  // Degrades gracefully: the fallback fields are still listed and usable.
  await expect(page.locator('[data-test=field-row]')).not.toHaveCount(0);
});

test('phase 5: a guest fills a form from /fill-pdf-form with no login prompt', async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto('/fill-pdf-form');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Fill out a PDF form');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

  await page
    .locator('[data-test=file-input]')
    .setInputFiles(path.join(FIXTURES, 'form-multi.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page).toHaveURL(/\/app\/doc\/.*mode=forms/, { timeout: 60_000 });
  await expect(page.locator('[data-test=forms-mode]')).toBeVisible();

  await page.fill('[data-test=field-attendee]', 'Guest User');
  await page.click('[data-test=form-save]');
  await expect(successToast(page, 'Form saved')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=field-attendee]')).toHaveValue('Guest User', {
    timeout: 60_000,
  });

  // Export works for a guest too, and nothing asked them to sign in.
  const download = page.waitForEvent('download');
  await page.click('[data-test=form-export-csv]');
  expect((await download).suggestedFilename()).toBe('form-data.csv');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});
