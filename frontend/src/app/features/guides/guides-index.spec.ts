import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { GUIDE_PAGES } from '../../core/guide-pages';
import { SITE_URL } from '../../core/site';
import { GuidesIndex } from './guides-index';

/**
 * `/guides` — what `guide-page.spec.ts` does not already cover.
 *
 * That file pins the list itself (every guide, once, linked). This one pins
 * the index as a page: the title and description a crawler sees, the canonical
 * that must come from `SITE_URL` rather than the prerenderer's synthetic
 * location, the machine-readable date on each row, and that the H1 and the
 * table stay in step — a guide added to `core/guide-pages.ts` must appear here
 * without anybody touching the component.
 */
describe('GuidesIndex', () => {
  function render(): HTMLElement {
    TestBed.configureTestingModule({ imports: [GuidesIndex], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(GuidesIndex);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    document.querySelector('link[rel="canonical"]')?.remove();
    TestBed.resetTestingModule();
  });

  it('carries the Guides H1 and the index title and description', () => {
    const el = render();
    expect(el.querySelector('[data-test="guides-h1"]')!.textContent!.trim()).toBe('Guides');
    expect(TestBed.inject(Title).getTitle()).toBe('Guides — how PDF tools actually work | ZenPDF');
    const meta = TestBed.inject(Meta);
    expect(meta.getTag('name="description"')!.content).toContain('Plain guides to merging');
    expect(meta.getTag('property="og:title"')!.content).toContain('Guides');
  });

  it('sets the canonical from SITE_URL, not document.location', () => {
    render();
    expect(document.querySelector('link[rel="canonical"]')!.getAttribute('href'))
      .toBe(`${SITE_URL}/guides`);
  });

  it('gives every row a machine-readable date beside the spelled-out one', () => {
    const el = render();
    const times = [...el.querySelectorAll<HTMLTimeElement>('[data-test^="guide-link-"] time')];
    expect(times.length).toBe(GUIDE_PAGES.length);
    times.forEach((time, i) => {
      expect(time.getAttribute('datetime')).toBe(GUIDE_PAGES[i].updated);
      // The body copy spells the month out; the ISO form lives only in the attribute.
      expect(time.textContent).not.toContain(GUIDE_PAGES[i].updated);
    });
  });

  it('shows each guide under its own H1 and description, in table order', () => {
    const el = render();
    const titles = [...el.querySelectorAll('.guide-row-title')].map((n) => n.textContent!.trim());
    expect(titles).toEqual(GUIDE_PAGES.map((g) => g.h1));
    const descs = [...el.querySelectorAll('.guide-row-desc')].map((n) => n.textContent!.trim());
    expect(descs).toEqual(GUIDE_PAGES.map((g) => g.metaDescription));
  });
});
