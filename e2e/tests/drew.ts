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
 * 97 px between sampled rows, and prime on purpose.
 *
 * A stride that shares a factor with the page's own rhythm — line height, a
 * table rule, a ruled form — can step between the marks for a whole page and
 * report a uniform sample of a perfectly good render. A prime cannot stay in
 * step with anything for long.
 *
 * **Within** a sampled row every pixel is read. A grid coarse in both axes is
 * the version of this that looks more rigorous and is not: on a sparse page of
 * body text, 97 px between probes in *x* as well as *y* leaves a few hundred
 * of them that can plausibly all land on paper, and a test that passes or
 * fails on where the text happened to sit is worse than no test. Fifteen full
 * rows of a 1000 px page is ~15 000 probes, a few milliseconds, and it crosses
 * every line of text it passes through.
 */
const STRIDE = 97;

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
    `${what} sampled ${last!.colours} distinct colour(s) — it is blank`,
  ).toBeGreaterThan(MIN_COLOURS);
  return last!;
}

/** Read back the largest canvas on the page. */
async function sampleLargestCanvas(page: Page): Promise<DrawnSample | null> {
  return page.evaluate(({ stride }) => {
    const canvases = [...document.querySelectorAll('canvas')].filter(
      (c) => c.width > 0 && c.height > 0,
    );
    if (!canvases.length) return null;
    const canvas = canvases.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const seen = new Set<number>();
    for (let y = 0; y < height; y += stride) {
      const row = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const i = row + x * 4;
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
    }
    return { width, height, colours: seen.size };
  }, { stride: STRIDE });
}

/** Draw the overlay's page raster onto an offscreen canvas and read it back. */
async function sampleOverlayRaster(page: Page): Promise<DrawnSample | null> {
  return page.evaluate(async ({ stride }) => {
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
    for (let y = 0; y < height; y += stride) {
      const row = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const i = row + x * 4;
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
    }
    return { width, height, colours: seen.size };
  }, { stride: STRIDE });
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
  return assertDrawn(() => sampleLargestCanvas(page), 'the viewer canvas');
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
