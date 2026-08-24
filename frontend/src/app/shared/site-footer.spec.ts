import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { SiteFooter } from './site-footer';

@Component({ template: '<app-site-footer />', imports: [SiteFooter] })
class Host {}

function render(): HTMLElement {
  TestBed.configureTestingModule({ imports: [Host], providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/**
 * The footer's link set is a design-contract invariant (§3 footer, §10), and
 * it is one of the two things an ad-network review looks for from any page on
 * the site. It went from five links to seven on 2026-08-24 (Phase 11), which
 * is exactly the kind of change that is easy to make twice, or to make in the
 * wrong place.
 */
describe('site footer', () => {
  it('carries exactly the seven contracted links, in the contracted order', () => {
    const links = [...render().querySelectorAll('.ftr a')];
    expect(links.map((a) => a.textContent!.trim())).toEqual([
      'About',
      'Privacy',
      'Terms',
      'E-sign disclosure',
      'Verify a signed PDF',
      'Contact',
      'Guides',
    ]);
    expect(links.map((a) => a.getAttribute('data-test'))).toEqual([
      'footer-about',
      'footer-privacy',
      'footer-terms',
      'footer-esign',
      'footer-verify',
      'footer-contact',
      'footer-guides',
    ]);
  });

  it('points the two new links at the routes Phase 11 added', () => {
    const el = render();
    expect(el.querySelector('[data-test="footer-contact"]')!.getAttribute('href')).toBe('/contact');
    expect(el.querySelector('[data-test="footer-guides"]')!.getAttribute('href')).toBe('/guides');
  });

  it('keeps the fact line', () => {
    expect(render().querySelector('.ftr-fact')!.textContent!.trim()).toBe(
      'Free, paid for by advertising. Files are deleted automatically.',
    );
  });

  /**
   * The ceremony writes its own footer inline rather than using this
   * component, and §3 pins that set **verbatim** — it does not gain Contact or
   * Guides. Asserted against the template source rather than by rendering the
   * ceremony, which would need a token, a request and a live API: the risk
   * being guarded is somebody editing `ceremony.html` to "match" the site
   * footer, and the source is where that edit would land.
   */
  it('is not the ceremony footer, which keeps its own five links unchanged', () => {
    const html = readFileSync(
      resolve(process.cwd(), 'src/app/features/sign/ceremony.html'),
      'utf8',
    );
    const footer = html.slice(html.indexOf('<footer'), html.indexOf('</footer>'));
    const tests = [...footer.matchAll(/data-test="([^"]+)"/g)].map((m) => m[1]);
    expect(tests).toEqual([
      'footer-about',
      'footer-privacy',
      'footer-terms',
      'footer-esign',
      'report-open',
    ]);
    expect(footer).not.toContain('footer-contact');
    expect(footer).not.toContain('footer-guides');
    // The not-a-QES sentence is a §10 verbatim invariant of its own.
    expect(footer).toContain('not a qualified electronic signature');
  });

  /**
   * The legal pages carry an in-page crosslink row that is *not* the footer
   * and is explicitly unchanged by Phase 11 — `/contact` and `/guides` enter
   * through the site footer only (§3).
   */
  it('leaves the legal pages in-page crosslink row alone', () => {
    const html = readFileSync(
      resolve(process.cwd(), 'src/app/features/legal/legal-page.html'),
      'utf8',
    );
    const row = html.slice(html.lastIndexOf('<p class="faint mt-12'));
    expect([...row.matchAll(/routerLink="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/',
      '/legal/privacy',
      '/legal/terms',
      '/legal/esign-disclosure',
      '/about',
    ]);
  });
});
