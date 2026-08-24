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
    }
  });

  /**
   * The content floors (phase-11 §11C), raised from the originals in the same
   * branch that topped the pages up to clear them.
   *
   * They were 3 FAQs and 200 words, which was the honest floor when the pages
   * were written — "padding to hit an exact count would make the copy worse".
   * That reasoning still holds; what changed is that every page now clears the
   * higher bar on merit, so the floor can record it. Three intros were
   * extended and fourteen pages gained a fourth question, all additively.
   *
   * Measured on 2026-08-24 after the top-up: intros 254–411 words (median
   * 283), every page 4 FAQs except `/fill-pdf-form` at 5.
   */
  it('holds every page to the content floor: 250 words of intro, 4 questions', () => {
    for (const tool of TOOL_PAGES) {
      const words = tool.intro.join(' ').trim().split(/\s+/).length;
      // Compared as strings so a failure names the page and its number rather
      // than saying `223 is not greater than 250` about an anonymous page.
      expect(`${tool.slug}: ${words} words`).toBe(
        `${tool.slug}: ${Math.max(words, 250)} words`,
      );
      expect(`${tool.slug}: ${tool.faq.length} FAQs`).toBe(
        `${tool.slug}: ${Math.max(tool.faq.length, 4)} FAQs`,
      );
    }
  });

  /**
   * There is deliberately **no floor on answer length**. The first draft of
   * this test had one, at 40 characters, and it failed seven existing answers
   * — including "No." to "Do I need an account?" and "Yes. Every frame becomes
   * a page." Those are not thin answers; they are §1's voice working
   * correctly, and a floor that would have had them padded into paragraphs
   * would have made the pages worse to hit a number. Count and uniqueness are
   * mechanical; whether an answer is any good is a reading, not an assertion.
   */
  it('asks each question once per page', () => {
    for (const tool of TOOL_PAGES) {
      expect(new Set(tool.faq.map((f) => f.q)).size).toBe(tool.faq.length);
      for (const item of tool.faq) {
        expect(`${tool.slug} / ${item.q}`).toBe(
          `${tool.slug} / ${item.q.trim()}`,
        );
        expect(item.a.trim().length).toBeGreaterThan(0);
      }
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
