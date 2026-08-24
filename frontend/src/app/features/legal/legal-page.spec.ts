import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { EMPTY } from 'rxjs';

import { ConfigService } from '../../core/services/config.service';
import { SUPPORT_EMAIL } from '../../core/site';
import { LegalKind, LegalPage } from './legal-page';

/** `/api/config/` never answers in a unit test, and the component is built to
 *  fall back on `core/retention.ts` when it does not (that is the whole point
 *  of that file). EMPTY is the honest stand-in for "the call is in flight". */
class StubConfig {
  config() {
    return EMPTY;
  }
}

function renderKind(kind: string): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [LegalPage],
    providers: [
      provideRouter([]),
      { provide: ConfigService, useClass: StubConfig },
      { provide: ActivatedRoute, useValue: { snapshot: { data: { kind } } } },
    ],
  });
  const fixture = TestBed.createComponent(LegalPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/**
 * One component serves privacy, terms, about and — since 2026-08-24 —
 * contact. Two things about it are easy to get wrong and invisible when you
 * do: the constructor's title/meta map is indexed by kind, and the template's
 * `@switch` used to have a `@default`. Together those meant a route added with
 * an unknown kind rendered the About page under its URL with the About title,
 * which is duplicate content that looks like it works.
 */
describe('legal page', () => {
  it('renders every kind it declares, each with its own H1 and title', () => {
    const expected: Record<LegalKind, [string, string]> = {
      privacy: ['Privacy policy', 'Privacy policy | ZenPDF'],
      terms: ['Terms of service', 'Terms of service | ZenPDF'],
      about: ['About ZenPDF', 'About ZenPDF — a free PDF workspace'],
      contact: ['Contact', 'Contact ZenPDF — how to reach us'],
    };
    for (const [kind, [h1, title]] of Object.entries(expected)) {
      const el = renderKind(kind);
      expect(el.querySelector('[data-test="legal-h1"]')!.textContent!.trim()).toBe(h1);
      expect(TestBed.inject(Title).getTitle()).toBe(title);
    }
  });

  it('fails loudly on a kind nobody added an entry for', () => {
    // Previously: `undefined.title`, three lines later, blaming the wrong
    // thing — and a template that rendered About anyway.
    expect(() => renderKind('careers')).toThrow(/no title\/meta entry for kind 'careers'/);
  });

  describe('contact', () => {
    it('prints the support address as a mailto, from the one place it is written down', () => {
      const link = renderKind('contact').querySelector<HTMLAnchorElement>(
        '[data-test="contact-mailto"]',
      )!;
      expect(link.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}`);
      expect(link.textContent!.trim()).toBe(SUPPORT_EMAIL);
    });

    it('has no form — outbound SMTP is off, so a form would send nothing', () => {
      const el = renderKind('contact');
      expect(el.querySelector('form')).toBeNull();
      expect(el.querySelector('input')).toBeNull();
      expect(el.querySelector('textarea')).toBeNull();
      // A submit button with no form is the same dead affordance wearing a
      // different tag.
      expect(el.querySelector('button[type="submit"]')).toBeNull();
    });

    it('points a report of a signature request at the ceremony flow, not the address', () => {
      expect(renderKind('contact').textContent).toContain('Report this request');
    });

    it('reads the retention number rather than typing it into the copy', () => {
      // `RETENTION.guest_hours` is 24 and a backend test pins it to the
      // sweeper's own setting; hard-coding "24" here would be a second claim
      // that could drift from the first.
      expect(renderKind('contact').textContent).toContain('within 24 hours');
    });

    it('sits on the reading column, not the .sheet the contract reserves', () => {
      const el = renderKind('contact');
      expect(el.querySelector('main.wrap-reading')).not.toBeNull();
      expect(el.querySelector('.sheet')).toBeNull();
    });
  });

  describe('about', () => {
    it('answers "who runs this" and links /contact', () => {
      const el = renderKind('about');
      const identity = el.querySelector('[data-test="about-identity"]')!;
      expect(identity.textContent).toContain('independent product');
      expect(
        el.querySelector('[data-test="about-contact-link"]')!.getAttribute('href'),
      ).toBe('/contact');
    });
  });
});
