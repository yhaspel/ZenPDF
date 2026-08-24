import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { GUIDE_PAGES, guideBySlug } from '../../core/guide-pages';
import { SITE_URL } from '../../core/site';
import { GuidePage } from './guide-page';
import { GuidesIndex } from './guides-index';

/**
 * `applySeo()` runs in a `queueMicrotask` — deliberately, so it also runs on
 * the server — which means the title, canonical and JSON-LD are not set by the
 * time `detectChanges()` returns. Flushing the microtask queue here rather
 * than in each test: without it a late write from one spec lands during the
 * next one, and the failure reads as the wrong guide being rendered.
 */
async function renderGuide(slug: string): Promise<HTMLElement> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [GuidePage], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(GuidePage);
  fixture.componentRef.setInput('guide', guideBySlug(slug));
  fixture.detectChanges();
  await Promise.resolve();
  return fixture.nativeElement as HTMLElement;
}

/** The JSON-LD is appended to `document.head`, not to the component. */
function jsonLd(): Record<string, unknown> {
  const script = document.getElementById('zen-guide-jsonld');
  return JSON.parse(script!.textContent!);
}

describe('guide page', () => {
  afterEach(() => document.getElementById('zen-guide-jsonld')?.remove());

  it('renders every section and every paragraph', async () => {
    const guide = guideBySlug('how-to-redact-a-pdf-properly')!;
    const el = await renderGuide(guide.slug);
    expect(el.querySelectorAll('[data-test="guide-section"]').length).toBe(guide.sections.length);
    const text = el.textContent!;
    for (const section of guide.sections) {
      if (section.heading) expect(text).toContain(section.heading);
      for (const paragraph of section.paragraphs) {
        expect(text).toContain(paragraph);
      }
    }
  });

  it('carries the H1 and a byline naming the author and the date', async () => {
    const el = await renderGuide('how-to-merge-pdf-files');
    expect(el.querySelector('[data-test="guide-h1"]')!.textContent!.trim()).toBe(
      'How to merge PDF files',
    );
    const byline = el.querySelector('[data-test="guide-byline"]')!;
    expect(byline.textContent).toContain('the ZenPDF team');
    expect(byline.textContent).toContain('Published 24 August 2026');
    // The machine-readable copy goes in `datetime`, never in the body copy.
    expect(byline.querySelector('time')!.getAttribute('datetime')).toBe('2026-08-24');
    expect(byline.textContent).not.toContain('2026-08-24');
  });

  it('shows "Updated" only when it differs from published', async () => {
    // Every guide ships published === updated today, so the line is absent —
    // "Published 24 August · Updated 24 August" reads as churn (§4).
    const byline = (await renderGuide('how-to-merge-pdf-files')).querySelector(
      '[data-test="guide-byline"]',
    )!;
    expect(byline.textContent).not.toContain('Updated');
    expect(byline.querySelectorAll('time').length).toBe(1);
  });

  it('renders the related tools as cards that resolve to real tool pages', async () => {
    const guide = guideBySlug('what-is-ocr-make-a-scanned-pdf-searchable')!;
    const el = await renderGuide(guide.slug);
    const cards = [...el.querySelectorAll<HTMLAnchorElement>('[data-test^="guide-tool-"]')];
    expect(cards.length).toBe(guide.relatedTools.length);
    for (const card of cards) {
      // The landing directory's own card, not a new component (§4).
      expect(card.classList).toContain('tool-card');
      expect(card.getAttribute('href')).toMatch(/^\/[a-z0-9-]+$/);
      expect(card.querySelector('svg.ti')).not.toBeNull();
    }
  });

  it('puts the standing caution in a notice, with its link inside it', async () => {
    const el = await renderGuide('are-electronic-signatures-legally-binding');
    const note = el.querySelector('[data-test="guide-note"]')!;
    expect(note.classList).toContain('notice');
    expect(note.classList).toContain('notice-info');
    expect(note.textContent).toContain('not legal advice');
    expect(
      note.querySelector('[data-test="guide-note-link"]')!.getAttribute('href'),
    ).toBe('/legal/esign-disclosure');
  });

  it('draws no notice on a guide that has no caution', async () => {
    const el = await renderGuide('how-to-merge-pdf-files');
    expect(el.querySelector('[data-test="guide-note"]')).toBeNull();
  });

  it('emits Article JSON-LD with the dates and a canonical url', async () => {
    await renderGuide('flatten-pdf-what-it-means');
    const ld = jsonLd();
    expect(ld['@type']).toBe('Article');
    expect(ld['headline']).toBe('What flattening a PDF means');
    expect(ld['datePublished']).toBe('2026-08-24');
    expect(ld['dateModified']).toBe('2026-08-24');
    expect((ld['author'] as Record<string, string>)['name']).toBe('the ZenPDF team');
    expect(ld['url']).toBe(`${SITE_URL}/guides/flatten-pdf-what-it-means`);
  });

  it('sets the title and canonical from the table, never from document.location', async () => {
    await renderGuide('how-to-redact-a-pdf-properly');
    expect(TestBed.inject(Title).getTitle()).toBe(
      'How to redact a PDF properly: a black box is not enough | ZenPDF',
    );
    const canonical = document
      .querySelector('link[rel="canonical"]')!
      .getAttribute('href');
    expect(canonical).toBe(`${SITE_URL}/guides/how-to-redact-a-pdf-properly`);
  });

  it('carries no ad slot — guide pages are not one of the three surfaces', async () => {
    // §7 fixes the ad surfaces at landing, dashboard rail and tool result.
    // Adding a fourth is a contract decision this phase did not make.
    const el = await renderGuide('how-to-merge-pdf-files');
    expect(el.querySelector('app-ad-slot')).toBeNull();
  });
});

describe('guides index', () => {
  function render(): HTMLElement {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [GuidesIndex], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(GuidesIndex);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists every guide, once, linking each one', () => {
    const el = render();
    const links = [...el.querySelectorAll<HTMLAnchorElement>('[data-test^="guide-link-"]')];
    expect(links.length).toBe(GUIDE_PAGES.length);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      GUIDE_PAGES.map((g) => `/guides/${g.slug}`),
    );
  });

  it('gives each entry its title, its one-line description and its date', () => {
    const el = render();
    const first = el.querySelector(`[data-test="guide-link-${GUIDE_PAGES[0].slug}"]`)!;
    expect(first.querySelector('.guide-row-title')!.textContent!.trim()).toBe(GUIDE_PAGES[0].h1);
    expect(first.querySelector('.guide-row-desc')!.textContent!.trim()).toBe(
      GUIDE_PAGES[0].metaDescription,
    );
    expect(first.querySelector('time')!.textContent!.trim()).toBe('24 August 2026');
  });

  it('sits on the reading column and carries no ads or filter', () => {
    const el = render();
    expect(el.querySelector('main.wrap-reading')).not.toBeNull();
    expect(el.querySelector('app-ad-slot')).toBeNull();
    // Twelve entries need no filter, and a tag system is the first step
    // toward the CMS the phase forbids (§4).
    expect(el.querySelector('input')).toBeNull();
  });
});
