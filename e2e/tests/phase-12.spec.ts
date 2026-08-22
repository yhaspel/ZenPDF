import { expect, test } from '@playwright/test';

import { registerAndLogin, uploadFiles } from './helpers';

/**
 * Phase 12 — usability add-ons (phase-12 §6 "E2E").
 *
 * Copy a mark, paste it, right-click the copy and delete it, undo, nudge it
 * with the arrow keys, save. Plus the two behaviours that used to destroy work
 * on a single click: a redaction area and a signature placement now survive
 * being clicked on.
 */

// Same reason phase-3 does it: the overlay draws a full page, and at the
// default 720 px viewport its lower half is not there to click.
test.use({ viewport: { width: 1440, height: 1100 } });

type Page = import('@playwright/test').Page;

async function fitPage(page: Page, prefix: string) {
  await page.click(`[data-test=${prefix}-zoom-out]`);
  await page.click(`[data-test=${prefix}-zoom-out]`);
  await expect(page.locator('[data-test=page-overlay]')).toBeVisible();
}

async function dragOnPage(page: Page, from: [number, number], to: [number, number]) {
  const surface = page.locator('[data-test=page-overlay]');
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

async function rightClickOnPage(page: Page, at: [number, number]) {
  const surface = page.locator('[data-test=page-overlay]');
  const box = (await surface.boundingBox())!;
  await page.mouse.click(
    box.x + box.width * at[0],
    box.y + box.height * at[1],
    { button: 'right' },
  );
}

/**
 * An element's box once it has stopped moving.
 *
 * Angular renders zonelessly here, so a click that changes what is selected
 * leaves the previous item's outline on screen for a frame or two. Reading the
 * box straight after the click therefore measures the *wrong mark*, and the
 * nudge assertion below compares two different shapes. Two identical readings
 * in a row mean the frame the click caused has landed.
 *
 * A **null** reading is one of those unsettled frames, not a fatal error — and
 * until 2026-08-22 this asserted non-null on it and crashed with
 * `Cannot read properties of null (reading 'x')` instead of polling again. That
 * cost 3 red runs in 12 while `main` was 0 in 20, and the crash reported the
 * helper rather than anything about the product: the final DOM had the outline,
 * the right size, in the right place, and sampling the element inside the page
 * at animation-frame resolution across this whole sequence found **no** absent
 * and **no** zero-sized frame. Waiting is what this function is for.
 */
async function settledBox(locator: ReturnType<Page['locator']>) {
  let previous: Awaited<ReturnType<typeof locator.boundingBox>> = null;
  for (let i = 0; i < 40; i += 1) {
    const current = await locator.boundingBox();
    if (current && previous && current.x === previous.x && current.y === previous.y) {
      return current;
    }
    previous = current;
    await locator.page().waitForTimeout(100);
  }
  if (!previous) {
    throw new Error('the selection outline never reported a box');
  }
  return previous;
}

test('phase 12: copy, paste, right-click delete, undo and nudge a mark', async ({ page }) => {
  await registerAndLogin(page, 'p12');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await fitPage(page, 'annot');

  // Draw one rectangle.
  await page.click('[data-test=tool-square]');
  await dragOnPage(page, [0.2, 0.2], [0.4, 0.3]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);

  // Copy it and paste — two marks, and the paste is offset, not on top.
  await page.click('[data-test=tool-select]');
  await page.locator('[data-test=comment-jump]').first().click();
  await page.keyboard.press('ControlOrMeta+c');
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);
  await expect(page.locator('[data-test=annot-paste]')).toBeVisible();

  // Right-click the copy and delete it from the menu.
  await rightClickOnPage(page, [0.25, 0.25]);
  const menu = page.locator('[data-test=overlay-menu]');
  await expect(menu).toBeVisible();
  await menu.locator('[data-test=overlay-menu-delete]').click();
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);

  // ⌘Z brings it back.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);

  // Right-click with nothing under the pointer offers Paste and nothing else.
  await rightClickOnPage(page, [0.85, 0.85]);
  await expect(menu.locator('[role=menuitem]')).toHaveCount(1);
  await expect(menu.locator('[data-test=overlay-menu-paste]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Nudge the selection: the mark moves, the pane does not scroll away.
  // Selecting from a comment row hands the keyboard to the page itself, which
  // is what makes the arrows reach the overlay rather than scrolling the pane.
  await page.locator('[data-test=comment-jump]').first().click();
  await expect(page.locator('app-page-overlay')).toBeFocused();
  const selection = page.locator('[data-test=overlay-selection]');
  const before = await settledBox(selection);
  for (let i = 0; i < 10; i += 1) await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await selection.boundingBox())!.x)
    .toBeGreaterThan(before.x);

  // And it all saves as one batch.
  await page.click('[data-test=annot-save]');
  await expect(page.locator('[data-test=toast-success]').filter({ hasText: 'Annotations saved' }))
    .toBeVisible({ timeout: 60_000 });
});

test('phase 12: the shortcuts sheet lists what the app implements', async ({ page }) => {
  await registerAndLogin(page, 'p12keys');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();

  // The workspace binds the sheet's shortcut when it is constructed, so wait
  // for a control it owns before pressing the key — otherwise the keystroke is
  // sent into a page that has nothing listening for it, and the sheet never
  // opens however long the assertion waits afterwards.
  await expect(page.locator('[data-test=shortcuts-open]')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+/');
  const sheet = page.locator('[data-test=shortcuts-help]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-test=shortcut-row]')).toHaveCount(15);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // The bar button opens the same sheet.
  await page.click('[data-test=shortcuts-open]');
  await expect(sheet).toBeVisible();
});

test('phase 12: a click on a redaction area selects it rather than destroying it',
  async ({ page }) => {
    await registerAndLogin(page, 'p12redact');
    await uploadFiles(page, ['text.pdf']);
    await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
    await page.click('[data-test=protect-toggle]');
    await page.click('[data-test=tab-redact]');

    const draw = page.locator('[data-test=draw-areas]');
    await draw.click();
    await expect(draw).toHaveAttribute('aria-pressed', 'true');
    await dragOnPage(page, [0.2, 0.2], [0.5, 0.28]);
    await expect(page.locator('[data-test=area-count]')).toContainText('1 area');
    await draw.click(); // stop drawing
    // Wait for the tool to actually change hands. While the rect tool is armed
    // the drawn area is `pointer-events: none`, so a click sent before this
    // frame lands on the page behind it and selects nothing — which looked
    // exactly like the destructive-click regression this test exists to catch.
    await expect(draw).toHaveAttribute('aria-pressed', 'false');

    // The gesture that used to delete it.
    const surface = page.locator('[data-test=page-overlay]');
    const box = (await surface.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.24);
    await expect(page.locator('[data-test=area-count]')).toContainText('1 area');
    await expect(page.locator('[data-test=overlay-selection]')).toBeVisible();

    // Removing it is now explicit — and undoable.
    await page.click('[data-test=area-remove]');
    await expect(page.locator('[data-test=area-count]')).toHaveCount(0);
    await page.click('[data-test=protect-undo]');
    await expect(page.locator('[data-test=area-count]')).toContainText('1 area');
  });
