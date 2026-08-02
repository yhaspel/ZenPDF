/**
 * Types for `tools/seo.mjs` — the sitemap/robots builders (§21.6).
 * Plain ESM so the generator can run as a prebuild step without a TypeScript
 * toolchain; `seo-artifacts.spec.ts` imports it to prove the committed output
 * still matches the route table.
 */
declare module '*seo.mjs' {
  export const DEFAULT_SITE_URL: string;
  export const CONTENT_PAGES: string[];
  export function extractSlugs(toolPagesSource: string): string[];
  export function buildSitemap(slugs: string[], siteUrl?: string): string;
  export function buildRobots(siteUrl?: string): string;
}
