import { expect, test } from '@playwright/test';
import path from 'node:path';

import { expectOverlayDrew } from './drew';
import { FIXTURES, IMAGES, registerAndLogin, uploadFiles } from './helpers';

/**
 * Phase 3 — annotations (phase-03 "Tests → E2E").
 *
 * Highlight text → add a note → draw an arrow → save → reload → all present →
 * flatten → sidebar empty → version history shows both steps.
 */

// The overlay renders a full page at 900 px wide (~1270 px tall). At the default
// 720 px viewport the lower half is simply not there to click — drags only
// appeared to work because pointer capture retargets events off-screen.
test.use({ viewport: { width: 1440, height: 1100 } });

/** Zoom the overlay out until the whole page is inside the viewport. */
async function fitPage(page: import('@playwright/test').Page) {
  await page.click('[data-test=annot-zoom-out]');
  await page.click('[data-test=annot-zoom-out]');
  await expect(page.locator('[data-test=page-overlay]')).toBeVisible();
}

function successToast(page: import('@playwright/test').Page, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

/** Drag inside the overlay surface, in fractions of its box. */
async function dragOnPage(
  page: import('@playwright/test').Page,
  from: [number, number],
  to: [number, number],
) {
  const surface = page.locator('[data-test=page-overlay]');
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

/** Click inside the overlay surface, in fractions of its box. */
async function clickOnPage(
  page: import('@playwright/test').Page,
  at: [number, number],
) {
  const surface = page.locator('[data-test=page-overlay]');
  const box = (await surface.boundingBox())!;
  await page.mouse.click(box.x + box.width * at[0], box.y + box.height * at[1]);
}

test('phase 3: annotate, save, reload, flatten', async ({ page }) => {
  await registerAndLogin(page, 'p3');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await expect(page.locator('[data-test=page-overlay]')).toBeVisible();
  await expect(page.locator('[data-test=comments-empty]')).toBeVisible();
  await fitPage(page);

  // --- 1. Highlight real text via the overlay's text layer. ---
  await page.click('[data-test=tool-highlight]');
  const words = page.locator('[data-test=overlay-word]');
  await expect(words.first()).toBeVisible({ timeout: 30_000 });
  const first = (await words.nth(0).boundingBox())!;
  const third = (await words.nth(2).boundingBox())!;
  await page.mouse.move(first.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width - 2, third.y + third.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);
  // A drag across three words must highlight three words. Counting rows alone
  // passes even when pointer capture reduces the selection to the one word the
  // drag started on, so assert the mark is as wide as the run.
  const markWidth = await page
    .locator('[data-test=overlay-item][data-shape=quads] rect')
    .first()
    .evaluate((el) => (el as SVGRectElement).width.baseVal.value);
  expect(markWidth).toBeGreaterThan(third.x + third.width - first.x - 6);

  // --- 2. A sticky note. ---
  await page.click('[data-test=tool-note]');
  // The palette sets the tool, which flows into the overlay as an input; wait for
  // the observable consequence (the text layer is gone) rather than clicking into
  // an overlay that is still in text-selection mode.
  await expect(page.locator('[data-test=overlay-text-layer]')).toHaveCount(0);
  const surface = page.locator('[data-test=page-overlay]');
  const box = (await surface.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);
  // The note opens its editor inline; type into it and commit with a blur.
  const editor = page.locator('[data-test=comment-editor]');
  await expect(editor).toBeVisible();
  await editor.fill('Check this figure');
  await editor.blur();
  await expect(page.locator('[data-test=comment-text]').last()).toHaveText('Check this figure');

  // --- 3. An arrow. ---
  await page.click('[data-test=tool-arrow]');
  await expect(page.locator('[data-test=comment-editor]')).toHaveCount(0);
  await dragOnPage(page, [0.2, 0.7], [0.6, 0.8]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(3);

  // --- 4. Three marks, ONE save → one new version. ---
  await expect(page.locator('[data-test=annot-dirty]')).toContainText('3 unsaved');
  await page.click('[data-test=annot-save]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=annot-clean]')).toBeVisible();

  // --- 5. Reload the page: the marks came from the file, not from memory. ---
  await page.reload();
  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(3);
  await expect(page.locator('[data-test=annot-count]')).toHaveText('(3)');
  // Authorship is the display name, never a session id (phase-03 §3).
  await expect(page.locator('[data-test=comment-row]').first()).toContainText('E2E Tester');

  // --- 5b. The sidebar navigates, edits and deletes. ---
  await expect(page.locator('[data-test=comment-time]').first()).toBeVisible();
  // Jump to the mark that is on another page and confirm the page followed.
  await page.click('[data-test=tool-arrow]');
  await dragOnPage(page, [0.2, 0.5], [0.5, 0.6]);
  await page.click('[data-test=annot-next]');
  await expect(page.locator('[data-test=annot-page]')).toContainText('Page 2 / 3');
  await page.locator('[data-test=comment-jump]').first().click();
  await expect(page.locator('[data-test=annot-page]')).toContainText('Page 1 / 3');

  // Edit an existing comment through the sidebar.
  await page.locator('[data-test=comment-edit]').first().click();
  const sidebarEditor = page.locator('[data-test=comment-editor]');
  await sidebarEditor.fill('Edited from the sidebar');
  await sidebarEditor.blur();
  await expect(page.locator('[data-test=comment-text]').first()).toHaveText(
    'Edited from the sidebar',
  );

  // Delete the extra arrow again, then save the edit.
  const before = await page.locator('[data-test=comment-row]').count();
  await page.locator('[data-test=comment-delete]').last().click();
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(before - 1);
  await page.click('[data-test=annot-save]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
  // The toast is the *job* succeeding; `annot-clean` is the *file* confirming
  // it, and only the second one clears `dirty()`. Flatten refuses while there
  // are unsaved changes — it says "Save your changes first" and never opens its
  // confirm — so clicking it on the toast is a race the spec invented. This is
  // the same wait step 4 above already does; step 5b was missing it, which cost
  // one red run in eight on 2026-08-22.
  await expect(page.locator('[data-test=annot-clean]')).toBeVisible();

  // --- 6. Flatten: annotations become part of the page. ---
  await page.click('[data-test=annot-flatten]');
  await page.click('[data-test=confirm-ok]');
  await expect(successToast(page, 'Annotations flattened')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=comments-empty]')).toBeVisible();
  await expect(page.locator('[data-test=annot-count]')).toHaveText('(0)');

  // --- 6b. Sidebar navigation and per-comment actions. ---
  // (Run before flatten, while there are still annotations to act on.)

  // --- 7. Both steps are in the version history and revertible. ---
  await page.click('[data-test=annotate-toggle]');
  await page.click('[data-test=tab-history]');
  const versions = page.locator('[data-test=version-row]');
  // Original, Annotated (3 marks), Annotated (sidebar edit + delete), Flattened.
  await expect(versions).toHaveCount(4);
  await expect(versions.nth(0)).toContainText('Flattened annotations');
  await expect(versions.nth(1)).toContainText('Annotated');
});

test('phase 3: "clear page" removes only that page\'s marks', async ({ page }) => {
  await registerAndLogin(page, 'p3clear');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=page-overlay]')).toBeVisible({ timeout: 30_000 });
  await fitPage(page);

  await page.click('[data-test=tool-square]');
  await dragOnPage(page, [0.1, 0.1], [0.4, 0.3]);
  await page.click('[data-test=annot-next]');
  await dragOnPage(page, [0.1, 0.1], [0.4, 0.3]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);

  // On page 2: clearing this page must leave page 1 alone.
  await page.click('[data-test=annot-clear-page]');
  await page.click('[data-test=confirm-ok]');
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);

  await page.click('[data-test=annot-clear-all]');
  await page.click('[data-test=confirm-ok]');
  await expect(page.locator('[data-test=comments-empty]')).toBeVisible();
});

test('phase 3: a guest annotates from the public tool page with no login prompt', async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto('/annotate-pdf');
  await expect(page.locator('[data-test=tool-h1]')).toHaveText('Annotate a PDF');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
  await expect(page.locator('[data-test=register-form]')).toHaveCount(0);

  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');

  // The tool page hands straight into the workspace, already in annotate mode.
  await expect(page).toHaveURL(/\/app\/doc\/.*mode=annotate/, { timeout: 60_000 });
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);

  // Draw a rectangle and save it — no account anywhere in the path.
  await expect(page.locator('[data-test=page-overlay]')).toBeVisible({ timeout: 30_000 });
  // The overlay box being visible is not the page being visible: the raster is
  // a separate fetch, and a guest marking up a blank white box would be exactly
  // the failure nobody noticed in View mode for ten days.
  await expectOverlayDrew(page);
  await fitPage(page);
  await page.click('[data-test=tool-square]');
  await dragOnPage(page, [0.2, 0.2], [0.5, 0.35]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);

  await page.click('[data-test=annot-save]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
  // Guest authorship is exactly "Guest" — no session id leaks into the file.
  await expect(page.locator('[data-test=comment-row]').first()).toContainText('Guest');
  await expect(page.locator('[data-test=login-form]')).toHaveCount(0);
});

test('phase 3: crop is drawn on the overlay, not typed into a dialog', async ({ page }) => {
  await registerAndLogin(page, 'p3crop');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();

  // The organize toolbar's Crop hands off to the overlay (2026-07-19 queue item).
  await page.click('[data-test=organize-toggle]');
  await page.locator('[data-test=organize-page]').nth(0).click();
  await page.click('[data-test=op-crop]');
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await expect(page.locator('[data-test=page-overlay]')).toBeVisible({ timeout: 30_000 });
  await fitPage(page);

  await dragOnPage(page, [0.1, 0.1], [0.8, 0.6]);
  await page.click('[data-test=apply-crop]');
  await expect(successToast(page, 'Cropped')).toBeVisible({ timeout: 60_000 });
});

/**
 * A text box is text (2026-08-20).
 *
 * The words used to appear only in a 10 px badge above the box, truncated at 24
 * characters, in the highlighter's yellow, with a 2 pt yellow frame around an
 * empty rectangle — reported as "the text box is bold and doesn't show the text
 * at all". They belong in the box, at their own size and colour, edited there.
 * And markup is batched until Save, so it needs an undo of its own.
 */
test('phase 3: a text box shows its words on the page, and undo takes them back', async ({ page }) => {
  await registerAndLogin(page, 'p3text');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await fitPage(page);

  await page.click('[data-test=tool-free-text]');
  await expect(page.locator('[data-test=free-text-hint]')).toBeVisible();
  // The line-width slider is meaningless for text and is not offered.
  await expect(page.locator('[data-test=annot-width]')).toHaveCount(0);
  await expect(page.locator('[data-test=annot-undo]')).toBeDisabled();

  await dragOnPage(page, [0.15, 0.55], [0.7, 0.65]);

  // The caret is already in the box — no hunting for where to type.
  const onPageEditor = page.locator('[data-test=overlay-text-editor]');
  await expect(onPageEditor).toBeFocused();
  const sentence = 'A sentence comfortably longer than twenty-four characters.';
  await page.keyboard.type(sentence);

  // The next box is drawn straight after typing — no Escape, no click anywhere
  // else. That is how a form gets filled in, and until 2026-08-26 it was the
  // path that lost boxes: the drawing gesture cancels `pointerdown`, so nothing
  // ever blurred the box being typed into, and the end-of-editing the browser
  // reported for the torn-down editor was read against the *new* box — which
  // was empty, and was deleted for it.
  await dragOnPage(page, [0.15, 0.68], [0.7, 0.75]);
  await expect(onPageEditor).toBeFocused();
  await page.keyboard.type('Second field');
  await page.keyboard.press('Escape');

  // Both drawn on the page, whole, and not as badges.
  const drawn = page.locator('[data-test=overlay-text]');
  await expect(drawn).toHaveText([sentence, 'Second field']);
  await expect(page.locator('[data-test=overlay-label]')).toHaveCount(0);

  // One undo takes back a sentence, not one letter of it.
  await page.click('[data-test=annot-undo]');
  await expect(drawn).toHaveText([sentence, '']);
  await page.click('[data-test=annot-redo]');
  await expect(drawn).toHaveText([sentence, 'Second field']);

  // Double-click puts the caret back in the same box.
  await page.click('[data-test=tool-select]');
  await page.locator('[data-test=overlay-item]').last().dblclick();
  await expect(page.locator('[data-test=overlay-text-editor]')).toBeFocused();
  await page.keyboard.press('Escape');

  // And it survives the round trip through the file.
  await page.click('[data-test=annot-save]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=overlay-text]')).toHaveText([sentence, 'Second field']);
  // …and the page underneath is drawn *without* them: a raster that already
  // carried the saved text showed every box twice, and the baked copy stayed
  // behind when the editable one was dragged.
  await expect(page.locator('[data-test=overlay-drew]')).toBeVisible({ timeout: 60_000 });
  // The overlay asks at 2× its render width; the thumbnail rail asks at 240
  // and keeps the annotations, because there the raster is all there is.
  const rasterRequests = await page.evaluate(() =>
    performance.getEntriesByType('resource')
      .map((entry) => new URL(entry.name))
      .filter((url) => url.pathname.includes('/thumbnail/')
        && Number(url.searchParams.get('w')) > 500)
      .map((url) => url.searchParams.get('annots')),
  );
  expect(rasterRequests.length).toBeGreaterThan(0);
  expect(rasterRequests.every((annots) => annots === 'false')).toBe(true);
});

/**
 * The palette says which tool is armed — including the custom stamp.
 *
 * Uploading a stamp switched the active tool to `image_stamp` and no palette
 * button lit up, so the one tool without an entry was also the only one you
 * could not come back to without uploading the file a second time
 * (2026-08-21 review, smaller observations; design contract §3).
 */
test('phase 3: the palette shows the uploaded stamp, and arms it again', async ({ page }) => {
  await registerAndLogin(page, 'p3stamp');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await fitPage(page);

  // Nothing uploaded: the entry is live, and pressing it opens the picker
  // whose file arms it (design contract §3, amended 2026-08-28 — the disabled
  // state it replaced was reported as "the button is not clickable").
  const entry = page.locator('[data-test=tool-image-stamp]');
  await expect(entry).toBeEnabled();
  await expect(entry).toHaveAttribute('aria-pressed', 'false');

  const chooser = page.waitForEvent('filechooser');
  await entry.click();
  await (await chooser).setFiles(path.join(IMAGES, 'sample.png'));
  await expect(successToast(page, 'Stamp ready')).toBeVisible({ timeout: 30_000 });

  // Armed by the upload, and the palette now says so, wearing the image.
  await expect(entry).toBeEnabled();
  await expect(entry).toHaveAttribute('aria-pressed', 'true');
  await expect(entry.locator('img')).toHaveAttribute('src', /^blob:/);

  await dragOnPage(page, [0.15, 0.15], [0.4, 0.3]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);

  // Away and back: the entry is the way back, and it still has the stamp.
  await page.click('[data-test=tool-select]');
  await expect(entry).toHaveAttribute('aria-pressed', 'false');
  await entry.click();
  await expect(entry).toHaveAttribute('aria-pressed', 'true');

  await dragOnPage(page, [0.15, 0.45], [0.4, 0.6]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);

  await page.click('[data-test=annot-save]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);
});

/**
 * The Tick box tool (2026-08-28, design contract §3 "Tick box").
 *
 * One click places the chosen mark — checkmark by default — as plain ink, the
 * selector lives in the page bar exactly while the tool is armed, and the tool
 * stays armed between clicks, because ticking a form is click, click, click.
 */
test('phase 3: tick box places the chosen mark with one click', async ({ page }) => {
  await registerAndLogin(page, 'p3tick');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await fitPage(page);

  // The selector exists exactly while the tool is armed, checkmark preselected.
  await expect(page.locator('[data-test=tick-marks]')).toHaveCount(0);
  await page.click('[data-test=tool-tick]');
  await expect(page.locator('[data-test=tool-tick]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-test=tick-mark-check]')).toHaveAttribute('aria-pressed', 'true');

  // Click, click: two marks, and the tool is still armed.
  await clickOnPage(page, [0.3, 0.3]);
  await clickOnPage(page, [0.5, 0.3]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);
  await expect(page.locator('[data-test=tool-tick]')).toHaveAttribute('aria-pressed', 'true');

  // Switch the mark in the bar; the third click places a cross.
  await page.click('[data-test=tick-mark-cross]');
  await expect(page.locator('[data-test=tick-mark-cross]')).toHaveAttribute('aria-pressed', 'true');
  await clickOnPage(page, [0.7, 0.3]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(3);
  await expect(page.locator('[data-test=annot-dirty]')).toContainText('3 unsaved');

  // Plain ink in the file: they save and survive a reload.
  await page.click('[data-test=annot-save]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-test=annot-clean]')).toBeVisible();
  await page.reload();
  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=annot-count]')).toHaveText('(3)');

  // Leaving the tool takes the selector with it.
  await page.click('[data-test=tool-select]');
  await expect(page.locator('[data-test=tick-marks]')).toHaveCount(0);
});

/**
 * Marks look like what the file will save (2026-08-28 defect run).
 *
 * The mode's raster is the page without its annotations, so the overlay is the
 * only rendering anyone sees before View mode — and it painted squiggly as a
 * highlight wash and a stamp as an empty outline with its name in a badge
 * floating above. Behind those sat two engine defects: `add_stamp_annot`
 * aspect-fits `/Rect` (a 3:2 drag saved as ~4:1), and `annot.update()` writes
 * the stamp's own name over the user's typed comment.
 */
test('phase 3: squiggly waves, stamps stamp, and the drawn rect survives the save', async ({ page }) => {
  await registerAndLogin(page, 'p3truth');
  await uploadFiles(page, ['text.pdf']);
  await page.locator('[data-test=doc-card] [data-test=open-doc]').first().click();
  await expect(page).toHaveURL(/\/app\/doc\//);

  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await fitPage(page);

  // --- 1. Squiggly draws a wave along the words, not a filled box. ---
  await page.click('[data-test=tool-squiggly]');
  const words = page.locator('[data-test=overlay-word]');
  await expect(words.first()).toBeVisible({ timeout: 30_000 });
  const first = (await words.nth(0).boundingBox())!;
  const third = (await words.nth(2).boundingBox())!;
  await page.mouse.move(first.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width - 2, third.y + third.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(1);
  const squiggle = page.locator('[data-test=overlay-item][data-shape=quads] path');
  await expect(squiggle).toHaveCount(1);
  await expect(squiggle).toHaveAttribute('fill', 'none');
  expect((await squiggle.getAttribute('d'))!.split('L').length).toBeGreaterThan(3);
  // No filled rect: that is the highlighter's rendering, not squiggly's.
  await expect(page.locator('[data-test=overlay-item][data-shape=quads] rect')).toHaveCount(0);

  // --- 2. A stamp draws as words in a border, with no floating badge — and a
  //        deliberately squarish drag (3:2, nothing like the appearance's 4:1)
  //        keeps its drawn shape through save and reload. ---
  await page.click('[data-test=tool-stamp]');
  await expect(page.locator('[data-test=overlay-text-layer]')).toHaveCount(0);
  await dragOnPage(page, [0.2, 0.4], [0.5, 0.6]);
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);
  const stampText = page.locator('[data-test=overlay-stamp-text]');
  await expect(stampText).toHaveText('APPROVED');
  await expect(page.locator('[data-test=overlay-stamp-border]')).toHaveCount(1);
  await expect(page.locator('[data-test=overlay-label]')).toHaveCount(0);

  const drawnBox = (await page
    .locator('[data-test=overlay-stamp-border]')
    .evaluate((el) => {
      const r = el as SVGRectElement;
      return { w: r.width.baseVal.value, h: r.height.baseVal.value };
    }))!;

  // A comment typed on the stamp must survive the save (the appearance builder
  // used to overwrite it with the stamp's own name).
  await page.locator('[data-test=comment-row]').last().locator('[data-test=comment-edit]').click();
  const editor = page.locator('[data-test=comment-editor]');
  await editor.fill('second pass, please');
  await editor.blur();

  await page.click('[data-test=annot-save]');
  await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await page.click('[data-test=annotate-toggle]');
  await expect(page.locator('[data-test=comment-row]')).toHaveCount(2);
  await fitPage(page);

  // Reloaded from the file: still a stamp, still the drawn 3:2 box (±2%), and
  // still the user's words — not "Approved".
  await expect(page.locator('[data-test=overlay-stamp-text]')).toHaveText('APPROVED');
  const savedBox = (await page
    .locator('[data-test=overlay-stamp-border]')
    .evaluate((el) => {
      const r = el as SVGRectElement;
      return { w: r.width.baseVal.value, h: r.height.baseVal.value };
    }))!;
  expect(savedBox.w / savedBox.h).toBeGreaterThan(drawnBox.w / drawnBox.h - 0.1);
  expect(savedBox.w / savedBox.h).toBeLessThan(drawnBox.w / drawnBox.h + 0.1);
  await expect(
    page.locator('[data-test=comment-row]').filter({ hasText: 'second pass, please' }),
  ).toHaveCount(1);
});
