import { Page, TestInfo, expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

import { FIXTURES, registerAndLogin } from './helpers';

/**
 * Text boxes: one layout, drawn twice — the screen-vs-file pixel gate
 * (design contract §3 "Text on the page"; `docs/archived/2026-09-25-annotate-text-PROMPT.md` §6.2).
 *
 * Owner report 2026-09-25: "text cut off constantly and shifts when the PDF is
 * downloaded". The editor and the file used to lay each box out with two
 * unrelated text engines and both clipped to a drawn rectangle. Now the client
 * decides the lines and the file draws exactly those lines in the same face at
 * the same baselines — and this spec is what holds that promise: for every box
 * it compares where the **overlay's** ink lands (a screenshot, with and
 * without the drawn text) with where the **saved file's** ink lands (the
 * engine's own raster of the saved version, with and without annotations),
 * in device pixels, and allows **one**.
 *
 * Five boxes cover what went wrong: a name, a two-line address, a Hebrew line
 * with digits and a comma, a 9 pt line, and a line long enough to reach the
 * page's right edge (the only place the layout breaks a line by itself).
 * Run in both themes, at device scale 0.75 / 1 / 1.5, and on a 390 px phone.
 */

type Rect = { x: number; y: number; w: number; h: number };
type Ink = { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number } | null;

interface BoxSpec {
  label: string;
  at: [number, number];
  keys: string[];
  size?: number;
}

const BOXES: BoxSpec[] = [
  { label: '9 pt line', at: [0.12, 0.30], keys: ['small 9pt text AVAWAY fi fl'], size: 9 },
  { label: 'name', at: [0.12, 0.36], keys: ['Yuval Haspel'] },
  { label: 'two-line address', at: [0.12, 0.44], keys: ['12 Herzl St., Petah Tikva', 'Enter', 'Apartment 4, floor 2'] },
  { label: 'Hebrew with digits and a comma', at: [0.12, 0.54], keys: ['רחוב הרצל 12, פתח תקווה'] },
  {
    label: 'line that reaches the page edge',
    at: [0.55, 0.64],
    keys: ['This sentence is long enough to run into the right edge of the page and wrap.'],
  },
];

const LAYOUTS = [
  { name: 'desktop @0.75x', viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 0.75, phone: false },
  { name: 'desktop @1x', viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1, phone: false },
  { name: 'desktop @1.5x', viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1.5, phone: false },
  { name: 'phone 390', viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, phone: true },
] as const;

const THEMES = ['light', 'dark'] as const;

/** One device pixel, in every direction — the gate (spec §6.2), on the ink bbox. */
const TOLERANCE = 1;
/**
 * The shape-shift guard's allowance, in device px. The browser snaps each
 * text run's baseline to whole pixels and MuPDF does not, so the same line at
 * the same place differs by up to about one device pixel vertically — the
 * spec's measured 0.5 pt (§3), and 0.93 px worst over every box of the
 * sandbox's full-suite runs. A quarter pixel above that keeps the guard quiet about
 * snapping and loud about a real shift: with the file's baseline moved by
 * 1.5 pt it fails at dpr 1 and above.
 */
const SHIFT_TOLERANCE = 1.25;

function successToast(page: Page, text: string) {
  return page.locator('[data-test=toast-success]').filter({ hasText: text });
}

async function openInAnnotate(page: Page, phone: boolean): Promise<void> {
  await registerAndLogin(page, 'wysiwyg');
  await page.goto('/annotate-pdf');
  await page.locator('[data-test=file-input]').setInputFiles(path.join(FIXTURES, 'text.pdf'));
  await page.click('[data-test=tool-run]');
  await expect(page).toHaveURL(/\/app\/doc\//, { timeout: 90_000 });
  // The Annotate tool page hands over in Annotate; switch only if it did not.
  const annotate = page.locator('[data-test=annotate-mode]');
  const handedOver = await annotate.waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true, () => false);
  if (!handedOver) {
    await page.click(phone ? '[data-test=ws-bottom-mode][data-mode=annotate]' : '[data-test=annotate-toggle]');
  }
  await expect(page.locator('[data-test=annotate-mode]')).toBeVisible();
  await expect(page.locator('[data-test=overlay-drew]')).toBeVisible({ timeout: 60_000 });
  if (!phone) {
    // Whole page in the viewport, so every click lands on it.
    await page.click('[data-test=annot-zoom-out]');
    await page.click('[data-test=annot-zoom-out]');
  }
}

/** On the phone the palette lives in the start drawer. */
async function withPalette(page: Page, phone: boolean, act: () => Promise<void>): Promise<void> {
  if (phone) {
    await page.click('[data-test=ws-drawer-open][data-drawer=start]');
    await expect(page.locator('[data-ws-drawer=start]')).toHaveAttribute('role', 'dialog');
  }
  await act();
  if (phone) {
    await page.click('[data-ws-drawer=start] [data-test=ws-drawer-close]');
    await expect(page.locator('[data-test=ws-drawer-scrim]')).toHaveCount(0);
    await expect(page.locator('[data-ws-drawer=start]')).not.toHaveAttribute('role', 'dialog');
  }
}

async function setFontSize(page: Page, size: number): Promise<void> {
  await page.locator('[data-test=annot-font-size]').evaluate((el, value) => {
    const input = el as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, size);
  await expect(page.locator('label[for=annot-font-size]')).toContainText(`${size}pt`);
}

async function placeBox(page: Page, box: BoxSpec): Promise<void> {
  const surface = page.locator('[data-test=page-overlay]');
  await surface.scrollIntoViewIfNeeded();
  const r = (await surface.boundingBox())!;
  const x = r.x + r.width * box.at[0];
  const y = r.y + r.height * box.at[1];
  // A raw mouse click lands on whatever is on top — on the phone that can be
  // the palette drawer still sliding shut. Click only once the page is what
  // the point hits.
  await expect.poll(() => page.evaluate(([px, py]) =>
    !!document.elementFromPoint(px, py)?.closest('[data-test=page-overlay]'), [x, y]))
    .toBe(true);
  await page.mouse.click(x, y);
  const editor = page.locator('[data-test=overlay-text-editor]');
  await expect(editor).toBeFocused();
  for (const key of box.keys) {
    if (key === 'Enter') await page.keyboard.press('Enter');
    else await page.keyboard.insertText(key);
  }
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
}

/**
 * Ink bounding boxes, per region, of the difference between two PNGs of the
 * same size — decoded in the page, where a canvas is at hand.
 */
/**
 * How far the file's ink is displaced from the screen's, per region, in
 * device px — the peak of their normalised cross-correlation over ±3 px,
 * refined to sub-pixel with a parabola. Unlike a centre of mass this does not
 * care that two rasterisers shade the same glyph a little differently: it
 * asks only where the *shapes* line up.
 */
async function inkShift(page: Page, screen: [string, string], file: [string, string], regions: Rect[]):
  Promise<{ dx: number; dy: number; score: number }[]> {
  return page.evaluate(async ({ screen, file, regions }) => {
    const load = async (url: string) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [s1, s2, f1, f2] = await Promise.all([...screen, ...file].map(load));
    const lum = (img: ImageData, i: number) =>
      0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    const patch = (a: ImageData, b: ImageData, r: { x: number; y: number; w: number; h: number }) => {
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const w = Math.min(a.width, b.width, Math.ceil(r.x + r.w)) - x0;
      const h = Math.min(a.height, b.height, Math.ceil(r.y + r.h)) - y0;
      const out = new Float64Array(w * h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          out[y * w + x] = Math.abs(lum(a, ((y0 + y) * a.width + x0 + x) * 4) - lum(b, ((y0 + y) * b.width + x0 + x) * 4));
        }
      }
      return { out, w, h };
    };
    const R = 3;
    return regions.map((r) => {
      const A = patch(s1, s2, r);
      const B = patch(f1, f2, r);
      const { w, h } = A;
      const score = (dx: number, dy: number) => {
        let ab = 0, aa = 0, bb = 0;
        for (let y = R; y < h - R; y++) {
          for (let x = R; x < w - R; x++) {
            const a = A.out[y * w + x];
            const b = B.out[(y + dy) * w + (x + dx)];
            ab += a * b; aa += a * a; bb += b * b;
          }
        }
        return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
      };
      const grid: number[][] = [];
      let best = -1, bx = 0, by = 0;
      for (let dy = -R; dy <= R; dy++) {
        grid.push([]);
        for (let dx = -R; dx <= R; dx++) {
          const v = score(dx, dy);
          grid[dy + R].push(v);
          if (v > best) { best = v; bx = dx; by = dy; }
        }
      }
      const refine = (m: number, c: number, p: number) => {
        const den = m - 2 * c + p;
        return den === 0 ? 0 : (0.5 * (m - p)) / den;
      };
      const gx = bx + R, gy = by + R;
      const sx = bx + (gx > 0 && gx < 2 * R ? refine(grid[gy][gx - 1], grid[gy][gx], grid[gy][gx + 1]) : 0);
      const sy = by + (gy > 0 && gy < 2 * R ? refine(grid[gy - 1][gx], grid[gy][gx], grid[gy + 1][gx]) : 0);
      return { dx: +sx.toFixed(3), dy: +sy.toFixed(3), score: +best.toFixed(3) };
    });
  }, { screen, file, regions });
}

async function diffInk(page: Page, a: Buffer | string, b: Buffer | string, regions: Rect[]): Promise<{
  inks: Ink[]; width: number; height: number;
}> {
  const src = (x: Buffer | string) => (typeof x === 'string' ? x : `data:image/png;base64,${x.toString('base64')}`);
  return page.evaluate(async ({ a, b, regions }) => {
    const load = async (url: string) => {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [one, two] = await Promise.all([load(a), load(b)]);
    const width = Math.min(one.width, two.width);
    const height = Math.min(one.height, two.height);
    const inks = regions.map((r) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      let mass = 0, mx = 0, my = 0;
      const xs = Math.max(0, Math.floor(r.x)), xe = Math.min(width, Math.ceil(r.x + r.w));
      const ys = Math.max(0, Math.floor(r.y)), ye = Math.min(height, Math.ceil(r.y + r.h));
      for (let y = ys; y < ye; y++) {
        for (let x = xs; x < xe; x++) {
          const i = (y * one.width + x) * 4;
          const j = (y * two.width + x) * 4;
          const d = Math.abs(
            0.299 * (one.data[i] - two.data[j]) + 0.587 * (one.data[i + 1] - two.data[j + 1])
            + 0.114 * (one.data[i + 2] - two.data[j + 2]),
          );
          // Ink = a pixel at least ~15% covered. A higher cut measures only
          // glyph *cores*, which a 5 px phone glyph may not have in one
          // rasteriser and have in the other; the fringe is where both agree.
          // The centre of mass (over the same pixels) is recorded in the
          // evidence, not asserted: two rasterisers shade a glyph differently
          // enough to move it ~0.9 px with the shapes exactly aligned — the
          // cross-correlation in `inkShift` is the shift that is asserted.
          if (d > 40) {
            mass += d;
            mx += d * x;
            my += d * y;
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
          }
        }
      }
      return Number.isFinite(x0)
        ? { x0, y0, x1, y1, cx: mx / mass, cy: my / mass }
        : null;
    });
    return { inks, width, height };
  }, { a: src(a), b: src(b), regions });
}

async function measure(page: Page, testInfo: TestInfo, dpr: number) {
  const overlay = page.locator('[data-test=page-overlay]');
  await overlay.scrollIntoViewIfNeeded();
  // Nothing but the page and its text: no toast, no selection outline.
  await page.addStyleTag({ content: '[data-test^=toast]{display:none!important}' });
  const geo = await page.evaluate(() => {
    const surface = document.querySelector('[data-test=page-overlay]')!.getBoundingClientRect();
    const texts = [...document.querySelectorAll<HTMLElement>('[data-test=overlay-text]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - surface.left, y: r.top - surface.top, w: r.width, h: r.height, text: el.textContent };
    });
    return { width: surface.width, height: surface.height, texts };
  });
  expect(geo.texts.length).toBe(BOXES.length);

  // Settled before measuring: the page-text face loaded, the saved
  // version's raster decoded, two frames painted.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined)));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const shown = await overlay.screenshot({ animations: 'disabled' });
  const hide = await page.addStyleTag({ content: '[data-test=overlay-text]{visibility:hidden!important}' });
  const hidden = await overlay.screenshot({ animations: 'disabled' });
  await hide.evaluate((el) => el.remove());

  const pad = 6 * dpr;
  const regions = geo.texts.map((t) => ({
    x: t.x * dpr - pad, y: t.y * dpr - pad, w: t.w * dpr + 2 * pad, h: t.h * dpr + 2 * pad,
  }));
  const screen = await diffInk(page, shown, hidden, regions);

  // The file: the engine's own raster of the saved version, at the width the
  // overlay occupies in device pixels, with and without its annotations.
  const docId = /\/app\/doc\/([^/?#]+)/.exec(page.url())![1];
  const w = Math.round(geo.width * dpr);
  const thumbs = await page.evaluate(async ({ docId, w }) => {
    const token = localStorage.getItem('zen_access');
    const get = async (annots: boolean) => {
      const res = await fetch(`/api/documents/${docId}/pages/0/thumbnail/?w=${w}${annots ? '' : '&annots=false'}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const blob = await res.blob();
      return await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    };
    return { withAnnots: await get(true), clean: await get(false) };
  }, { docId, w });
  const file = await diffInk(page, thumbs.withAnnots, thumbs.clean, regions);
  const b64 = (x: Buffer) => `data:image/png;base64,${x.toString('base64')}`;
  const shifts = await inkShift(page, [b64(shown), b64(hidden)], [thumbs.withAnnots, thumbs.clean], regions);

  const rows = geo.texts.map((t, i) => {
    const s = screen.inks[i];
    const f = file.inks[i];
    const box = {
      x0: t.x * dpr, y0: t.y * dpr, x1: (t.x + t.w) * dpr, y1: (t.y + t.h) * dpr,
    };
    const delta = s && f
      ? {
        x0: f.x0 - s.x0, y0: f.y0 - s.y0, x1: f.x1 - s.x1, y1: f.y1 - s.y1,
        cx: +(f.cx - s.cx).toFixed(3), cy: +(f.cy - s.cy).toFixed(3),
      }
      : null;
    return { label: BOXES[i]?.label ?? t.text, text: t.text, screen: s, file: f, box, delta, shift: shifts[i] };
  });

  const evidence = {
    dpr, overlayCss: { width: geo.width, height: geo.height }, fileRasterWidth: w, rows,
  };
  await testInfo.attach('measurements.json', {
    body: JSON.stringify(evidence, null, 2), contentType: 'application/json',
  });
  await testInfo.attach('overlay.png', { body: shown, contentType: 'image/png' });
  await testInfo.attach('file.png', {
    body: Buffer.from(thumbs.withAnnots.split(',')[1], 'base64'), contentType: 'image/png',
  });
  const dir = process.env['WYSIWYG_EVIDENCE_DIR'];
  if (dir) {
    const slug = `${testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-r${testInfo.repeatEachIndex}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(dir, `${slug}-overlay.png`), shown);
    fs.writeFileSync(path.join(dir, `${slug}-overlay-clean.png`), hidden);
    fs.writeFileSync(path.join(dir, `${slug}-file.png`), Buffer.from(thumbs.withAnnots.split(',')[1], 'base64'));
    fs.writeFileSync(path.join(dir, `${slug}-file-clean.png`), Buffer.from(thumbs.clean.split(',')[1], 'base64'));
  }
  return rows;
}

for (const layout of LAYOUTS) {
  for (const theme of THEMES) {
    test.describe(`annotate text boxes — ${layout.name}, ${theme}`, () => {
      test.use({
        viewport: layout.viewport,
        deviceScaleFactor: layout.deviceScaleFactor,
        colorScheme: theme,
      });

      test(`annotate text: screen and file agree to one device pixel (${layout.name}, ${theme})`,
        async ({ page }, testInfo) => {
          test.setTimeout(180_000);
          await page.addInitScript((t) => {
            try { localStorage.setItem('zenpdf.theme', t); } catch { /* private mode */ }
          }, theme);
          await openInAnnotate(page, layout.phone);
          expect(await page.evaluate(() => document.documentElement.classList.contains('dark')))
            .toBe(theme === 'dark');

          await withPalette(page, layout.phone, async () => {
            await page.click('[data-test=tool-free-text]');
            await expect(page.locator('[data-test=tool-free-text]')).toHaveAttribute('aria-pressed', 'true');
          });
          for (const box of BOXES) {
            if (box.size) await withPalette(page, layout.phone, () => setFontSize(page, box.size!));
            await placeBox(page, box);
            if (box.size) await withPalette(page, layout.phone, () => setFontSize(page, 12));
          }

          // The drawn lines are the lines the file will get: the long box
          // broke at the page's edge, and nothing else did.
          const drawn = page.locator('[data-test=overlay-text]');
          await expect(drawn).toHaveCount(BOXES.length);
          const lineCounts = await drawn.evaluateAll((els) => els.map((el) => (el.textContent ?? '').split('\n').length));
          expect(lineCounts.slice(0, 4)).toEqual([1, 1, 2, 1]);
          expect(lineCounts[4]).toBeGreaterThan(1);
          // …and each box kept the size it was placed at (9 pt, then 12 pt).
          const sizes = await drawn.evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
          expect(sizes[0] / sizes[1]).toBeCloseTo(9 / 12, 3);
          expect(new Set(sizes.slice(1)).size).toBe(1);

          if (layout.phone) {
            await page.click('[data-test=ws-bottom-primary]');
          } else {
            await page.click('[data-test=annot-save]');
          }
          await expect(successToast(page, 'Annotations saved')).toBeVisible({ timeout: 60_000 });
          await expect(page.locator('[data-test=overlay-drew]')).toBeVisible({ timeout: 60_000 });
          await page.waitForLoadState('networkidle');

          const dpr = layout.deviceScaleFactor;
          const rows = await measure(page, testInfo, dpr);
          for (const row of rows) {
            expect(row.screen, `${row.label}: nothing drawn on screen`).not.toBeNull();
            expect(row.file, `${row.label}: nothing drawn in the file`).not.toBeNull();
            const d = row.delta!;
            const worst = Math.max(Math.abs(d.x0), Math.abs(d.y0), Math.abs(d.x1), Math.abs(d.y1));
            expect(worst, `${row.label}: screen ${JSON.stringify(row.screen)} vs file ${JSON.stringify(row.file)}`)
              .toBeLessThanOrEqual(TOLERANCE);
            // The same question asked of the glyph *shapes*: how far the file's
            // ink must move to sit on the screen's (cross-correlation peak). No
            // antialiasing fringe changes this; a shifted line does.
            expect(row.shift.score, `${row.label}: screen and file do not even look alike`).toBeGreaterThan(0.8);
            expect(Math.abs(row.shift.dx), `${row.label}: the file is ${row.shift.dx} px sideways of the screen`)
              .toBeLessThanOrEqual(SHIFT_TOLERANCE);
            expect(Math.abs(row.shift.dy), `${row.label}: the file is ${row.shift.dy} px below the screen`)
              .toBeLessThanOrEqual(SHIFT_TOLERANCE);
            // Nothing clipped: the file's ink is inside the box it was given.
            const f = row.file!;
            expect(f.x0, `${row.label}: file ink left of its box`).toBeGreaterThanOrEqual(row.box.x0 - TOLERANCE - 1);
            expect(f.y0, `${row.label}: file ink above its box`).toBeGreaterThanOrEqual(row.box.y0 - TOLERANCE - 1);
            expect(f.x1, `${row.label}: file ink right of its box`).toBeLessThanOrEqual(row.box.x1 + TOLERANCE);
            expect(f.y1, `${row.label}: file ink below its box`).toBeLessThanOrEqual(row.box.y1 + TOLERANCE);
          }
        });
    });
  }
}
