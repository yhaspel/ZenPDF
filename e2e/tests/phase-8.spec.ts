import { expect, request as pwRequest, test } from '@playwright/test';
import path from 'node:path';

import {
  FIXTURES,
  registerAndLogin,
  registerVerifiedAndLogin,
  uniqueEmail,
  uploadFiles,
} from './helpers';

/**
 * Phase 8 — e-signatures (phase-08 "Tests → E2E").
 *
 * The full loop, driven through Mailpit: build a request with two sequential
 * signers plus a cc → signer 1's link out of the inbox → consent → draw →
 * assert signer 2 was *not* emailed until then → signer 2 types → three
 * completion emails → download the signed document and the certificate →
 * `/verify` shows it intact. Plus self-signing with no account at all, which
 * is the Phase-2B gate.
 */

test.use({ viewport: { width: 1440, height: 1100 } });

type PWPage = import('@playwright/test').Page;

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

function successToast(page: PWPage, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

async function clearMail() {
  const api = await pwRequest.newContext();
  await api.delete(`${MAILPIT}/api/v1/messages`);
  await api.dispose();
}

/** The most recent message to `address`, with its body. */
async function mailFor(address: string): Promise<{ subject: string; body: string }> {
  const api = await pwRequest.newContext();
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

async function countMailFor(address: string): Promise<number> {
  const api = await pwRequest.newContext();
  const list = await api.get(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  const body = await list.json();
  await api.dispose();
  return body.messages?.length ?? 0;
}

function signLink(body: string): string {
  const match = /https?:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(body);
  if (!match) throw new Error(`no signing link in: ${body.slice(0, 300)}`);
  return match[0];
}

/** Draw on the signature canvas — the same gesture a finger makes. */
async function drawSignature(page: PWPage) {
  const canvas = page.locator('[data-test=sig-canvas]');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.3, { steps: 8 });
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.6, { steps: 8 });
  await page.mouse.up();
  await page.click('[data-test=sig-use]');
}

// --------------------------------------------------------------------------- //
// 8A — self-sign, with no account (the Phase-2B gate)
// --------------------------------------------------------------------------- //
test('@smoke phase 8: a guest signs a PDF from /sign-pdf with no login anywhere', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.context().clearCookies();
  await page.goto('/sign-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Sign a PDF');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

  await page.locator('[data-test=file-input]').setInputFiles(
    path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page).toHaveURL(/\/app\/doc\/.*mode=sign/, { timeout: 60_000 });

  // The dialog is already open — the click count is the acceptance criterion.
  await expect(page.locator('[data-test=signature-dialog]')).toBeVisible();
  await drawSignature(page);
  await expect(page.locator('[data-test=chosen-signature]')).toBeVisible({
    timeout: 30_000,
  });

  // Click 2: place it. Click 3: apply.
  const overlay = page.locator('[data-test=page-overlay]');
  await expect(overlay.locator('img')).toBeVisible({ timeout: 30_000 });
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + box.height * 0.75);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + box.height * 0.82, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[data-test=placement-count]')).toContainText('1 placement');

  await page.click('[data-test=apply-signature]');
  await expect(successToast(page, 'Signed')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

  await page.click('[data-test=sign-toggle]');
  await page.click('[data-test=tab-history]');
  await expect(page.locator('[data-test=version-row]').first()).toContainText(
    'Signed (self)');
});

// --------------------------------------------------------------------------- //
// 8B — the full two-signer loop
// --------------------------------------------------------------------------- //
test('@smoke @mobile phase 8: two signers in order, sealed, certified and verifiable', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  await clearMail();

  const signerOne = uniqueEmail('signer1');
  const signerTwo = uniqueEmail('signer2');
  const watcher = uniqueEmail('cc');

  await registerVerifiedAndLogin(page, 'p8');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  // --- build the request ---
  await page.click('[data-test=sign-toggle]');
  await expect(page.locator('[data-test=sign-mode]')).toBeVisible();
  await page.click('[data-test=signature-cancel]');
  await page.click('[data-test=send-for-signature]');
  await expect(page.locator('[data-test=request-builder]')).toBeVisible({
    timeout: 60_000,
  });

  await page.fill('[data-test=recipient-email-0]', signerOne);
  await page.fill('[data-test=recipient-name-0]', 'First Signer');
  await page.click('[data-test=add-recipient]');
  await page.fill('[data-test=recipient-email-1]', signerTwo);
  await page.fill('[data-test=recipient-order-1]', '2');
  await page.click('[data-test=add-recipient]');
  await page.fill('[data-test=recipient-email-2]', watcher);
  await page.selectOption('[data-test=recipient-role-2]', 'cc');
  await page.click('[data-test=to-fields]');

  // --- place one signature field per signer ---
  await expect(page.locator('[data-test=step-fields]')).toBeVisible();
  const overlay = page.locator('[data-test=page-overlay]');
  await expect(overlay.locator('img')).toBeVisible({ timeout: 30_000 });
  const box = (await overlay.boundingBox())!;

  async function placeField(forEmail: string, top: number) {
    await page.click(`[data-test="arm-${forEmail}"]`);
    await page.mouse.move(box.x + 80, box.y + top);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + top + 40, { steps: 6 });
    await page.mouse.up();
  }
  await placeField(signerOne, box.height * 0.62);
  await placeField(signerTwo, box.height * 0.75);

  await page.click('[data-test=to-message]');
  await page.fill('[data-test=builder-message]', 'Please sign by Friday.');
  await page.click('[data-test=to-review]');
  await expect(page.locator('[data-test=review-recipient]')).toHaveCount(3);
  await page.click('[data-test=send-request]');
  await expect(successToast(page, 'Sent')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=request-status]')).toHaveText('sent');

  // --- signer 1: from the inbox, in a clean context ---
  const first = await mailFor(signerOne);
  expect(first.subject).toContain('sign');
  expect(await countMailFor(signerTwo)).toBe(0);  // …and only signer 1.

  const guestOne = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ceremonyOne = await guestOne.newPage();
  await ceremonyOne.goto(signLink(first.body));

  await expect(ceremonyOne.locator('[data-test=consent-screen]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(ceremonyOne.locator('[data-test=disclosure]')).toContainText('ESIGN');
  // Unskippable: the button is dead until the box is ticked.
  await expect(ceremonyOne.locator('[data-test=consent-continue]')).toBeDisabled();
  await ceremonyOne.check('[data-test=agree]');
  await ceremonyOne.click('[data-test=consent-continue]');

  await expect(ceremonyOne.locator('[data-test=sign-screen]')).toBeVisible();
  await expect(ceremonyOne.locator('[data-test=finish]')).toBeDisabled();

  // The document, with this signer's box drawn on it — signing without seeing
  // where the mark lands is signing blind.
  await expect(ceremonyOne.locator('[data-test=ceremony-page-image]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(ceremonyOne.locator('[data-test=ceremony-viewer] button[data-test^=box-]'))
    .toHaveCount(1);

  await ceremonyOne.getByRole('button', { name: 'Sign here' }).click();
  await drawSignature(ceremonyOne);
  await expect(ceremonyOne.locator('[data-test=field-done]')).toBeVisible({
    timeout: 30_000,
  });
  await ceremonyOne.click('[data-test=finish]');
  await expect(ceremonyOne.locator('[data-test=done-screen]')).toBeVisible({
    timeout: 60_000,
  });
  await guestOne.close();

  // --- signer 2 is emailed only now ---
  const second = await mailFor(signerTwo);
  const guestTwo = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ceremonyTwo = await guestTwo.newPage();
  await ceremonyTwo.goto(signLink(second.body));
  await ceremonyTwo.check('[data-test=agree]');
  await ceremonyTwo.click('[data-test=consent-continue]');
  await ceremonyTwo.getByRole('button', { name: 'Sign here' }).click();

  // …typing the signature this time, which is the other path through the pad.
  await ceremonyTwo.click('[data-test=sig-tab-type]');
  await ceremonyTwo.fill('[data-test=sig-text]', 'Second Signer');
  await expect(ceremonyTwo.locator('[data-test=sig-preview]')).toBeVisible({
    timeout: 30_000,
  });
  await ceremonyTwo.click('[data-test=sig-use]');
  await expect(ceremonyTwo.locator('[data-test=field-done]')).toBeVisible({
    timeout: 30_000,
  });
  await ceremonyTwo.click('[data-test=finish]');
  await expect(ceremonyTwo.locator('[data-test=done-screen]')).toBeVisible({
    timeout: 90_000,
  });

  // --- everyone is told, including the cc ---
  const completion = await mailFor(watcher);
  expect(completion.subject).toContain('Completed');
  expect(completion.body).toContain('SHA-256');

  // --- the recipient's own copy, from the completion screen ---
  await ceremonyTwo.reload();
  await expect(ceremonyTwo.locator('[data-test=download-final]')).toBeVisible({
    timeout: 90_000,
  });
  const download = ceremonyTwo.waitForEvent('download');
  await ceremonyTwo.click('[data-test=download-final]');
  // Saved to a path of our own before the context closes: Playwright deletes a
  // download's temporary file with the context that produced it.
  const finalPath = path.join(test.info().outputDir, 'signed.pdf');
  await (await download).saveAs(finalPath);
  await guestTwo.close();

  // --- the owner sees it completed, with an intact chain ---
  await page.reload();
  await expect(page.locator('[data-test=request-status]')).toHaveText('completed', {
    timeout: 90_000,
  });
  await expect(page.locator('[data-test=final-hash]')).toContainText(/[0-9a-f]{64}/);
  await page.click('[data-test=tab-audit]');
  await expect(page.locator('[data-test=chain-status]')).toContainText('verifies');
  await expect(page.locator('[data-test=audit-row]').filter({ hasText: 'signed' }))
    .toHaveCount(2);

  // --- and /verify agrees, for anybody ---
  const anon = await browser.newContext();
  const verifyPage = await anon.newPage();
  await verifyPage.goto('/verify');
  await verifyPage.locator('[data-test=verify-input]').setInputFiles(finalPath);
  await expect(verifyPage.locator('[data-test=verify-headline]')).toContainText(
    'unchanged since', { timeout: 60_000 });
  await expect(verifyPage.locator('[data-test=envelope-match]')).toContainText(
    'fingerprint matches');
  // Honest about a development certificate rather than showing a green tick.
  await expect(verifyPage.locator('[data-test=trust-line]')).toContainText(
    'not from a trusted authority');
  await anon.close();
});

test('phase 8: a signer who declines stops the request', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await clearMail();
  const signer = uniqueEmail('decliner');

  await registerVerifiedAndLogin(page, 'p8decline');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await page.click('[data-test=sign-toggle]');
  await page.click('[data-test=signature-cancel]');
  await page.click('[data-test=send-for-signature]');
  await expect(page.locator('[data-test=request-builder]')).toBeVisible({
    timeout: 60_000,
  });

  await page.fill('[data-test=recipient-email-0]', signer);
  await page.click('[data-test=to-fields]');
  const overlay = page.locator('[data-test=page-overlay]');
  await expect(overlay.locator('img')).toBeVisible({ timeout: 30_000 });
  const box = (await overlay.boundingBox())!;
  await page.click(`[data-test="arm-${signer}"]`);
  await page.mouse.move(box.x + 80, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + box.height * 0.76, { steps: 6 });
  await page.mouse.up();
  await page.click('[data-test=to-message]');
  await page.click('[data-test=to-review]');
  await page.click('[data-test=send-request]');
  await expect(page.locator('[data-test=request-status]')).toHaveText('sent', {
    timeout: 60_000,
  });

  const invite = await mailFor(signer);
  const guest = await browser.newContext();
  const ceremony = await guest.newPage();
  await ceremony.goto(signLink(invite.body));
  await ceremony.click('[data-test=decline-open]');
  await ceremony.fill('[data-test=decline-reason]', 'The dates are wrong');
  await ceremony.click('[data-test=decline-confirm]');
  await expect(ceremony.locator('[data-test=closed-screen]')).toBeVisible({
    timeout: 60_000,
  });
  // The link is dead for everyone now, including a reload.
  await ceremony.reload();
  await expect(ceremony.locator('[data-test=closed-screen]')).toBeVisible();
  await guest.close();

  await page.reload();
  await expect(page.locator('[data-test=request-status]')).toHaveText('declined', {
    timeout: 60_000,
  });
  await expect(page.locator('[data-test=recipient-status]')).toContainText(
    'The dates are wrong');
});

test('phase 8: the disclosure has a stable address of its own', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/legal/esign-disclosure');
  await expect(page.locator('[data-test=disclosure-h1]')).toContainText(
    'Consent to use electronic records');
  await expect(page.locator('[data-test=disclosure-text]')).toContainText('ESIGN');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 8: /verify says plainly when a PDF is not signed', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto('/verify');
  await expect(page.locator('[data-test=verify-h1]')).toHaveText('Verify a signed PDF');

  await page.locator('[data-test=verify-input]').setInputFiles(
    path.join(FIXTURES, 'text.pdf'));
  await expect(page.locator('[data-test=verify-headline]')).toContainText(
    'no signature', { timeout: 60_000 });
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});
