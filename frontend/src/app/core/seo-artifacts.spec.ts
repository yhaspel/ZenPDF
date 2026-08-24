import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  CONTENT_PAGES,
  buildRobots,
  buildSitemap,
  extractSiteUrl,
  extractSlugs,
} from '../../../tools/seo.mjs';
import { GUIDE_SLUGS } from './guide-pages';
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

  // The guide table is deliberately shaped like the tool table so that one
  // parser reads both. If a guide's `slug:` line is ever reformatted, this is
  // what says so — rather than twelve pages quietly leaving the sitemap.
  it('the generator parses the guide table with the same function', () => {
    expect(extractSlugs(read('src/app/core/guide-pages.ts'))).toEqual(GUIDE_SLUGS);
  });

  it('the generator reads the same site origin the app imports', () => {
    expect(extractSiteUrl(read('src/app/core/site.ts'))).toBe(SITE_URL);
  });

  it('the committed sitemap matches what the route table generates', () => {
    expect(read('public/sitemap.xml')).toBe(
      buildSitemap([...TOOL_SLUGS], SITE_URL, [...GUIDE_SLUGS]),
    );
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
    expect(() => buildSitemap([...TOOL_SLUGS], undefined, [])).toThrow();
    expect(() => buildRobots('')).toThrow();
  });

  // Same reasoning as the origin: a caller that forgot the guides would
  // produce a sitemap silently missing twelve pages, and a sitemap is exactly
  // the artifact where a silent omission is invisible until it matters.
  it('an omitted guide set fails rather than producing a short sitemap', () => {
    expect(() => (buildSitemap as (...a: unknown[]) => string)([...TOOL_SLUGS], SITE_URL)).toThrow();
  });

  // `/verify` is RenderMode.Client on purpose (app.routes.server.ts), so a
  // crawler following a sitemap entry for it gets the SPA shell — the landing
  // page's title and H1 under a second URL.
  it('does not advertise routes that are deliberately not prerendered', () => {
    expect(CONTENT_PAGES).not.toContain('verify');
    expect(read('public/sitemap.xml')).not.toContain('/verify<');
  });

  it('the sitemap lists every tool page, every guide and the landing page', () => {
    const sitemap = read('public/sitemap.xml');
    for (const slug of TOOL_SLUGS) {
      expect(sitemap).toContain(`/${slug}<`);
    }
    for (const slug of GUIDE_SLUGS) {
      expect(sitemap).toContain(`/guides/${slug}<`);
    }
    expect((sitemap.match(/<url>/g) ?? []).length).toBe(
      TOOL_SLUGS.length + GUIDE_SLUGS.length + CONTENT_PAGES.length + 1,
    );
  });

  it('the sitemap lists the content pages an ad review crawls for', () => {
    // "Substantive public content for crawl" is a named item on the AdSense
    // readiness checklist — a policy page that is live but unlisted is one the
    // reviewer may never see (§9A). `/contact` and `/guides` joined them in
    // Phase 11, and they are the two the reviewer is most likely to go looking
    // for after the policies.
    const sitemap = read('public/sitemap.xml');
    for (const page of ['about', 'contact', 'guides', 'legal/privacy', 'legal/terms']) {
      expect(sitemap).toContain(`/${page}<`);
    }
  });

  // The tool pages are what the site is for; the guides support them (§21.6).
  it('gives guides a lower priority than the tools they support', () => {
    const sitemap = read('public/sitemap.xml');
    const priorityOf = (loc: string) =>
      new RegExp(`<loc>[^<]*${loc}</loc>\\s*<changefreq>[^<]*</changefreq>\\s*<priority>([^<]*)</priority>`)
        .exec(sitemap)?.[1];
    expect(priorityOf('/guides/how-to-merge-pdf-files')).toBe('0.6');
    expect(priorityOf('/merge-pdf')).toBe('0.8');
    // The index is a content page, not an article.
    expect(priorityOf('/guides')).toBe('0.8');
    expect(priorityOf(`${SITE_URL}/`)).toBe('1.0');
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
