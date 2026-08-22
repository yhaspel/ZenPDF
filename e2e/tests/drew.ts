import { Page, expect } from '@playwright/test';

/**
 * "The page actually drew" — in pixels, not in status codes.
 *
 * Between 2026-08-10 and 2026-08-20 the production workspace rendered nothing
 * at `/app/doc/:id`, and every check we had said the product was fine: the
 * viewer element was present, the metadata, versions, outline and thumbnails
 * all answered 200, the console was silent. The suite had never asserted that
 * anything was *painted*, and the queue row for that gap (2026-08-02) had been
 * open since Phase 5. Ten days is what that costs.
 *
 * So these two helpers end at the framebuffer. Each waits for the product to
 * claim it drew — `viewer-drew` after pdf.js's `pageRendered`, `overlay-drew`
 * after the raster decoded with a non-zero natural size — and then reads the
 * pixels back and refuses to take that claim on trust.
 *
 * *(Placed beside `helpers.ts` rather than in the `helpers/` directory the
 * prompt suggested: a `helpers/` folder next to an existing `helpers.ts` makes
 * `from './helpers'` a question rather than an answer.)*
 */

/** What a sampled surface turned out to contain. */
export interface DrawnSample {
  width: number;
  height: number;
  /** Distinct RGB triples across the sampled rows. */
  colours: number;
}

/**
 * Enough distinct colours to stop counting.
 *
 * **There is no stride, and the reason is a defect this file's first version
 * shipped with.** It walked rows at a 97 px stride — prime, so it could not
 * stay in step with the page's own rhythm — and read every pixel within a
 * sampled row. That reasoning is sound about *columns* and wrong about rows.
 * The fixture page is four short lines near the top, and rows 0, 97, 194, 291
 * step straight over all four.
 *
 * It was caught by hand-sampling the deployed site: the canvas read as **one
 * colour** while the screenshot plainly showed the page, and scanning every
 * pixel found **173 colours with the darkest at y = 141**. The e2e run passed
 * on the same site minutes earlier only because its canvas is a different
 * height, so its rows happened to land on the text. A sampler that can miss a
 * drawn page is exactly the defect this file exists to remove, and passing by
 * luck is the same thing as failing.
 *
 * So every pixel is read, and the loop stops the moment the answer is not in
 * doubt. `getImageData` copies the whole buffer either way; the loop is the
 * cheap part, a drawn page costs a few thousand iterations, and only a blank
 * one scans to the end — which is precisely the case worth spending on.
 */
const ENOUGH_COLOURS = 64;

/** Not a thumbnail, not a spinner: a real page raster is wider than this. */
const MIN_WIDTH = 300;

/** White paper plus antialiasing is already more than this. Blank is 1. */
const MIN_COLOURS = 3;

/** How long a surface has to become non-blank once the product says it drew. */
const SETTLE_MS = 30_000;

/**
 * Poll a reader until it returns something that looks drawn, then assert.
 *
 * The assertions run on the last sample either way, so a timeout fails with the
 * measured numbers — "sampled 1 distinct colour(s)" — rather than with a bare
 * "timed out", which is the failure mode that let the original defect hide.
 */
async function assertDrawn(
  read: () => Promise<DrawnSample | null>,
  what: string,
): Promise<DrawnSample> {
  const deadline = Date.now() + SETTLE_MS;
  let last: DrawnSample | null = null;
  for (;;) {
    last = await read();
    if (last && last.width > MIN_WIDTH && last.colours > MIN_COLOURS) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  expect(last, `${what}: there was nothing readable to sample`).not.toBeNull();
  expect(
    last!.width,
    `${what} is ${last!.width}px wide — that is not a page`,
  ).toBeGreaterThan(MIN_WIDTH);
  expect(
    last!.colours,
    `${what} sampled only ${last!.colours} distinct colour(s) — it is blank`,
  ).toBeGreaterThan(MIN_COLOURS);
  return last!;
}

/**
 * Read back the page canvases and return whichever has the most on it.
 *
 * Not "the largest": pdf.js keeps one canvas per rendered page and they are all
 * the same size, so choosing by area really chooses whichever the DOM happens
 * to list first — as likely the page scrolled off screen as the one in front of
 * you. The question here is whether *a* page drew, so the answer is the best
 * canvas, not the biggest one.
 */
async function sampleBestCanvas(page: Page): Promise<DrawnSample | null> {
  return page.evaluate(({ enough }) => {
    const canvases = [...document.querySelectorAll('canvas')].filter(
      (c) => c.width > 0 && c.height > 0,
    );
    if (!canvases.length) return null;
    let best: { width: number; height: number; colours: number } | null = null;
    for (const canvas of canvases) {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      const seen = new Set<number>();
      for (let i = 0; i < data.length && seen.size < enough; i += 4) {
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
      if (!best || seen.size > best.colours) best = { width, height, colours: seen.size };
      if (best.colours >= enough) break;
    }
    return best;
  }, { enough: ENOUGH_COLOURS });
}

/** Draw the overlay's page raster onto an offscreen canvas and read it back. */
async function sampleOverlayRaster(page: Page): Promise<DrawnSample | null> {
  return page.evaluate(async ({ enough }) => {
    const image = document.querySelector<HTMLImageElement>('[data-test=overlay-drew]');
    if (!image) return null;
    await image.decode().catch(() => undefined);
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length && seen.size < enough; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    return { width, height, colours: seen.size };
  }, { enough: ENOUGH_COLOURS });
}

/**
 * View mode drew a page.
 *
 * `viewer-drew` appears when pdf.js emits `pageRendered` for the bytes
 * currently in `src` — that is the product's claim. The pixel read is the part
 * that does not take it on trust.
 */
export async function expectPageDrew(page: Page): Promise<DrawnSample> {
  await expect(page.locator('[data-test=viewer-drew]')).toBeVisible({ timeout: 60_000 });
  return assertDrawn(() => sampleBestCanvas(page), 'the viewer canvas');
}

/**
 * An editing mode drew its page raster.
 *
 * Annotate, Edit, Forms, Protect and Sign do not use pdf.js — they draw an
 * `<img>` of the server-rendered page. A broken or empty image still fires
 * `load`, so the product only claims `overlay-drew` for a non-zero natural
 * size, and this reads the decoded pixels back through an offscreen canvas.
 */
export async function expectOverlayDrew(page: Page): Promise<DrawnSample> {
  await expect(page.locator('[data-test=overlay-drew]')).toBeVisible({ timeout: 60_000 });
  return assertDrawn(() => sampleOverlayRaster(page), 'the overlay raster');
}
