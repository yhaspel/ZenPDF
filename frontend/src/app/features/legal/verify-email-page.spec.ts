import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { VerifyEmailPage } from './verify-email-page';

/**
 * `/verify-email/:token` (§9B).
 *
 * The page has exactly one job: hand the token from the address to the API
 * and say what came back. Two things are easy to break without noticing —
 * posting something other than the route's token (the link in the mail would
 * then verify nothing, silently), and rendering the success copy before the
 * server has agreed. Both are asserted here against the real `HttpClient`
 * with a testing backend, so the request shape is the one the server sees.
 */
describe('VerifyEmailPage', () => {
  let fixture: ComponentFixture<VerifyEmailPage>;
  let http: HttpTestingController;

  function render(token: string | null): HTMLElement {
    TestBed.configureTestingModule({
      imports: [VerifyEmailPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap(token === null ? {} : { token }) } },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(VerifyEmailPage);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('posts the token from the route, and nothing else, to the verify endpoint', () => {
    render('tok-123');
    const req = http.expectOne({ method: 'POST', url: '/api/users/verify/' });
    expect(req.request.body).toEqual({ token: 'tok-123' });
    req.flush({ verified: true, email: 'a@example.com' });
  });

  it('shows the waiting state until the server answers', () => {
    const el = render('tok-123');
    expect(el.textContent).toContain('One moment');
    expect(el.querySelector('[data-test="verified"]')).toBeNull();
    expect(el.querySelector('[data-test="verify-failed"]')).toBeNull();
    http.expectOne('/api/users/verify/').flush({ verified: true, email: 'a@example.com' });
  });

  it('confirms the address, names it, and points back at the documents', () => {
    const el = render('tok-123');
    http.expectOne('/api/users/verify/').flush({ verified: true, email: 'sam@example.com' });
    fixture.detectChanges();

    expect(el.querySelector('[data-test="verified"]')!.textContent).toContain('Address confirmed');
    expect(el.textContent).toContain('sam@example.com is verified');
    expect(el.querySelector('[data-test="verify-failed"]')).toBeNull();
    const back = el.querySelector<HTMLAnchorElement>('a[href="/app/dashboard"]');
    expect(back).not.toBeNull();
  });

  it('calls an expired or tampered token expired, with the way to a fresh one', () => {
    const el = render('stale');
    http.expectOne('/api/users/verify/').flush(
      { error: { code: 'invalid_token', message: 'That link has expired.' } },
      { status: 400, statusText: 'Bad Request' },
    );
    fixture.detectChanges();

    const failed = el.querySelector('[data-test="verify-failed"]')!;
    expect(failed.textContent).toContain('That link has expired');
    expect(el.textContent).toContain('ask for a new one from your settings');
    expect(el.querySelector('[data-test="verified"]')).toBeNull();
  });

  it('treats a server failure the same way rather than hanging on the spinner', () => {
    const el = render('tok-123');
    http.expectOne('/api/users/verify/').flush(null, { status: 503, statusText: 'Unavailable' });
    fixture.detectChanges();
    expect(el.querySelector('[data-test="verify-failed"]')).not.toBeNull();
    expect(el.textContent).not.toContain('One moment');
  });

  it('still asks the server when the address carried no token at all', () => {
    // A missing token is the server's refusal to give, not a page that hangs:
    // the empty string goes up and comes back as the expired state.
    render(null);
    const req = http.expectOne('/api/users/verify/');
    expect(req.request.body).toEqual({ token: '' });
    req.flush(null, { status: 400, statusText: 'Bad Request' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test="verify-failed"]')).not.toBeNull();
  });

  it('carries no ad slot — /verify-email is not an advertising surface', () => {
    const el = render('tok-123');
    expect(el.querySelector('app-ad-slot')).toBeNull();
    http.expectOne('/api/users/verify/').flush({ verified: true, email: 'a@example.com' });
  });
});
