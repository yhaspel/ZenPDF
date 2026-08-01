/**
 * Pure builders for the SEO artifacts (01-architecture.md §21.6).
 *
 * Kept free of side effects and of any path assumption so the unit test can
 * import them: `generate-seo.mjs` is the CLI that reads and writes, this is the
 * logic it uses.
 */
export const DEFAULT_SITE_URL = 'http://localhost:4200';

/** Slugs, parsed from the route table — never re-listed here (§21.6). */
export function extractSlugs(toolPagesSource) {
  return [...toolPagesSource.matchAll(/^\s*slug:\s*'([a-z0-9-]+)',$/gm)].map((m) => m[1]);
}

export function buildSitemap(slugs, siteUrl = DEFAULT_SITE_URL) {
  const base = siteUrl.replace(/\/$/, '');
  const urls = ['', ...slugs]
    .map((slug) => {
      const loc = slug ? `${base}/${slug}` : `${base}/`;
      const priority = slug ? '0.8' : '1.0';
      return `  <url>\n    <loc>${loc}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function buildRobots(siteUrl = DEFAULT_SITE_URL) {
  const base = siteUrl.replace(/\/$/, '');
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
