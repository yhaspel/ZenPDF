import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONTENT_PAGES,
  buildRobots,
  buildSitemap,
  extractSiteUrl,
  extractSlugs,
} from '../../../tools/seo.mjs';
import { SITE_URL } from './site';
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

  it('the generator reads the same site origin the app imports', () => {
    expect(extractSiteUrl(read('src/app/core/site.ts'))).toBe(SITE_URL);
  });

  it('the committed sitemap matches what the route table generates', () => {
    expect(read('public/sitemap.xml')).toBe(buildSitemap([...TOOL_SLUGS], SITE_URL));
  });

  // The artifacts shipped to production for as long as they existed with
  // `http://localhost:4200` in every <loc> and in the Sitemap: directive,
  // because the generator's fallback was a developer default and nothing set
  // SITE_URL in the Railway build. A sitemap whose URLs are on another host is
  // rejected wholesale, so this is the assertion that would have caught it.
  it('the artifacts name the real site, never localhost', () => {
    for (const file of ['public/sitemap.xml', 'public/robots.txt']) {
      expect(read(file)).not.toContain('localhost');
      expect(read(file)).toContain(SITE_URL);
    }
  });

  it('an absent site origin fails the build rather than defaulting', () => {
    expect(() => buildSitemap([...TOOL_SLUGS], undefined)).toThrow();
    expect(() => buildRobots('')).toThrow();
  });

  // `/verify` is RenderMode.Client on purpose (app.routes.server.ts), so a
  // crawler following a sitemap entry for it gets the SPA shell — the landing
  // page's title and H1 under a second URL.
  it('does not advertise routes that are deliberately not prerendered', () => {
    expect(CONTENT_PAGES).not.toContain('verify');
    expect(read('public/sitemap.xml')).not.toContain('/verify<');
  });

  it('the sitemap lists every tool page and the landing page', () => {
    const sitemap = read('public/sitemap.xml');
    for (const slug of TOOL_SLUGS) {
      expect(sitemap).toContain(`/${slug}<`);
    }
    expect((sitemap.match(/<url>/g) ?? []).length).toBe(
      TOOL_SLUGS.length + CONTENT_PAGES.length + 1,
    );
  });

  it('the sitemap lists the content pages an ad review crawls for', () => {
    // "Substantive public content for crawl" is a named item on the AdSense
    // readiness checklist — a policy page that is live but unlisted is one the
    // reviewer may never see (§9A).
    const sitemap = read('public/sitemap.xml');
    for (const page of ['about', 'legal/privacy', 'legal/terms']) {
      expect(sitemap).toContain(`/${page}<`);
    }
  });

  it('robots.txt disallows /app/, /s/ and /api/ and points at the sitemap', () => {
    const robots = read('public/robots.txt');
    expect(robots).toBe(buildRobots(SITE_URL));
    expect(robots).toContain('Disallow: /app/');
    expect(robots).toContain('Disallow: /s/');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Sitemap:');
    // Tool pages must stay crawlable.
    expect(robots).toContain('Allow: /');
  });
});
