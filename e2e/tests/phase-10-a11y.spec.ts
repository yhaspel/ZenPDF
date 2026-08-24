import AxeBuilder from '@axe-core/playwright';
import { Page, expect, test } from '@playwright/test';

import { registerAndLogin, uploadFiles } from './helpers';

/**
 * Accessibility (phase-10 §10.3, WCAG 2.1 AA — our UI, not user PDFs).
 *
 * Two halves, because automation only covers one of them:
 *
 * * **axe-core** on every route a person can reach, asserting zero *serious*
 *   or *critical* findings. axe finds perhaps a third of real barriers, which
 *   makes it a floor rather than a pass mark.
 * * **A keyboard-only pass through the signing ceremony**, driven with real
 *   Tab, Enter and Space, from the consent box to the finished envelope. That
 *   flow is the legally sensitive one: somebody using a screen reader has to
 *   be able to sign a document, and "the mouse works" is not an answer. The
 *   signature is *typed* — drawing on a canvas is not a keyboard gesture, and
 *   the Type tab is the WCAG-conformant alternative that already exists.
 *
 * Findings are printed with their target so a failure is actionable rather
 * than a count.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Tab until the named control has focus, or fail saying it is unreachable —
 *  which is the actual finding when a keyboard user cannot get to a button. */
async function tabTo(page: Page, testId: string, limit = 60): Promise<void> {
  for (let i = 0; i < limit; i++) {
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement)?.dataset?.['test'] ?? '',
    );
    if (focused === testId) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`[data-test=${testId}] is not reachable with the keyboard`);
}

/**
 * Third-party markup we cannot fix from here.
 *
 * `ngx-extended-pdf-viewer` ships PDF.js's own toolbar, whose editor buttons
 * carry unsupported ARIA attributes and whose `pdf-shy-button` elements are
 * missing required ones. Excluding it is not "ignoring a11y": it keeps this
 * suite about *our* markup, so a real regression is visible instead of being
 * lost in vendor noise. The defects are recorded in the Human review queue as
 * an upstream report, and everything around the viewer is still scanned.
 */
const VENDOR = ['#toolbarContainer', '#editorModeButtons', 'pdf-shy-button'];

async function scan(page: Page, label: string) {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
  for (const selector of VENDOR) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const detail = blocking
    .map((v) => `${v.impact} ${v.id}: ${v.help}\n    ${v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(' '))
      .join('\n    ')}`)
    .join('\n  ');
  expect(blocking, `${label}\n  ${detail}`).toEqual([]);
}

test('@smoke phase 10: the public pages have no serious accessibility failures',
  async ({ page }) => {
  test.setTimeout(180_000);
  for (const [path, label] of [
    ['/', 'landing'],
    ['/merge-pdf', 'a tool page'],
    ['/about', 'about'],
    ['/legal/privacy', 'privacy'],
    ['/verify', 'verify'],
    ['/auth/login', 'login'],
    ['/auth/register', 'register'],
    // Added 2026-08-24 (Phase 11). Three new public reading surfaces, and the
    // guide article is scanned rather than only the index: the article is
    // where the new markup is — the byline, the `.notice`, the related-tools
    // cards — and an index that lists twelve links exercises none of it.
    ['/contact', 'contact'],
    ['/guides', 'the guides index'],
    ['/guides/are-electronic-signatures-legally-binding', 'a guide article'],
  ] as const) {
    await page.goto(path);
    await scan(page, `${label} (${path})`);
  }
});

test('phase 10: the signed-in app has no serious accessibility failures',
  async ({ page }) => {
  test.setTimeout(300_000);
  await registerAndLogin(page, 'p10a11y');
  await scan(page, 'dashboard (empty)');

  await uploadFiles(page, ['text.pdf']);
  await expect(page.locator('[data-test=doc-card]').first()).toBeVisible({
    timeout: 60_000,
  });
  await scan(page, 'dashboard (with documents)');

  // The workspace itself, and each panel a person actually works in — the
  // first version of this test was named for the workspace and never opened
  // it, which is the kind of coverage that reads as green and is not.
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);
  await scan(page, 'workspace (viewer)');

  for (const [toggle, label] of [
    ['annotate-toggle', 'annotate'],
    ['edit-toggle', 'edit'],
    ['protect-toggle', 'protect'],
    ['convert-toggle', 'convert'],
  ] as const) {
    const button = page.locator(`[data-test=${toggle}]`);
    if (await button.count()) {
      await button.click();
      await page.waitForTimeout(500);
      await scan(page, `workspace (${label})`);
      await button.click();   // leave the panel as we found it
    }
  }

  await page.goto('/app/settings');
  await expect(page.locator('[data-test=usage-table]')).toBeVisible();
  await scan(page, 'settings');

  // Panels that only exist once something is clicked are exactly where a
  // contrast or label failure hides — scanning the default state alone is how
  // a panel ships with 4.3:1 text and a green suite.
  await page.click('[data-test=delete-account]');
  await expect(page.locator('[data-test=delete-confirm]')).toBeVisible();
  await scan(page, 'settings (delete confirmation)');
});

test('phase 10: a signer can complete the ceremony with the keyboard alone',
  async ({ page, browser }) => {
  test.setTimeout(300_000);
  const { registerVerifiedAndLogin, uniqueEmail, mailFor } = await import('./helpers');
  const signer = uniqueEmail('p10keyboard');
  await registerVerifiedAndLogin(page, 'p10sender');
  await uploadFiles(page, ['text.pdf']);
  await expect(page.locator('[data-test=doc-card]').first()).toBeVisible({
    timeout: 60_000,
  });

  // The envelope is built through the API rather than by dragging a box: what
  // this test is about is the *signer's* keyboard journey, and a mouse-driven
  // setup would only add a way for it to fail for an unrelated reason.
  const token = await page.evaluate(
    () => localStorage.getItem('zen_access') ?? '',
  );
  const auth = { Authorization: `Bearer ${token}` };
  const documents = await (
    await page.request.get('/api/documents/', { headers: auth })
  ).json();
  const documentId = documents.results[0].id;

  const request = await (
    await page.request.post('/api/sign-requests/', {
      headers: auth,
      data: { document: documentId, title: 'Keyboard test' },
    })
  ).json();
  const withRecipients = await (
    await page.request.patch(`/api/sign-requests/${request.id}/`, {
      headers: auth,
      data: { recipients: [{ email: signer, role: 'signer', order: 1 }] },
    })
  ).json();
  const recipientId = withRecipients.recipients[0].id;
  const withFields = await (
    await page.request.patch(`/api/sign-requests/${request.id}/`, {
      headers: auth,
      data: {
        fields: [{
          recipient_id: recipientId, page: 0, x: 0.1, y: 0.7, w: 0.3, h: 0.06,
          type: 'signature', required: true,
        }],
      },
    })
  ).json();
  const fieldId = withFields.fields_[0].id;
  const sent = await page.request.post(
    `/api/sign-requests/${request.id}/send/`, { headers: auth });
  expect(sent.ok(), await sent.text()).toBeTruthy();

  const invite = await mailFor(signer);
  const link = /https?:\/\/[^\s]+\/s\/[A-Za-z0-9_-]+/.exec(invite.body)![0];

  const guest = await browser.newContext();
  const ceremony = await guest.newPage();
  await ceremony.goto(link);
  await expect(ceremony.locator('[data-test=agree]')).toBeVisible({
    timeout: 60_000,
  });
  await scan(ceremony, 'ceremony (consent)');

  // --- Keyboard only from here: no click(), no mouse. ---
  await tabTo(ceremony, 'agree');
  await ceremony.keyboard.press('Space');
  await expect(ceremony.locator('[data-test=agree]')).toBeChecked();

  await tabTo(ceremony, 'consent-continue');
  await ceremony.keyboard.press('Enter');

  await expect(ceremony.locator('[data-test=ceremony-field]').first()).toBeVisible({
    timeout: 60_000,
  });
  await scan(ceremony, 'ceremony (signing)');

  // The signature itself, typed. Drawing on a canvas is not a keyboard
  // gesture; the Type tab is the accessible alternative, so it is the one that
  // has to work — a ceremony a signer cannot *finish* is not keyboard-complete.
  await tabTo(ceremony, `sign-${fieldId}`);
  await ceremony.keyboard.press('Enter');
  await expect(ceremony.locator('[data-test=ceremony-pad]')).toBeVisible();
  await scan(ceremony, 'ceremony (signature pad)');

  // Inside a focus trap Tab cannot leave the dialog, so `tabTo` either finds
  // the control or spins inside it — which is exactly the assertion.
  await tabTo(ceremony, 'sig-tab-type');
  await ceremony.keyboard.press('Enter');
  await tabTo(ceremony, 'sig-text');
  await ceremony.keyboard.type('Ada Lovelace');
  await tabTo(ceremony, 'sig-font-dancing');
  await ceremony.keyboard.press('Enter');
  // "Use this" is disabled until the server render arrives, and a disabled
  // button is not in the tab order — tabbing for it before the preview exists
  // reports it unreachable, which it is not.
  await expect(ceremony.locator('[data-test=sig-preview]')).toBeVisible({
    timeout: 30_000,
  });
  await tabTo(ceremony, 'sig-use');
  await ceremony.keyboard.press('Enter');

  await expect(ceremony.locator('[data-test=ceremony-pad]')).toHaveCount(0);
  await expect(ceremony.locator('[data-test=field-done]')).toBeVisible();

  await tabTo(ceremony, 'finish');
  await ceremony.keyboard.press('Enter');
  await expect(ceremony.locator('[data-test=done-screen]')).toBeVisible({
    timeout: 60_000,
  });
  await scan(ceremony, 'ceremony (done)');
  await guest.close();
});
