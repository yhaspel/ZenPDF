/**
 * Pure builders for the SEO artifacts (01-architecture.md §21.6).
 *
 * Kept free of side effects and of any path assumption so the unit test can
 * import them: `generate-seo.mjs` is the CLI that reads and writes, this is the
 * logic it uses.
 */
/** Slugs, parsed from the route table — never re-listed here (§21.6). */
export function extractSlugs(toolPagesSource) {
  return [...toolPagesSource.matchAll(/^\s*slug:\s*'([a-z0-9-]+)',$/gm)].map((m) => m[1]);
}

/**
 * The site origin, parsed from `core/site.ts` — the same trick as the slugs,
 * and for the same reason: one place to change it.
 *
 * There is deliberately **no default**. The previous default was
 * `http://localhost:4200`, and because nothing set `SITE_URL` in the Railway
 * build, production shipped a sitemap and a robots.txt advertising localhost —
 * silently, for as long as they existed. A missing origin must break the build,
 * not quietly produce artifacts that are worse than none.
 */
export function extractSiteUrl(siteSource) {
  const match = /^export const SITE_URL = '([^']+)';$/m.exec(siteSource);
  if (!match) {
    throw new Error('seo: could not read SITE_URL from src/app/core/site.ts');
  }
  return match[1];
}

function requireBase(siteUrl) {
  if (!siteUrl || !/^https?:\/\//.test(siteUrl)) {
    throw new Error(`seo: an absolute site URL is required, got ${siteUrl ?? 'undefined'}`);
  }
  return siteUrl.replace(/\/$/, '');
}

/**
 * The static content pages, listed here rather than parsed: they are not in the
 * tool route table, and an ad network's review crawls for exactly these (§9A).
 *
 * `verify` is **not** among them, though it used to be. `app.routes.server.ts`
 * makes it `RenderMode.Client` on purpose, so the crawler that follows the
 * sitemap entry is handed the SPA shell — the landing page's title, the landing
 * page's H1, and a canonical pointing at `/`. Listing a route we deliberately
 * do not render is asking to be indexed as duplicate content.
 */
export const CONTENT_PAGES = [
  'about',
  'legal/privacy',
  'legal/terms',
  'legal/esign-disclosure',
];

export function buildSitemap(slugs, siteUrl) {
  const base = requireBase(siteUrl);
  const urls = ['', ...slugs, ...CONTENT_PAGES]
    .map((slug) => {
      const loc = slug ? `${base}/${slug}` : `${base}/`;
      const priority = slug ? '0.8' : '1.0';
      return `  <url>\n    <loc>${loc}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function buildRobots(siteUrl) {
  const base = requireBase(siteUrl);
  // Tool pages are crawlable; the app shell, the signing ceremony and the API
  // are not indexable surfaces (§21.6).
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /app/',
    'Disallow: /s/',
    'Disallow: /api/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}
