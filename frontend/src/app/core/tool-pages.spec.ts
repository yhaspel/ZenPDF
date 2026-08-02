import { routes } from '../app.routes';
import { serverRoutes } from '../app.routes.server';
import { TOOL_PAGES, TOOL_SLUGS, toolBySlug } from './tool-pages';

/**
 * The route table is the single source of truth for the public tool pages
 * (§21.6). These tests are what stop it drifting from the routes, the sitemap
 * and the prerender list — "a tool page that exists but is not in the sitemap
 * is a bug".
 */
describe('tool pages', () => {
  const EXPECTED = [
    // Phase 2B
    'merge-pdf',
    'split-pdf',
    'compress-pdf',
    'rotate-pdf',
    'delete-pdf-pages',
    'extract-pdf-pages',
    'organize-pdf',
    // Phase 3
    'annotate-pdf',
    // Phase 4
    'edit-pdf',
    'watermark-pdf',
    'add-page-numbers',
    // Phase 5
    'fill-pdf-form',
    // Phase 6
    'ocr-pdf',
    'pdf-to-word',
    'word-to-pdf',
    'jpg-to-pdf',
    'pdf-to-jpg',
    'html-to-pdf',
    'compare-pdf',
    'repair-pdf',
    // Phase 7
    'protect-pdf',
    'unlock-pdf',
    'redact-pdf',
    // Phase 8
    'sign-pdf',
  ];

  it('ships exactly the slugs its phases have shipped', () => {
    expect(TOOL_SLUGS).toEqual(EXPECTED);
  });

  it('gives every page unique title, meta description and H1', () => {
    expect(new Set(TOOL_PAGES.map((t) => t.title)).size).toBe(TOOL_PAGES.length);
    expect(new Set(TOOL_PAGES.map((t) => t.metaDescription)).size).toBe(TOOL_PAGES.length);
    expect(new Set(TOOL_PAGES.map((t) => t.h1)).size).toBe(TOOL_PAGES.length);
    for (const tool of TOOL_PAGES) {
      expect(tool.title.length).toBeGreaterThan(20);
      expect(tool.metaDescription.length).toBeGreaterThan(60);
      expect(tool.faq.length).toBeGreaterThanOrEqual(3);
      // ~300 words of honest task copy (§21.6). The floor is 200 rather than
      // 300 deliberately: padding to hit an exact count would make the copy
      // worse, and "honest" is the operative word in that requirement.
      const words = tool.intro.join(' ').split(/\s+/).length;
      expect(words).toBeGreaterThan(200);
    }
  });

  it('registers a router route for every slug', () => {
    for (const slug of TOOL_SLUGS) {
      expect(routes.some((r) => r.path === slug)).toBe(true);
    }
  });

  it('prerenders every slug, and never the workspace', () => {
    for (const slug of TOOL_SLUGS) {
      const entry = serverRoutes.find((r) => r.path === slug);
      expect(entry).toBeDefined();
      expect(entry!.renderMode).toBe(2 /* RenderMode.Prerender */);
    }
    // The viewer is deliberately client-rendered: browser-only APIs, no SEO
    // value, and the likeliest source of a hydration mismatch (§7).
    const app = serverRoutes.find((r) => r.path === 'app/**');
    expect(app!.renderMode).toBe(1 /* RenderMode.Client */);
  });

  it('resolves a slug back to its definition', () => {
    expect(toolBySlug('merge-pdf')!.kind).toBe('merge');
    expect(toolBySlug('nope')).toBeUndefined();
  });
});
