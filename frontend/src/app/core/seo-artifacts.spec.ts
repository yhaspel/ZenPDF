import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildRobots, buildSitemap, extractSlugs } from '../../../tools/seo.mjs';
import { TOOL_SLUGS } from './tool-pages';

/** Repo root, resolved from this spec rather than from the generator module. */
const root = resolve(process.cwd());

function read(relative: string): string {
  return readFileSync(resolve(root, relative), 'utf8');
}

/**
 * `sitemap.xml` is generated from the route table, not hand-maintained (§21.6).
 * The generator parses the table; these tests prove the committed output still
 * matches it, so editing the table without regenerating fails the build rather
 * than silently dropping a page out of the index.
 */
describe('generated SEO artifacts', () => {
  it('the generator parses the same slugs the route table exports', () => {
    expect(extractSlugs(read('src/app/core/tool-pages.ts'))).toEqual(TOOL_SLUGS);
  });

  it('the committed sitemap matches what the route table generates', () => {
    expect(read('public/sitemap.xml')).toBe(buildSitemap([...TOOL_SLUGS]));
  });

  it('the sitemap lists every tool page and the landing page', () => {
    const sitemap = read('public/sitemap.xml');
    for (const slug of TOOL_SLUGS) {
      expect(sitemap).toContain(`/${slug}<`);
    }
    expect((sitemap.match(/<url>/g) ?? []).length).toBe(TOOL_SLUGS.length + 1);
  });

  it('robots.txt disallows /app/, /s/ and /api/ and points at the sitemap', () => {
    const robots = read('public/robots.txt');
    expect(robots).toBe(buildRobots());
    expect(robots).toContain('Disallow: /app/');
    expect(robots).toContain('Disallow: /s/');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Sitemap:');
    // Tool pages must stay crawlable.
    expect(robots).toContain('Allow: /');
  });
});
