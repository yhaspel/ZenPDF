import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { TOOL_PAGES } from '../../core/tool-pages';
import { NotFound } from './not-found';

/**
 * The 404 (phase-10 §10.5).
 *
 * It replaced a silent redirect to the landing page, so the properties worth
 * guarding are the ones a redirect lacked: the page says the address was
 * wrong, it is marked `noindex` so a dead link does not become a thin page in
 * the index, and it offers real tools rather than a dead end.
 */
describe('NotFound', () => {
  function render(): HTMLElement {
    TestBed.configureTestingModule({ imports: [NotFound], providers: [provideRouter([])] });
    const fixture = TestBed.createComponent(NotFound);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    TestBed.inject(Meta).removeTag('name="robots"');
    TestBed.resetTestingModule();
  });

  it('says the page is not here and that nothing uploaded was affected', () => {
    const el = render();
    expect(el.querySelector('[data-test="not-found"]')!.textContent!.trim())
      .toBe('That page is not here');
    expect(el.textContent).toContain('Nothing you uploaded is affected');
  });

  it('links home from the sheet itself', () => {
    const home = render().querySelector<HTMLAnchorElement>('[data-test="not-found-home"]')!;
    expect(home.getAttribute('href')).toBe('/');
    expect(home.textContent).toContain('Back to ZenPDF');
  });

  it('sets a page title and tells crawlers not to index it', () => {
    render();
    expect(TestBed.inject(Title).getTitle()).toBe('Page not found | ZenPDF');
    expect(TestBed.inject(Meta).getTag('name="robots"')!.content).toBe('noindex');
  });

  it('offers the first six tools from the table, each linking its own slug', () => {
    const el = render();
    const chips = [...el.querySelectorAll<HTMLAnchorElement>('main ul a')];
    expect(chips.map((a) => a.getAttribute('href'))).toEqual(
      TOOL_PAGES.slice(0, 6).map((t) => `/${t.slug}`),
    );
    expect(chips.map((a) => a.textContent!.trim())).toEqual(
      TOOL_PAGES.slice(0, 6).map((t) => t.h1),
    );
  });

  it('keeps the theme toggle and carries no ad', () => {
    const el = render();
    expect(el.querySelector('[data-test="theme-toggle"]')).not.toBeNull();
    expect(el.querySelector('app-ad-slot')).toBeNull();
  });
});
