import { expect, test } from '@playwright/test';
import path from 'node:path';

import { FIXTURES, registerAndLogin, uploadFiles } from './helpers';

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
