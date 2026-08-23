import { expect, test } from '@playwright/test';

import { expectPageDrew } from './drew';
import { registerAndLogin, registerVerifiedAndLogin, uploadFiles } from './helpers';

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

  // The page is on the screen — read back from the canvas, not inferred from a
  // 200. This is the assertion the 2026-08-02 and 2026-08-20 queue rows asked
  // for, and the one whose absence let the production viewer render nothing for
  // ten days while every other check stayed green.
  await expectPageDrew(page);

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

/**
 * A document under a signature request cannot be permanently deleted, and the
 * trash view has to say so (queue row 2026-08-02, the UI half).
 *
 * `_purge` has always refused — `source_version` is `PROTECT` and the signed
 * record must keep pointing at what was signed. What the user saw was "Delete
 * forever", a card that vanished and came back, and no explanation at all; the
 * only other account of it was the nightly `trash_purge` retry, written to a
 * log they cannot read.
 *
 * The request is created through the API rather than by driving the builder:
 * phase-8 already covers that UI end to end, and repeating it here would make a
 * trash test depend on the ceremony's timing for nothing.
 */
test('phase 1: a document under a signature request cannot be deleted forever',
     async ({ page }) => {
  const email = await registerVerifiedAndLogin(page, 'p1sign');
  await uploadFiles(page, ['text.pdf']);
  await expect(page.locator('[data-test=doc-card]')).toHaveCount(1);

  const documentId = await page.evaluate(async () => {
    const token = localStorage.getItem('zen_access');
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const list = await fetch('/api/documents/', { headers }).then((r) => r.json());
    const id = list.results[0].id;

    const created = await fetch('/api/sign-requests/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document: id, title: 'Offer' }),
    }).then((r) => r.json());

    const withPeople = await fetch(`/api/sign-requests/${created.id}/`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        recipients: [{ email: 'signer@example.com', name: 'Sam',
                       role: 'signer', order: 1 }],
      }),
    }).then((r) => r.json());

    await fetch(`/api/sign-requests/${created.id}/`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        fields: [{ recipient_id: withPeople.recipients[0].id, page: 0,
                   x: 0.1, y: 0.7, w: 0.3, h: 0.08, type: 'signature',
                   required: true, label: 'Sign here' }],
      }),
    });
    await fetch(`/api/sign-requests/${created.id}/send/`, { method: 'POST', headers });
    return id;
  });
  expect(documentId).toBeTruthy();
  expect(email).toContain('@');

  // Trash it, then look at it in the trash.
  await page.reload();
  const card = page.locator('[data-test=doc-card]').first();
  await card.locator('[data-test=doc-menu]').click();
  await card.locator('[data-test=trash]').click();
  await page.click('[data-test=confirm-ok]');
  await page.click('[data-test=trash-toggle]');

  const trashedCard = page.locator('[data-test=doc-card]').first();
  await expect(trashedCard).toBeVisible();

  // The explanation is on the card, standing — not a toast that fades.
  await expect(trashedCard.locator('[data-test=undeletable]'))
    .toContainText('cannot be deleted');

  // …and the action that would always fail is simply not offered. Restore is.
  await trashedCard.locator('[data-test=doc-menu]').click();
  await expect(trashedCard.locator('[data-test=restore]')).toBeVisible();
  await expect(trashedCard.locator('[data-test=purge]')).toHaveCount(0);
});

/** The opposite case, so a regression that always hides the button is caught. */
test('phase 1: an ordinary trashed document still offers Delete forever',
     async ({ page }) => {
  await registerAndLogin(page, 'p1plain');
  await uploadFiles(page, ['text.pdf']);

  const card = page.locator('[data-test=doc-card]').first();
  await card.locator('[data-test=doc-menu]').click();
  await card.locator('[data-test=trash]').click();
  await page.click('[data-test=confirm-ok]');
  await page.click('[data-test=trash-toggle]');

  const trashedCard = page.locator('[data-test=doc-card]').first();
  await trashedCard.locator('[data-test=doc-menu]').click();
  await expect(trashedCard.locator('[data-test=purge]')).toBeVisible();
  await expect(trashedCard.locator('[data-test=undeletable]')).toHaveCount(0);
});
