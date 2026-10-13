import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { DisclosurePage } from './disclosure-page';

/**
 * `/legal/esign-disclosure` (§7): the consent text at a stable address, with
 * the same version and hash the audit trail recorded at the moment of consent.
 * A page that paraphrased the text, or printed a version of its own, would
 * stop being evidence of anything.
 */
describe('DisclosurePage', () => {
  let fixture: ComponentFixture<DisclosurePage>;
  let http: HttpTestingController;

  const BODY = {
    version: '2026-08-01',
    text: 'You agree to sign electronically.\n\n  Indented second paragraph, kept as is.',
    disclosure_sha256: 'ab'.repeat(32),
  };

  beforeEach(() => {
    document.querySelector('link[rel="canonical"]')?.remove();
    TestBed.configureTestingModule({
      imports: [DisclosurePage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(DisclosurePage);
    fixture.detectChanges();
  });

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  const root = () => fixture.nativeElement as HTMLElement;
  const q = (test: string) => root().querySelector(`[data-test="${test}"]`);

  it('fetches the disclosure from the public endpoint, without a credential', () => {
    const req = http.expectOne('/api/public/sign/disclosure/');
    expect(req.request.method).toBe('GET');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush(BODY);
  });

  it('renders the text verbatim, with its version and fingerprint', () => {
    http.expectOne('/api/public/sign/disclosure/').flush(BODY);
    fixture.detectChanges();

    expect(q('disclosure-text')!.textContent).toBe(BODY.text);
    const meta = root().querySelector('main > p')!.textContent!.replace(/\s+/g, ' ');
    expect(meta).toContain('Version 2026-08-01');
    expect(meta).toContain(`SHA-256 ${BODY.disclosure_sha256}`);
  });

  it('shows no fingerprint until the text has arrived', () => {
    expect(root().querySelector('main > p')!.textContent).not.toContain('SHA-256');
    expect(q('disclosure-text')!.textContent).toBe('');
    http.expectOne('/api/public/sign/disclosure/').flush(BODY);
  });

  it('says so in the text\'s place when it cannot be loaded', () => {
    http.expectOne('/api/public/sign/disclosure/')
      .flush({ error: { code: 'unavailable', message: 'down' } }, { status: 503, statusText: 'Down' });
    fixture.detectChanges();
    expect(q('disclosure-text')!.textContent).toBe('This text could not be loaded just now.');
    expect(root().querySelector('main > p')!.textContent).not.toContain('SHA-256');
  });

  it('sets its title and canonical address', () => {
    expect(TestBed.inject(Title).getTitle()).toBe('Electronic signature disclosure | ZenPDF');
    expect(document.querySelector('link[rel="canonical"]')!.getAttribute('href'))
      .toBe('https://zenpdf.up.railway.app/legal/esign-disclosure');
    http.expectOne('/api/public/sign/disclosure/').flush(BODY);
  });
});
