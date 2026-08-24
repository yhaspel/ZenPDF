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
 * The same question, asked of the scrollers *inside* the page.
 *
 * `documentElement.scrollWidth` is blind to this by construction: the pane is a
 * scroller, so content too wide for it stays inside it and the document stays
 * exactly 390. Measured 2026-08-24 while the sweep above was green in all nine
 * modes — **Edit drew its page at 750 px and Protect and Sign at 680, inside a
 * pane 327 px wide**, and five of the six panes have no zoom control, so there
 * was no way to bring the page into view at all.
 *
 * Scoped to `.ws-pane-main`: the bottom bar's opener and mode rows scroll
 * sideways by design and are not in it. `sr-only` and the vendor toolbar are
 * excluded for the same reason axe excludes them — a 1 px clipped live region
 * and pdf.js's own chrome are not our page.
 *
 * **Only what is on screen.** pdf.js parks `#viewsManager` — the sidebar's
 * thumbnails/outline switcher, which this product never shows because it has a
 * Pages drawer of its own — at `visibility: hidden` rather than `display: none`,
 * laid out 197 px wide over the page with its 200 px header inside it. That is
 * five pixels of overflow in a panel nobody can see, and it is what this
 * assertion caught first. Computed `visibility` inherits, so testing the element
 * covers the whole parked subtree; `display: none` needs no test because it
 * measures `clientWidth === 0` and the filter below already drops it. An
 * overflow a user can actually reach still fails — proven by injecting one.
 */
async function expectNoPaneOverflow(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(() =>
    [...document.querySelectorAll('.ws-pane-main, .ws-pane-main *')]
      .filter((el) => !el.closest('#toolbarContainer') && !el.classList.contains('sr-only'))
      .filter((el) => getComputedStyle(el).visibility !== 'hidden')
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)
      .map((el) => ({
        el: el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 40),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      })),
  );
  expect(over, `${where}: content is wider than its pane — ${JSON.stringify(over)}`).toEqual([]);
}

/**
 * The bar is the last row of a viewport-high column, in this mode too.
 *
 * Added after the sideways check let a *vertical* overflow through: in Edit,
 * Sign and Protect — the three modes whose page renders at 900 px — the
 * document grew to 1348 px against 844 and the bottom bar went with it, off
 * the bottom of the screen. `scrollWidth === visualViewport.width` stayed true
 * throughout, because a vertical scrollbar narrows both of them equally. A bar
 * that scrolls away is not a persistent bar, so it is measured directly.
 */
async function expectBarIsTheLastRow(page: Page, where: string): Promise<void> {
  const measured = await page.evaluate(() => ({
    barBottom: Math.round(
      document.querySelector('[data-test=ws-bottom-bar]')!.getBoundingClientRect().bottom,
    ),
    viewport: Math.round(window.innerHeight),
    documentHeight: document.documentElement.scrollHeight,
  }));
  expect(
    measured.barBottom,
    `${where}: the bottom bar is not at the bottom — ${JSON.stringify(measured)}`,
  ).toBeGreaterThanOrEqual(measured.viewport - 1);
  expect(
    measured.documentHeight,
    `${where}: the document scrolls vertically — ${JSON.stringify(measured)}`,
  ).toBeLessThanOrEqual(measured.viewport + 1);
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
 * It began as a way around a defect: at 390 the dashboard kept its desktop
 * sidebar beside a two-column grid, a file card measured **47 px**, and its ⋯
 * button sat on top of the thumbnail that opens the document, so every
 * `[data-test=open-doc]` click here was refused with *"doc-menu subtree
 * intercepts pointer events"*. That was recorded rather than papered over with
 * `force: true`, and it is fixed now — the card is 164 px and *the account
 * screens at 390* below opens a document from the dashboard to prove it.
 *
 * This route stays anyway, on its own merits: it is how somebody on a phone
 * actually arrives at a document (§21.6 — the page must *be* the tool), and it
 * keeps the other tests in this file independent of the dashboard's layout.
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
    const pane = document.querySelector('.ws-pane-main')!.getBoundingClientRect();
    return { paneWidth: Math.round(pane.width), layout: document.documentElement.clientWidth };
  });
  // The page pane owns the whole width: no rail is standing beside it.
  expect(geometry.paneWidth).toBe(geometry.layout);

  await expectNoSidewaysScroll(page, 'view');
  await expectBarIsTheLastRow(page, 'view');

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
    await expectBarIsTheLastRow(page, key);
    await expectNoPaneOverflow(page, key);
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

test('phase 10 (mobile): nothing scrolls sideways under dir="rtl" either',
  async ({ page }) => {
  test.setTimeout(240_000);
  // The LTR sweep cannot catch this class of defect and never could: the
  // scrollable overflow region starts at the inline-start corner, so a box at
  // x = −10000 is unreachable under `dir="ltr"` and scrollable under `rtl`.
  // The offender was `ngx-extended-pdf-viewer`'s own live region and its inline
  // `left: -10000px` — measured at 10 400 px of document against a 414 px
  // phone — which is why this is asserted only after the viewer has painted,
  // and why it also checks the region is still a live region: hiding it would
  // "fix" the number by silencing a screen reader.
  await openFirstDocument(page, 'p10mrtl', 'text.pdf');
  await expectPageDrew(page);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });

  const region = page.locator('body > .sr-only[aria-live]');
  await expect(region).toHaveCount(1);

  await expectNoSidewaysScroll(page, 'view, rtl');

  const stuck = await page.evaluate(() => {
    const el = document.scrollingElement!;
    el.scrollLeft = -5000;
    const got = el.scrollLeft;
    el.scrollLeft = 0;
    return got;
  });
  expect(stuck, 'the document scrolled to the inline end').toBe(0);

  // Still announced: hidden by clipping, not by removal.
  const state = await page.evaluate(() => {
    const el = document.querySelector('body > .sr-only[aria-live]') as HTMLElement;
    const cs = getComputedStyle(el);
    return {
      display: cs.display,
      visibility: cs.visibility,
      insideAriaHidden: el.closest('[aria-hidden="true"]') !== null,
      live: el.getAttribute('aria-live'),
    };
  });
  expect(state).toEqual({
    display: 'block', visibility: 'visible', insideAriaHidden: false, live: 'polite',
  });
});

test('phase 10 (mobile): pdf.js does not put 152 controls in front of ours',
  async ({ page }) => {
  test.setTimeout(240_000);
  // `ngx-extended-pdf-viewer` renumbers every focusable element under the
  // viewer with a positive tabindex — measured at **152**, numbered 1 to 152 —
  // and a positive tabindex is visited before every `tabindex="0"` in the
  // document. A keyboard user met 152 vendor controls, most of them invisible,
  // before the back link. `ViewerTabOrder` flattens them; this is the assertion
  // that says so, and it fails on the unfixed build.
  await openFirstDocument(page, 'p10mtab', 'text.pdf');
  await expectPageDrew(page);

  const positive = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[tabindex]')]
      .filter((el) => el.tabIndex > 0)
      .map((el) => ({ id: el.id, tabIndex: el.tabIndex })));
  expect(positive, `positive tabindex: ${JSON.stringify(positive.slice(0, 5))}`).toEqual([]);

  // And the editor radiogroup the `show*Editor` inputs already turned off is
  // out of the accessibility tree, not merely wearing an invisible button.
  const radios = await page.evaluate(() =>
    [...document.querySelectorAll('pdf-shy-button[role=radio]')]
      .filter((el) => el.getClientRects().length > 0).length);
  expect(radios, 'editor radio hosts still rendered').toBe(0);
});

test('phase 10 (mobile): the account screens fit a phone, and a file can be opened',
  async ({ page }) => {
  test.setTimeout(240_000);
  // The defect this asserts against, measured at 390 × 844 on 2026-08-24 with an
  // empty library: `/app/dashboard` and `/app/settings` both drew a **546 px**
  // document, because the app-shell nav's min-content floor is 417 px with the
  // address at zero width. And the sidebar kept its 224 px column at every
  // width, so the main column was 110 px, a file card **47**, and the card's ⋯
  // menu sat on top of the 14 × 18 button that opens the document — which is
  // why `openFirstDocument` in this very file goes in through the tool page.
  await registerAndLogin(page, 'p10mdash');
  // Assert the signed-in header on the page the helper landed on, before any
  // `goto`: a fresh document load re-reads the token from storage, and this
  // spec is about the header's *width*, not about the session.
  await expect(page.locator('[data-test=nav-settings]')).toBeVisible();
  await expectNoSidewaysScroll(page, '/app/dashboard');

  await page.click('[data-test=nav-settings]');
  await expect(page).toHaveURL(/\/app\/settings/);
  await expect(page.locator('[data-test=nav-dashboard]')).toBeVisible();
  await expectNoSidewaysScroll(page, '/app/settings');

  await page.click('[data-test=nav-dashboard]');
  await expect(page).toHaveURL(/\/app\/dashboard/);
  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  const card = page.locator('[data-test=doc-card]').first();
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expectNoSidewaysScroll(page, '/app/dashboard with a card');

  // A card wide enough to be a card, and every one of its controls reachable.
  // Scrolled into view first: `elementFromPoint` answers about the viewport, so
  // a card below the fold reports `null` and the check would pass or fail for a
  // reason that has nothing to do with what covers what.
  await card.scrollIntoViewIfNeeded();
  const geometry = await page.evaluate(() => {
    const el = document.querySelector('[data-test=doc-card]')!;
    const opener = el.querySelector('[data-test=open-doc]')!;
    const box = opener.getBoundingClientRect();
    const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return {
      card: Math.round(el.getBoundingClientRect().width),
      openIsOnTop: at === opener || opener.contains(at),
      // §6's floor is a *target*, so the box measured is the label where there
      // is one. The select checkbox is native and keeps its 17 px platform
      // paint — sizing the input itself to 44 was tried and reverted, because
      // a stretched native checkbox draws a 44 px empty square over the
      // thumbnail. Its 44 px comes from the `<label>` around it, exactly as
      // §3 already specifies for the OCR rows.
      small: [...el.querySelectorAll(
        '[data-test=doc-menu], [data-test=star-toggle], [data-test=select-doc]')]
        .map((c) => {
          const b = (c.closest('label') ?? c).getBoundingClientRect();
          return { t: c.getAttribute('data-test'), w: Math.round(b.width), h: Math.round(b.height) };
        })
        .filter((m) => m.w < 44 || m.h < 44),
    };
  });
  expect(geometry.card, 'the file card is too narrow to use').toBeGreaterThan(120);
  expect(geometry.openIsOnTop, 'something covers the button that opens the document').toBe(true);
  expect(geometry.small, `card controls under the 44 px floor: ${JSON.stringify(geometry.small)}`)
    .toEqual([]);

  // And the thing the whole detour existed for: it opens.
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);
  await expect(page.locator('[data-test=ws-bottom-bar]')).toBeVisible();
});
