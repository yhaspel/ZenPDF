/**
 * Write `public/sitemap.xml` and `public/robots.txt` from the tool-page route
 * table (01-architecture.md §21.6).
 *
 * "Generated from the route table, not hand-maintained" — a tool page that
 * exists but is not in the sitemap is a bug. Runs as a prebuild/prestart step;
 * `seo-artifacts.spec.ts` fails the build if the committed output drifts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRobots, buildSitemap, extractSlugs } from './seo.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siteUrl = process.env['SITE_URL'] ?? undefined;

const slugs = extractSlugs(readFileSync(resolve(root, 'src/app/core/tool-pages.ts'), 'utf8'));
if (slugs.length === 0) {
  throw new Error('generate-seo: no tool slugs found in src/app/core/tool-pages.ts');
}

writeFileSync(resolve(root, 'public/sitemap.xml'), buildSitemap(slugs, siteUrl));
writeFileSync(resolve(root, 'public/robots.txt'), buildRobots(siteUrl));
console.log(`generate-seo: wrote sitemap.xml (${slugs.length} tool pages) and robots.txt`);
