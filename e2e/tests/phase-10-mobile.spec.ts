import AxeBuilder from '@axe-core/playwright';
import { Page, expect, test } from '@playwright/test';
import path from 'node:path';

import { expectOverlayDrew, expectPageDrew } from './drew';
import { FIXTURES, registerAndLogin } from './helpers';

/**
 * The phone workspace (design contract §3 **Phone workspace**).
 *
 * **The measurement trap this spec exists inside.** On 2026-08-21 a real
 * overflow at 390 px was invisible for a day because it was looked for with
 * *device emulation on*: with `isMobile: true` Chrome gives the page a virtual
 * layout viewport that widens to fit the content and then scales the whole app
 * down — 609 px of toolbar drawn at about 64 %, and `scrollWidth` equal to
 * `innerWidth` the entire time. So this file sets an **exact 390 × 844 viewport
 * and nothing else**: `isMobile` is left alone because chromium's default is
 * already `false`, and *naming* it would make the `BROWSERS=all` Firefox
 * project refuse to start.
 *
 * For the same reason it is deliberately **not tagged `@mobile`**: that tag
 * routes a spec into the `mobile-chrome` / `mobile-safari` projects, which are
 * `devices['Pixel 7']` and `devices['iPhone 14']` — `isMobile: true`, which is
 * exactly the instrument that hid the defect.
 */
test.use({ viewport: { width: 390, height: 844 } });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
/** PDF.js's own toolbar — third-party markup, excluded as in `phase-10-a11y`. */
const VENDOR = ['#toolbarContainer', '#editorModeButtons', 'pdf-shy-button'];

function successToast(page: Page, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

/**
 * The whole point, asserted the way the 08-21 repair should have been.
 *
 * `scrollWidth` against `visualViewport.width` rather than against 390:
 * a desktop Chrome window reserves a classic scrollbar, so the layout viewport
 * is 375 there and 390 on a phone, and pinning the number would assert the
 * runner's chrome rather than the product's.
 */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const measured = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    visualViewport: Math.round(window.visualViewport?.width ?? window.innerWidth),
  }));
  expect(
    measured.scrollWidth,
    `${where}: the page is wider than the screen — ${JSON.stringify(measured)}`,
  ).toBe(measured.visualViewport);
}

/**
 * Tap a mode in the bottom bar and wait for its surface.
 *
 * Sign opens its signature pad on arrival when the session has no signature
 * yet — a §3 modal, which covers the bar as a modal should. It is dismissed
 * here so the sweep can carry on; that behaviour is Phase 8's and is not what
 * this file is about.
 */
async function mode(page: Page, key: string, surface: string): Promise<void> {
  const pad = page.locator('[data-test=signature-dialog]');
  if (await pad.isVisible().catch(() => false)) {
    await page.click('[data-test=signature-cancel]');
    await expect(pad).toHaveCount(0);
  }
  await page.click(`[data-test=ws-bottom-mode][data-mode=${key}]`);
  await expect(page.locator(`[data-test=${surface}]`)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`[data-test=ws-bottom-mode][data-mode=${key}]`))
    .toHaveAttribute('aria-pressed', 'true');
}

/** Open a rail's drawer from the bottom bar and wait for the sheet. */
async function openDrawer(page: Page, key: string): Promise<void> {
  await page.click(`[data-test=ws-drawer-open][data-drawer=${key}]`);
  await expect(page.locator(`[data-ws-drawer=${key}]`)).toHaveAttribute('role', 'dialog');
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toBeVisible();
}

/**
 * Into the workspace at 390 px, **through the tool page and not the dashboard**.
 *
 * Not a shortcut: at 390 the dashboard keeps its desktop sidebar beside a
 * two-column grid, so a file card is about 110 px wide and its ⋯ button sits on
 * top of the thumbnail that opens the document — measured here, where every
 * `[data-test=open-doc]` click was refused with *"doc-menu subtree intercepts
 * pointer events"*. That is the open queue row of 2026-08-23, it is
 * `/app/dashboard` and not `/app/doc/:id`, and this prompt's scope is the
 * workspace — so the path around it is recorded rather than papered over with
 * `force: true`, which would have hidden a real defect to test a different one.
 *
 * The tool page is also the honest way in: it is how somebody on a phone
 * actually arrives at a document (§21.6 — the page must *be* the tool).
 */
async function openFirstDocument(
  page: Page, prefix: string, fixture: string, tool = 'annotate-pdf',
): Promise<void> {
  await registerAndLogin(page, prefix);
  await page.goto(`/${tool}`);
  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, fixture));
  await page.click('[data-test=tool-run]');
  await expect(page).toHaveURL(/\/app\/doc\//, { timeout: 90_000 });
  await expect(page.locator('[data-test=ws-bottom-bar]')).toBeVisible();
  // A tool page hands over in its own mode; every test here starts from View,
  // which is also the first proof that the bottom bar routes a mode change.
  await mode(page, 'view', 'pdf-viewer');
}

test('phase 10 (mobile): the page is first, the modes are at the bottom, nothing scrolls sideways',
  async ({ page }) => {
  test.setTimeout(240_000);
  await openFirstDocument(page, 'p10mfirst', 'text.pdf');

  // The bar shrank: the nine modes are at the bottom now, and the cluster the
  // top bar used to carry is behind ⋯.
  await expect(page.locator('[data-test=view-toggle]')).toHaveCount(0);
  await expect(page.locator('[data-test=ws-more]')).toBeVisible();
  await expect(page.locator('[data-test=ws-bottom-mode]')).toHaveCount(9);
  await expect(page.locator('[data-test=doc-title]')).toBeVisible();

  // §6's 44 px floor, on every control the phone layout adds. The 36 px
  // exemption is for dense *desktop* toolbars, and this is neither.
  const short = await page.evaluate(() => [...document.querySelectorAll(
    '[data-test=ws-more], [data-test=ws-bottom-mode], [data-test=ws-drawer-open],'
    + ' [data-test=ws-bottom-undo], [data-test=ws-bottom-redo], [data-test=ws-bottom-primary]',
  )].map((el) => {
    const box = el.getBoundingClientRect();
    return { what: el.getAttribute('data-test'), w: Math.round(box.width), h: Math.round(box.height) };
  }).filter((m) => m.w < 44 || m.h < 44));
  expect(short, `controls under the 44 px floor: ${JSON.stringify(short)}`).toEqual([]);

  // Page first: the document, at fit-to-width, above the bar and below the bar
  // at the top — and it actually painted.
  await expectPageDrew(page);
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector('[data-test=ws-bottom-bar]')!.getBoundingClientRect();
    const pane = document.querySelector('.ws-pane-main')!.getBoundingClientRect();
    return {
      barBottom: Math.round(bar.bottom),
      viewport: Math.round(window.innerHeight),
      paneWidth: Math.round(pane.width),
      layout: document.documentElement.clientWidth,
    };
  });
  // The bar is the last row of a full-height column, not a floating strip.
  expect(Math.abs(geometry.barBottom - geometry.viewport)).toBeLessThanOrEqual(1);
  // The page pane owns the whole width: no rail is standing beside it.
  expect(geometry.paneWidth).toBe(geometry.layout);

  await expectNoSidewaysScroll(page, 'view');

  for (const [key, surface] of [
    ['organize', 'organize-grid'],
    ['edit', 'edit-mode'],
    ['annotate', 'annotate-mode'],
    ['forms', 'forms-mode'],
    ['convert', 'convert-mode'],
    ['compare', 'compare-mode'],
    ['sign', 'sign-mode'],
    ['protect', 'protect-mode'],
    ['view', 'pdf-viewer'],
  ] as const) {
    await mode(page, key, surface);
    await expectNoSidewaysScroll(page, key);
  }
});

test('phase 10 (mobile): the rails are drawers — tap, Escape, scrim, and focus comes back',
  async ({ page }) => {
  test.setTimeout(240_000);
  await openFirstDocument(page, 'p10mdrawer', 'text.pdf');

  // --- View: the Pages drawer, and a jump to page 3. ---
  await expect(page.locator('[data-test=ws-drawer-open]')).toHaveCount(1);
  await openDrawer(page, 'start');
  await expect(page.locator('[data-ws-drawer=start] .ws-drawer-title')).toHaveText('Pages');
  await page.locator('[data-ws-drawer=start] [data-test=rail-thumb]').nth(2).click();
  await page.click('[data-ws-drawer=start] [data-test=ws-drawer-close]');
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);
  await expect(page.locator('#pageNumber')).toHaveValue('3', { timeout: 30_000 });

  // --- Annotate: two drawers, one at a time. ---
  await mode(page, 'annotate', 'annotate-mode');
  await expect(page.locator('[data-test=ws-drawer-open]')).toHaveCount(2);

  await openDrawer(page, 'start');
  // One at a time, and the scrim is what enforces it: with a sheet open the
  // bottom bar is behind it, so the other opener cannot be tapped at all. The
  // way to the second panel is to close the first, which is what a modal sheet
  // means and is the same rule the focus trap applies to the keyboard.
  const openerIsReachable = await page.evaluate(() => {
    const opener = document.querySelector('[data-test=ws-drawer-open][data-drawer=end]')!;
    const box = opener.getBoundingClientRect();
    const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return at === opener || opener.contains(at);
  });
  expect(openerIsReachable).toBe(false);
  await page.locator('[data-test=ws-drawer-scrim]').click({ position: { x: 20, y: 20 } });
  await openDrawer(page, 'end');
  await expect(page.locator('[data-ws-drawer=start]')).not.toHaveAttribute('role', 'dialog');
  await expect(page.locator('[data-ws-drawer=end] .ws-drawer-title')).toHaveText('Comments');

  // Escape closes it, and focus lands back on the button that opened it.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);
  expect(await page.evaluate(
    () => (document.activeElement as HTMLElement)?.dataset?.['drawer'],
  )).toBe('end');

  // A tap on the scrim closes it too.
  await openDrawer(page, 'start');
  await page.locator('[data-test=ws-drawer-scrim]').click({ position: { x: 20, y: 20 } });
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);
  await expect(page.locator('[data-ws-drawer=start]')).not.toHaveAttribute('role', 'dialog');

  // --- Keyboard only: reach the opener, open, reach Close, close. ---
  await page.locator('[data-test=ws-drawer-open][data-drawer=start]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-ws-drawer=start]')).toHaveAttribute('role', 'dialog');
  // The trap put focus inside the sheet without anybody pressing Tab.
  expect(await page.evaluate(
    () => (document.activeElement as HTMLElement)?.dataset?.['test'],
  )).toBe('ws-drawer-close');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);

  // --- The workspace bar's own cluster, in the More sheet. ---
  await page.click('[data-test=ws-more]');
  await expect(page.locator('[data-ws-drawer=more]')).toHaveAttribute('role', 'dialog');
  for (const item of ['undo-version', 'redo-version', 'tool-split', 'tool-compress',
    'download', 'shortcuts-open']) {
    // Exactly one of each in the whole document — the bar and the sheet render
    // the same template, never two copies.
    await expect(page.locator(`[data-test=${item}]`)).toHaveCount(1);
    await expect(page.locator(`[data-ws-drawer=more] [data-test=${item}]`)).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);
});

test('phase 10 (mobile): a real operation in each mode group, and a download',
  async ({ page }) => {
  test.setTimeout(300_000);
  await openFirstDocument(page, 'p10mops', 'text.pdf');

  // --- Organize: rotate a page. Its toolbar is in the pane, not a drawer. ---
  await mode(page, 'organize', 'organize-grid');
  await page.locator('[data-test=organize-page]').nth(0).click();
  await page.click('[data-test=op-rotate]');
  await expect(successToast(page, 'Rotated 1 page')).toBeVisible({ timeout: 60_000 });

  // --- Annotate: draw a square, save from the bottom bar's docked primary. ---
  await mode(page, 'annotate', 'annotate-mode');
  await expectOverlayDrew(page);
  await openDrawer(page, 'start');
  await page.click('[data-test=tool-square]');
  await expect(page.locator('[data-test=tool-square]')).toHaveAttribute('aria-pressed', 'true');
  // Choosing a tool leaves the sheet open on purpose — the palette is a set of
  // toggles, not a menu — so it is closed before drawing on the page under it.
  // Scoped to the sheet: annotate has two drawers and therefore two heads.
  await page.click('[data-ws-drawer=start] [data-test=ws-drawer-close]');
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);
  const surface = page.locator('[data-test=page-overlay]');
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);
  // The page bar's own Save is hoisted below `md`; the bar's is the one on
  // screen, and it is the same operation.
  await expect(page.locator('[data-test=annot-save]')).toBeHidden();
  await expect(page.locator('[data-test=ws-bottom-primary]')).toHaveText('Save');
  await page.click('[data-test=ws-bottom-primary]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });

  // --- Edit: rewrite a text block and save. ---
  await mode(page, 'edit', 'edit-mode');
  await expectOverlayDrew(page);
  await page.locator('[data-test=overlay-item]').first().click();
  const editor = page.locator('[data-test=block-editor-input]');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.fill('Rewritten on a phone');
  await page.click('[data-test=block-editor-ok]');
  await expect(page.locator('[data-test=ws-bottom-primary]')).toBeEnabled();
  await page.click('[data-test=ws-bottom-primary]');
  await expect(successToast(page, 'Text updated')).toBeVisible({ timeout: 60_000 });

  // --- Protect: put a password on it, from inside the drawer that asks. ---
  await mode(page, 'protect', 'protect-mode');
  await openDrawer(page, 'start');
  await page.fill('[data-test=owner-password]', 'owner-key-9999');
  await page.fill('[data-test=user-password]', 'open-sesame-42');
  await page.fill('[data-test=confirm-password]', 'open-sesame-42');
  await page.click('[data-test=apply-protection]');
  await expect(successToast(page, 'Document protected')).toBeVisible({ timeout: 90_000 });
  await page.click('[data-ws-drawer=start] [data-test=ws-drawer-close]');
  await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);

  // --- Download, from the More sheet. ---
  await page.click('[data-test=ws-more]');
  const download = page.waitForEvent('download');
  await page.click('[data-ws-drawer=more] [data-test=download]');
  expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
});

test('phase 10 (mobile): fill a form field and save it from the bottom bar',
  async ({ page }) => {
  test.setTimeout(240_000);
  await openFirstDocument(page, 'p10mform', 'form-multi.pdf', 'fill-pdf-form');

  await mode(page, 'forms', 'forms-mode');
  await expect(page.locator('.annotationLayer [name="attendee"]')).toBeVisible({
    timeout: 60_000,
  });
  await page.locator('.annotationLayer [name="attendee"]').fill('Ada on a phone');

  await expect(page.locator('[data-test=ws-bottom-primary]')).toHaveText('Save');
  await page.click('[data-test=ws-bottom-primary]');
  await expect(successToast(page, 'Form saved')).toBeVisible({ timeout: 60_000 });

  // The panel is the same panel it always was — it is simply a sheet now.
  await openDrawer(page, 'start');
  await expect(page.locator('[data-test=field-attendee]')).toHaveValue('Ada on a phone');
  await expectNoSidewaysScroll(page, 'forms with the drawer open');
});

test('phase 10 (mobile): axe finds nothing serious in the phone workspace',
  async ({ page }) => {
  test.setTimeout(240_000);
  await openFirstDocument(page, 'p10ma11y', 'text.pdf');

  async function scan(label: string) {
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

  await scan('the phone workspace, view');
  await openDrawer(page, 'start');
  await scan('the Pages drawer, open');
  await page.keyboard.press('Escape');

  await page.click('[data-test=ws-more]');
  await scan('the More sheet, open');
  await page.keyboard.press('Escape');

  await mode(page, 'annotate', 'annotate-mode');
  await scan('the phone workspace, annotate');
  await openDrawer(page, 'end');
  await scan('the Comments drawer, open');
});
