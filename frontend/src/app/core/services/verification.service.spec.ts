import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { VerificationService, isEmailNotVerified } from './verification.service';

/**
 * "Send me the link again" (§9B). Reached from two screens — the settings
 * banner and the moment a signature request is refused — so its state has to
 * be right from either: one request in flight at a time, a cooldown shown as
 * the server phrases it, and `sent` only once the server said so.
 */
describe('VerificationService', () => {
  let service: VerificationService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(VerificationService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('posts to the resend endpoint and reports sent once the server agrees', () => {
    expect(service.sent()).toBe(false);
    service.resend();
    expect(service.sending()).toBe(true);

    const req = http.expectOne('/api/users/verify/send/');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({});
    req.flush({ sent: true });

    expect(service.sending()).toBe(false);
    expect(service.sent()).toBe(true);
    expect(service.failure()).toBe('');
  });

  it('sends one request at a time', () => {
    service.resend();
    service.resend();
    service.resend();
    http.expectOne('/api/users/verify/send/').flush({});
    service.resend();
    http.expectOne('/api/users/verify/send/').flush({});
  });

  it('shows a cooldown as the server phrases it, and clears it on the next try', () => {
    service.resend();
    http.expectOne('/api/users/verify/send/').flush(
      { error: { code: 'throttled', message: 'Try again in 4 minutes.' } },
      { status: 429, statusText: 'Too Many Requests' },
    );
    expect(service.sending()).toBe(false);
    expect(service.sent()).toBe(false);
    expect(service.failure()).toBe('Try again in 4 minutes.');

    service.resend();
    expect(service.failure()).toBe('');
    http.expectOne('/api/users/verify/send/').flush({});
  });

  it('falls back to its own sentence when the failure carried none', () => {
    service.resend();
    http.expectOne('/api/users/verify/send/').error(new ProgressEvent('error'), { status: 0 });
    expect(service.failure()).toBe('Could not send that just now.');
  });
});

describe('isEmailNotVerified', () => {
  it('recognises the gate by its code, not its copy', () => {
    expect(isEmailNotVerified({
      status: 403, error: { error: { code: 'email_not_verified', message: 'whatever' } },
    })).toBe(true);
    expect(isEmailNotVerified({
      status: 403, error: { error: { code: 'forbidden', message: 'Verify your email first.' } },
    })).toBe(false);
    expect(isEmailNotVerified(new Error('email_not_verified'))).toBe(false);
    expect(isEmailNotVerified(null)).toBe(false);
  });
});
