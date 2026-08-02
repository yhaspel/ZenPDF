import { expect, request as pwRequest, test } from '@playwright/test';
import path from 'node:path';

import {
  registerAndLogin,
  registerVerifiedAndLogin,
  uniqueEmail,
  uploadFiles,
} from './helpers';

/**
 * Phase 9 — ads, consent and abuse controls (phase-09 "Tests → E2E").
 *
 * The default state is the launchable one: `ADS_ENABLED=false`, so the first
 * spec asserts what a visitor actually gets today — no ad code anywhere, no
 * banner, and a product that works. The rest cover the legal pages, the
 * verification flow through Mailpit, and that trust surfaces stay ad-free.
 */

test.use({ viewport: { width: 1440, height: 1100 } });

type PWPage = import('@playwright/test').Page;

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

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

/** Every script the page pulled in, so "no ad code" can be asserted. */
async function scriptSources(page: PWPage): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('script[src]'))
      .map((node) => (node as HTMLScriptElement).src));
}

test('phase 9: with ads off, no ad code loads and nothing asks for consent', async ({
  page,
}) => {
  // The shipped default, and the acceptance criterion: launchable state.
  await page.context().clearCookies();
  await page.goto('/');
  await expect(page.locator('[data-test=tool-grid]')).toBeVisible();

  const sources = await scriptSources(page);
  expect(sources.some((src) => src.includes('adsbygoogle'))).toBe(false);
  expect(sources.some((src) => src.includes('googlesyndication'))).toBe(false);
  await expect(page.locator('[data-test=consent-banner]')).toHaveCount(0);
  await expect(page.locator('[data-test=ad-slot-landing]')).toHaveCount(0);

  // …and the product works, which is the other half of "launchable".
  await page.goto('/merge-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Merge PDF files');
});

test('phase 9: the trust surfaces carry no ad markup at all', async ({ page }) => {
  await page.context().clearCookies();
  for (const url of ['/verify', '/legal/privacy', '/legal/terms',
                     '/legal/esign-disclosure']) {
    await page.goto(url);
    await expect(page.locator('[data-test^=ad-slot-]')).toHaveCount(0);
    const sources = await scriptSources(page);
    expect(sources.some((src) => src.includes('googlesyndication'))).toBe(false);
  }
});

test('phase 9: the legal pages are live, linked, and quote the real numbers', async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto('/');
  await page.click('[data-test=footer-privacy]');
  await expect(page.locator('[data-test=legal-h1]')).toHaveText('Privacy policy');

  // The retention table is rendered from /api/config/, which reads the same
  // settings the sweepers use — a backend test pins the other end of that.
  await expect(page.locator('[data-test=retention-trash]')).toContainText('30 days');
  await expect(page.locator('[data-test=retention-guest]')).toContainText('24 hours');
  await expect(page.locator('[data-test=retention-export]')).toContainText('24 hours');

  await page.goto('/');
  await page.click('[data-test=footer-terms]');
  await expect(page.locator('[data-test=legal-h1]')).toHaveText('Terms of service');

  await page.goto('/');
  await page.click('[data-test=footer-about]');
  await expect(page.locator('[data-test=legal-h1]')).toHaveText('About ZenPDF');
});

test('phase 9: ads.txt is served with a deliberate answer', async ({ request }) => {
  const response = await request.get('/ads.txt');
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('ads.txt');
});

test('phase 9: an account verifies its address through the inbox', async ({ page }) => {
  test.setTimeout(180_000);
  const email = await registerAndLogin(page, 'p9verify');

  // Uploading is *not* gated — a guest uploads freely, so an account must not
  // be worse off (the rule §21 exists to protect).
  await uploadFiles(page, ['text.pdf']);
  await expect(page.locator('[data-test=doc-card]').first()).toBeVisible({
    timeout: 60_000,
  });

  await page.goto('/app/settings');
  await expect(page.locator('[data-test=verify-banner]')).toBeVisible();
  await page.click('[data-test=resend-verification]');

  const message = await mailFor(email);
  expect(message.subject).toContain('Confirm');
  const link = /https?:\/\/[^\s]+\/verify-email\/[A-Za-z0-9:_-]+/.exec(message.body);
  expect(link).not.toBeNull();

  await page.goto(link![0]);
  await expect(page.locator('[data-test=verified]')).toBeVisible({ timeout: 60_000 });

  await page.goto('/app/settings');
  await expect(page.locator('[data-test=verify-banner]')).toHaveCount(0);
});

test('phase 9: an unverified account is told why it cannot send yet', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await registerAndLogin(page, 'p9unverified');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();

  await page.click('[data-test=sign-toggle]');
  await page.click('[data-test=signature-cancel]');
  await page.click('[data-test=send-for-signature]');
  await expect(page.locator('[data-test=request-builder]')).toBeVisible({
    timeout: 60_000,
  });

  await page.fill('[data-test=recipient-email-0]', uniqueEmail('nope'));
  await page.click('[data-test=to-fields]');
  const overlay = page.locator('[data-test=page-overlay]');
  await expect(overlay.locator('img')).toBeVisible({ timeout: 30_000 });
  const box = (await overlay.boundingBox())!;
  await page.click('[data-test^="arm-"]');
  await page.mouse.move(box.x + 80, box.y + box.height * 0.7);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + box.height * 0.76, { steps: 6 });
  await page.mouse.up();
  await page.click('[data-test=to-message]');
  await page.click('[data-test=to-review]');
  await page.click('[data-test=send-request]');

  // Refused, and the message says what to do about it — not a bare 403.
  await expect(page.locator('[data-test=toast-error]')).toContainText(
    'Confirm your email', { timeout: 60_000 });
});

test('phase 9: the usage panel shows real numbers', async ({ page }) => {
  test.setTimeout(180_000);
  await registerAndLogin(page, 'p9usage');
  await uploadFiles(page, ['text.pdf']);
  await expect(page.locator('[data-test=doc-card]').first()).toBeVisible({
    timeout: 60_000,
  });

  await page.goto('/app/settings');
  await expect(page.locator('[data-test=usage-table]')).toBeVisible();
  // A limit nobody can see is a limit that arrives as a surprise 429.
  await expect(page.locator('[data-test=usage-sign]')).toContainText('/ 30');
  await expect(page.locator('[data-test=usage-metered]')).toContainText('/ 40');
  await expect(page.locator('[data-test=usage-heading]')).toContainText('Storage');
});

test('phase 9: a recipient can report a signing request they did not expect', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const signer = uniqueEmail('p9reporter');
  // Sending is gated on a confirmed address, which the previous spec covers.
  await registerVerifiedAndLogin(page, 'p9sender');
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
  await page.click('[data-test^="arm-"]');
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
  // Every message we send carries a way out and a way to complain (§9B).
  expect(invite.body).toContain('/unsubscribe/');
  expect(invite.body.toLowerCase()).toContain('abuse@');

  const link = /https?:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(invite.body)![0];
  const guest = await browser.newContext();
  const ceremony = await guest.newPage();
  await ceremony.goto(link);
  await ceremony.click('[data-test=report-open]');
  await ceremony.fill('[data-test=report-reason]', 'I have never heard of them');
  await ceremony.click('[data-test=report-send]');
  await expect(ceremony.locator('[data-test=ceremony-error]')).toContainText(
    'recorded your report', { timeout: 60_000 });
  await guest.close();
});

test('phase 9: with ads on and consent granted, slots appear — and only there',
  async ({ page }) => {
  test.setTimeout(180_000);
  // The server payload is covered by backend tests; what this asserts is the
  // *client* behaviour with ads switched on, which is otherwise only reachable
  // by restarting the stack with a different env.
  await page.context().clearCookies();
  await page.route('**/api/config/**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        features: { ...body.features, ads_enabled: true },
        consent_required: true,
        ads: {
          enabled: true, provider: 'adsense', client_id: 'ca-pub-e2e',
          slots: { landing: '111', 'tool-result': '222', 'dashboard-rail': '333' },
        },
      },
    });
  });

  await page.goto('/');
  // Nothing renders and nothing loads until the visitor has answered.
  await expect(page.locator('[data-test=consent-banner]')).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator('[data-test=ad-slot-landing]')).toHaveCount(0);

  await page.click('[data-test=consent-accept]');
  await expect(page.locator('[data-test=consent-banner]')).toHaveCount(0);
  await expect(page.locator('[data-test=ad-slot-landing]')).toBeVisible();

  // …and the trust surfaces stay empty with consent granted and ads on, which
  // is the only configuration in which the exclusion can actually fail.
  await page.goto('/verify');
  await expect(page.locator('[data-test^=ad-slot-]')).toHaveCount(0);
  await page.goto('/legal/privacy');
  await expect(page.locator('[data-test^=ad-slot-]')).toHaveCount(0);

  // The choice is remembered rather than asked again on every page.
  await page.goto('/');
  await expect(page.locator('[data-test=consent-banner]')).toHaveCount(0);
});

test('phase 9: declining is a real answer and loads nothing', async ({ page }) => {
  await page.context().clearCookies();
  await page.route('**/api/config/**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        ...body,
        consent_required: true,
        ads: { enabled: true, provider: 'adsense', client_id: 'ca-pub-e2e',
               slots: { landing: '111' } },
      },
    });
  });

  await page.goto('/');
  await page.click('[data-test=consent-deny]');
  await expect(page.locator('[data-test=ad-slot-landing]')).toHaveCount(0);

  const sources = await scriptSources(page);
  expect(sources.some((src) => src.includes('googlesyndication'))).toBe(false);

  // Declining sticks — it is an answer, not a prompt to ask again.
  await page.reload();
  await expect(page.locator('[data-test=consent-banner]')).toHaveCount(0);
  await expect(page.locator('[data-test=ad-slot-landing]')).toHaveCount(0);
});
