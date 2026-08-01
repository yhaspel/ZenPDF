/**
 * Verify the shipped artifact really is server-rendered (§20 DoD item 9, §21.6).
 *
 * Prerendering happens in `ng build` (outputMode: static), which is exactly
 * what nginx serves in production. The `ng serve` dev server returns the SPA
 * shell instead, so "is it server-rendered?" has to be asked of the build
 * output — this script asks it mechanically rather than by eye.
 *
 * Usage: npm run build && npm run verify:prerender
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSlugs } from './seo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist/zenpdf-web/browser');

const source = readFileSync(resolve(root, 'src/app/core/tool-pages.ts'), 'utf8');
const slugs = extractSlugs(source);
const titles = [...source.matchAll(/^\s*title:\s*'(.+)',$/gm)].map((m) => m[1]);
const h1s = [...source.matchAll(/^\s*h1:\s*'(.+)',$/gm)].map((m) => m[1]);

const failures = [];
if (!existsSync(dist)) {
  failures.push(`no build output at ${dist} — run \`npm run build\` first`);
}

slugs.forEach((slug, i) => {
  const page = resolve(dist, slug, 'index.html');
  if (!existsSync(page)) {
    failures.push(`${slug}: not prerendered (missing ${slug}/index.html)`);
    return;
  }
  const html = readFileSync(page, 'utf8');
  const expectTitle = titles[i]?.replace(/\\'/g, "'");
  const expectH1 = h1s[i]?.replace(/\\'/g, "'");
  if (expectTitle && !html.includes(`<title>${expectTitle}</title>`)) {
    failures.push(`${slug}: unique <title> not in the served HTML`);
  }
  if (expectH1 && !html.includes(expectH1)) {
    failures.push(`${slug}: <h1> copy not in the served HTML`);
  }
  if (!html.includes('"@type":"FAQPage"')) {
    failures.push(`${slug}: FAQPage JSON-LD not in the served HTML`);
  }
  if (!html.includes('"@type":"SoftwareApplication"')) {
    failures.push(`${slug}: SoftwareApplication JSON-LD not in the served HTML`);
  }
  if (!html.includes('rel="canonical"')) {
    failures.push(`${slug}: canonical link not in the served HTML`);
  }
});

for (const artifact of ['sitemap.xml', 'robots.txt']) {
  if (!existsSync(resolve(dist, artifact))) {
    failures.push(`${artifact} missing from the build output`);
  }
}

if (failures.length) {
  console.error('verify-prerender FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log(
  `verify-prerender: ${slugs.length} tool pages server-rendered with unique ` +
    'title/H1, FAQ + SoftwareApplication JSON-LD, canonical, sitemap and robots.',
);
