import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { SITE_URL } from '../../core/site';
import { TOOL_PAGES } from '../../core/tool-pages';
import { Landing } from './landing';

/**
 * The landing page is a directory of working tools, not a signup wall (§21.1).
 *
 * The things that would quietly go wrong: a tool added to `core/tool-pages.ts`
 * that never appears in the directory (the safety-net group exists for this),
 * a card that links to a slug no route serves, a filter that hides a tool
 * somebody types the obvious word for, and a second ad frame on the one page
 * that is allowed exactly one. An authenticated visitor is no longer bounced to
 * the dashboard, so the nav must offer the library instead.
 */
describe('Landing', () => {
  let fixture: ComponentFixture<Landing>;
  let authenticated: ReturnType<typeof signal<boolean>>;

  function render(signedIn = false): HTMLElement {
    authenticated = signal(signedIn);
    TestBed.configureTestingModule({
      imports: [Landing],
      providers: [
        provideRouter([]),
        { provide: AuthFacade, useValue: { isAuthenticated: authenticated } },
      ],
    });
    fixture = TestBed.createComponent(Landing);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const links = () =>
    [...fixture.nativeElement.querySelectorAll('[data-test^="tool-link-"]')] as HTMLAnchorElement[];

  function filter(text: string): void {
    const input = fixture.nativeElement.querySelector('[data-test="tool-filter"]') as HTMLInputElement;
    input.value = text;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  afterEach(() => {
    document.querySelector('link[rel="canonical"]')?.remove();
    TestBed.resetTestingModule();
  });

  it('lists every tool in the table exactly once, each linking its own slug', () => {
    render();
    const hrefs = links().map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBe(TOOL_PAGES.length);
    expect(new Set(hrefs).size).toBe(TOOL_PAGES.length);
    expect([...hrefs].sort()).toEqual(TOOL_PAGES.map((t) => `/${t.slug}`).sort());
  });

  it('puts a card in the six kicker groups, in contract order', () => {
    const el = render();
    const headings = [...el.querySelectorAll('[data-test="tool-grid"] h2.kicker')]
      .map((h) => h.textContent!.trim());
    expect(headings).toEqual([
      'Organize', 'Edit & annotate', 'Convert & OCR', 'Optimize & review', 'Protect', 'Sign',
    ]);
    // Nothing fell through to the safety-net group, which only appears when
    // a slug in the table has no place in the directory.
    expect(headings).not.toContain('More');
  });

  it('gives every card an icon and the short name', () => {
    render();
    for (const card of links()) {
      expect(card.classList).toContain('tool-card');
      expect(card.querySelector('app-tool-icon')).not.toBeNull();
      expect(card.textContent!.trim().length).toBeGreaterThan(0);
    }
  });

  it('narrows the directory as you type, matching synonyms as well as names', () => {
    const el = render();
    filter('merge');
    expect(links().map((a) => a.getAttribute('href'))).toEqual(['/merge-pdf']);
    expect(el.querySelector('[data-test="tool-filter-empty"]')).toBeNull();

    // "combine" is nowhere in the card's name — it is a keyword.
    filter('combine');
    expect(links().map((a) => a.getAttribute('href'))).toEqual(['/merge-pdf']);

    // Every term must match, so two words narrow rather than widen.
    filter('pdf word');
    const hrefs = links().map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/pdf-to-word');
    expect(hrefs).toContain('/word-to-pdf');
    expect(hrefs).not.toContain('/merge-pdf');
  });

  it('drops a group whose tools are all filtered out, rather than leaving an empty heading', () => {
    const el = render();
    filter('sign');
    const headings = [...el.querySelectorAll('[data-test="tool-grid"] h2.kicker')]
      .map((h) => h.textContent!.trim());
    expect(headings).toEqual(['Sign']);
  });

  it('says so when nothing matches, and recovers when the filter is cleared', () => {
    const el = render();
    filter('zzzz-not-a-tool');
    expect(links().length).toBe(0);
    expect(el.querySelector('[data-test="tool-filter-empty"]')!.textContent)
      .toContain('No tool matches that');

    filter('   ');
    expect(links().length).toBe(TOOL_PAGES.length);
    expect(el.querySelector('[data-test="tool-filter-empty"]')).toBeNull();
  });

  it('offers a visitor login and signup, and a user their files, in the masthead', () => {
    const el = render(false);
    expect(el.querySelector('[data-test="cta-login"]')!.getAttribute('href')).toBe('/auth/login');
    expect(el.querySelector('[data-test="cta-register"]')!.getAttribute('href')).toBe('/auth/register');
    expect(el.querySelector('[data-test="cta-library"]')).toBeNull();

    authenticated.set(true);
    fixture.detectChanges();
    expect(el.querySelector('[data-test="cta-library"]')!.getAttribute('href')).toBe('/app/dashboard');
    expect(el.querySelector('[data-test="cta-login"]')).toBeNull();
    expect(el.querySelector('[data-test="cta-register"]')).toBeNull();
  });

  it('carries the h1 as a masthead motto and keeps the theme toggle', () => {
    const el = render();
    expect(el.querySelector('header h1.masthead')!.textContent).toContain('Every PDF tool');
    expect(el.querySelector('header [data-test="theme-toggle"]')).not.toBeNull();
  });

  it('places exactly one ad frame, named for the landing surface', () => {
    const el = render();
    const slots = el.querySelectorAll('app-ad-slot');
    expect(slots.length).toBe(1);
    expect(slots[0].getAttribute('name')).toBe('landing');
  });

  it('sets the title, description and a canonical from SITE_URL', () => {
    render();
    expect(TestBed.inject(Title).getTitle())
      .toBe('ZenPDF — every PDF tool, free and without an account');
    const meta = TestBed.inject(Meta);
    expect(meta.getTag('name="description"')!.content).toContain('no account needed');
    expect(meta.getTag('property="og:type"')!.content).toBe('website');
    expect(document.querySelector('link[rel="canonical"]')!.getAttribute('href'))
      .toBe(`${SITE_URL}/`);
  });
});
