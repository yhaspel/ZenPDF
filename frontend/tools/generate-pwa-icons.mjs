/**
 * Rasterize the app icons for the web app manifest and iOS from the two SVG
 * sources beside this file: `pwa-icon.svg` (purpose "any") and
 * `pwa-icon-maskable.svg` (purpose "maskable", and the apple-touch-icon —
 * iOS paints transparency black, so it gets the full-bleed art).
 *
 * The PNGs are committed, so neither the Docker build nor anyone else needs to
 * run this. Run it only when the sources change: `npm run icons:pwa`.
 *
 * nginx serves every `.png` `public, immutable` for a year and these names
 * carry no hash, so new artwork under an old name would leave every returning
 * visitor — and every installed app without an active service worker — on the
 * old icon, silently. The script therefore refuses to overwrite a PNG whose
 * pixels changed. Bump ICON_VERSION instead: every file gets a new name, the
 * references in the manifest and index.html are rewritten, and the old set is
 * removed. `--force` overwrites in place for someone who knows why.
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ICON_VERSION = 1; // bump when tools/pwa-icon*.svg change
const PREFIX = ICON_VERSION === 1 ? 'icon-' : `icon-v${ICON_VERSION}-`;
const FORCE = process.argv.includes('--force');

const toolsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(toolsDir, '..');
const outDir = join(root, 'public/icons');
const referencing = ['public/manifest.webmanifest', 'src/index.html'];

const targets = [
  ...[72, 96, 128, 144, 152, 192, 384, 512].map((size) => ({
    svg: 'pwa-icon.svg',
    size,
    name: `${PREFIX}${size}x${size}.png`,
  })),
  ...[180, 192, 512].map((size) => ({
    svg: 'pwa-icon-maskable.svg',
    size,
    name: `${PREFIX}maskable-${size}x${size}.png`,
  })),
];

const pixels = (png) => sharp(png).ensureAlpha().raw().toBuffer();

await mkdir(outDir, { recursive: true });
const rendered = [];
const changed = [];
for (const { svg, size, name } of targets) {
  const png = await sharp(await readFile(join(toolsDir, svg)), { density: 72 * (size / 32) })
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const existing = await readFile(join(outDir, name)).catch(() => null);
  // The same pixels re-encoded differently (a sharp upgrade) is not a change.
  const unchanged =
    existing !== null && (existing.equals(png) || (await pixels(existing)).equals(await pixels(png)));
  if (existing !== null && !unchanged) changed.push(name);
  rendered.push({ name, size, png, unchanged });
}

if (changed.length && !FORCE) {
  console.error(
    `✖ Refusing to overwrite ${changed.length} icon(s) whose pixels changed under existing filenames:\n` +
      `    ${changed.join('\n    ')}\n` +
      '  /icons/*.png is cached immutable for a year. Bump ICON_VERSION and re-run (new names, manifest +\n' +
      '  index.html rewritten, old set removed), or pass --force to knowingly overwrite in place.',
  );
  process.exit(1);
}

for (const { name, size, png, unchanged } of rendered) {
  if (unchanged) {
    console.log(`  ${name} unchanged`);
    continue;
  }
  await writeFile(join(outDir, name), png);
  console.log(`  ${name} (${size}x${size}, ${png.length} bytes)`);
}

const ICON_REF = /icon(?:-v\d+)?-(maskable-)?(\d+x\d+)\.png/g;
for (const file of referencing) {
  const path = join(root, file);
  const before = await readFile(path, 'utf8');
  const after = before.replace(ICON_REF, (_, maskable = '', dims) => `${PREFIX}${maskable}${dims}.png`);
  if (after !== before) {
    await writeFile(path, after);
    console.log(`  rewrote icon references in ${file}`);
  }
}

const keep = new Set(targets.map((t) => t.name));
for (const file of await readdir(outDir)) {
  if (/^icon(-v\d+)?-(maskable-)?\d+x\d+\.png$/.test(file) && !keep.has(file)) {
    await unlink(join(outDir, file));
    console.log(`  removed stale ${file}`);
  }
}
