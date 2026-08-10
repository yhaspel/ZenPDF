/**
 * Types for `tools/seo.mjs` — the sitemap/robots builders (§21.6).
 * Plain ESM so the generator can run as a prebuild step without a TypeScript
 * toolchain; `seo-artifacts.spec.ts` imports it to prove the committed output
 * still matches the route table.
 */
declare module '*seo.mjs' {
  export const CONTENT_PAGES: string[];
  export function extractSlugs(toolPagesSource: string): string[];
  export function extractSiteUrl(siteSource: string): string;
  // `siteUrl` is required and unvalidated at the type level on purpose: the
  // optional parameter with a localhost default is exactly how production came
  // to ship a sitemap advertising `http://localhost:4200`. Passing nothing now
  // throws at build time — and the spec asserts that it does.
  export function buildSitemap(slugs: string[], siteUrl: string | undefined): string;
  export function buildRobots(siteUrl: string): string;
}
