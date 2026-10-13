import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';

import { UnsubscribePage } from './unsubscribe-page';

/**
 * `/unsubscribe/:token` (§9B).
 *
 * One click, no login, no confirmation. The regression that matters is a
 * second step appearing: a button to press, a form to fill, a login wall. The
 * page must post the token on arrival and say the outcome — so the tests pin
 * that the request happens from the constructor alone, that there is nothing
 * on screen to press, and that each outcome renders the right sentence.
 */
describe('UnsubscribePage', () => {
  let fixture: ComponentFixture<UnsubscribePage>;
  let http: HttpTestingController;

  function render(token = 'unsub-1'): HTMLElement {
    TestBed.configureTestingModule({
      imports: [UnsubscribePage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap({ token }) } },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(UnsubscribePage);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => {
    http.verify();
    TestBed.resetTestingModule();
  });

  it('unsubscribes on arrival, with the route token and no button to press', () => {
    const el = render('unsub-xyz');
    const req = http.expectOne({ method: 'POST', url: '/api/mail/unsubscribe/' });
    expect(req.request.body).toEqual({ token: 'unsub-xyz' });
    // Nothing to confirm: a button or a form here is the "are you sure" the
    // page exists to not have.
    expect(el.querySelector('button')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    req.flush({ unsubscribed: true, email: 'a@example.com' });
  });

  it('shows the waiting state until the server answers', () => {
    const el = render();
    expect(el.textContent).toContain('One moment');
    expect(el.querySelector('[data-test="unsubscribe-done"]')).toBeNull();
    http.expectOne('/api/mail/unsubscribe/').flush({ unsubscribed: true, email: 'a@example.com' });
  });

  it('says which address was removed and that sent documents still work', () => {
    const el = render();
    http.expectOne('/api/mail/unsubscribe/').flush({ unsubscribed: true, email: 'sam@example.com' });
    fixture.detectChanges();

    expect(el.querySelector('[data-test="unsubscribe-done"]')!.textContent)
      .toContain('You will not hear from us again');
    expect(el.textContent).toContain('sam@example.com has been removed');
    expect(el.textContent).toContain('this only stops the emails');
    expect(el.textContent).not.toContain('One moment');
  });

  it('explains a bad token and offers the by-hand route instead of a retry', () => {
    const el = render('tampered');
    http.expectOne('/api/mail/unsubscribe/').flush(
      { error: { code: 'invalid_token', message: 'Bad token.' } },
      { status: 400, statusText: 'Bad Request' },
    );
    fixture.detectChanges();

    expect(el.textContent).toContain('That link did not work');
    expect(el.textContent).toContain('we will remove you by hand');
    expect(el.querySelector('[data-test="unsubscribe-done"]')).toBeNull();
  });

  it('keeps a way back to the site in every state', () => {
    const el = render();
    const home = () => el.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(home()).not.toBeNull();
    http.expectOne('/api/mail/unsubscribe/').flush(null, { status: 500, statusText: 'Error' });
    fixture.detectChanges();
    expect(home()).not.toBeNull();
  });
});
