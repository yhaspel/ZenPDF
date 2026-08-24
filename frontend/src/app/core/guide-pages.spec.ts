import { routes } from '../app.routes';
import { serverRoutes } from '../app.routes.server';
import { GUIDE_PAGES, GUIDE_SLUGS, guideBySlug } from './guide-pages';
import { TOOL_PAGES, TOOL_SLUGS } from './tool-pages';

/** Body prose only — headings and the standing `.notice` are not the article. */
function bodyWords(guide: (typeof GUIDE_PAGES)[number]): number {
  return guide.sections
    .flatMap((s) => s.paragraphs)
    .join(' ')
    .trim()
    .split(/\s+/).length;
}

/**
 * The mechanical quality floor (phase-11 §11C).
 *
 * These are **floors against accidental thinness, not targets**. The phase
 * they belong to exists because a site of nothing but widgets reads as low
 * value content, and the counter is a small number of genuinely good pages.
 * A floor cannot tell whether a guide is good — that is what the owner's skim
 * is for — but it can stop one silently eroding into a stub.
 */
describe('guide pages', () => {
  it('ships the twelve guides the phase named', () => {
    expect(GUIDE_SLUGS).toEqual([
      'how-to-merge-pdf-files',
      'compress-pdf-without-losing-quality',
      'fill-and-sign-pdf-without-printing',
      'are-electronic-signatures-legally-binding',
      'what-is-ocr-make-a-scanned-pdf-searchable',
      'pdf-to-word-conversion-explained',
      'how-to-redact-a-pdf-properly',
      'password-protect-pdf-what-encryption-actually-does',
      'organize-scanned-pages-split-reorder-rotate',
      'email-a-pdf-thats-too-big',
      'pdf-page-numbers-and-bates-stamping',
      'flatten-pdf-what-it-means',
    ]);
  });

  it('gives every guide at least 700 words of body prose', () => {
    for (const guide of GUIDE_PAGES) {
      expect(`${guide.slug}: ${bodyWords(guide)} words`).toBe(
        `${guide.slug}: ${Math.max(bodyWords(guide), 700)} words`,
      );
    }
  });

  it('gives every guide at least three sections, each with prose in it', () => {
    for (const guide of GUIDE_PAGES) {
      expect(guide.sections.length).toBeGreaterThanOrEqual(3);
      for (const section of guide.sections) {
        expect(section.paragraphs.length).toBeGreaterThan(0);
        for (const paragraph of section.paragraphs) {
          expect(paragraph.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('gives every guide a unique title, meta description and H1', () => {
    expect(new Set(GUIDE_PAGES.map((g) => g.title)).size).toBe(GUIDE_PAGES.length);
    expect(new Set(GUIDE_PAGES.map((g) => g.metaDescription)).size).toBe(GUIDE_PAGES.length);
    expect(new Set(GUIDE_PAGES.map((g) => g.h1)).size).toBe(GUIDE_PAGES.length);
    for (const guide of GUIDE_PAGES) {
      expect(guide.title.length).toBeGreaterThan(20);
      // Doubles as the one-line description on `/guides`, so it has to read as
      // a sentence as well as fit a search snippet.
      expect(guide.metaDescription.length).toBeGreaterThan(60);
      expect(guide.metaDescription.length).toBeLessThan(200);
    }
  });

  // A guide that names a tool we do not have is a dead affordance in prose,
  // and the related-tools block would render a link to a 404.
  it('names only tools that exist, and names at least one', () => {
    const kinds = new Set(TOOL_PAGES.map((t) => t.kind));
    for (const guide of GUIDE_PAGES) {
      expect(guide.relatedTools.length).toBeGreaterThan(0);
      for (const kind of guide.relatedTools) {
        expect(`${guide.slug} -> ${kind}`).toBe(
          `${guide.slug} -> ${kinds.has(kind) ? kind : 'MISSING TOOL'}`,
        );
      }
      // A guide listing the same tool twice draws the same card twice.
      expect(new Set(guide.relatedTools).size).toBe(guide.relatedTools.length);
    }
  });

  it('keeps slugs unique across tools and guides', () => {
    // Guides live under `/guides/`, so a collision is not a route clash — it is
    // a person searching the sitemap and finding two things with one name.
    const all = [...TOOL_SLUGS, ...GUIDE_SLUGS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('carries fixed, well-formed dates that prerender deterministically', () => {
    for (const guide of GUIDE_PAGES) {
      expect(guide.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(guide.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Updated before published would print a byline that reads as an error.
      expect(guide.updated >= guide.published).toBe(true);
    }
  });

  it('registers a literal router route for every guide, and the index', () => {
    expect(routes.some((r) => r.path === 'guides')).toBe(true);
    for (const slug of GUIDE_SLUGS) {
      expect(routes.some((r) => r.path === `guides/${slug}`)).toBe(true);
    }
    // Not a parameterised route: `guides/:slug` would match every string, so
    // an unknown slug would render an empty article with a 200 instead of
    // falling through to the real 404.
    expect(routes.some((r) => r.path?.startsWith('guides/:'))).toBe(false);
  });

  it('prerenders the index and every guide', () => {
    for (const path of ['guides', ...GUIDE_SLUGS.map((s) => `guides/${s}`)]) {
      const entry = serverRoutes.find((r) => r.path === path);
      expect(`${path}: ${entry?.renderMode}`).toBe(`${path}: ${2 /* Prerender */}`);
    }
  });

  it('resolves a slug back to its definition', () => {
    expect(guideBySlug('flatten-pdf-what-it-means')!.h1).toBe('What flattening a PDF means');
    expect(guideBySlug('nope')).toBeUndefined();
  });

  // Guide 4 is the one with legal content in it, and the caution is not
  // optional — it is the difference between a guide and an opinion about the
  // law. Pinned by name so nobody quietly drops it.
  it('keeps the not-legal-advice caution on the e-signature guide, and its link', () => {
    const guide = guideBySlug('are-electronic-signatures-legally-binding')!;
    const note = guide.sections.map((s) => s.note).find((n) => n !== undefined)!;
    expect(note.text).toContain('not legal advice');
    // §3: the way out lives inside the notice.
    expect(note.link?.href).toBe('/legal/esign-disclosure');
    const prose = guide.sections.flatMap((s) => s.paragraphs).join(' ');
    // It must also say what our signature is not — the same claim
    // `apps/esign/legal.py` makes to every signer.
    expect(prose).toContain('not a qualified electronic signature');
  });
});
