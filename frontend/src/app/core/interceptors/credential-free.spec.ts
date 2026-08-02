import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { GuestTokenService } from '../services/guest-token.service';
import { TokenService } from '../services/token.service';
import { authInterceptor } from './auth.interceptor';

/**
 * The signing ceremony and the verification page must carry **no** credential
 * (phase-08). The token in the URL is the whole capability; attaching this
 * browser's account or guest token would tie a stranger's signing session to
 * it, and would mint a guest session for somebody who only came to sign.
 */
describe('authInterceptor — credential-free routes', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    TestBed.inject(TokenService).set('an-access-token', 'a-refresh-token');
    TestBed.inject(GuestTokenService).set('a-guest-token');
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    localStorage.clear();
  });

  it('sends nothing to the ceremony', () => {
    http.get('/api/public/sign/sometoken/').subscribe();
    const req = controller.expectOne('/api/public/sign/sometoken/');
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(req.request.headers.has('X-Guest-Token')).toBe(false);
    req.flush({});
  });

  it('sends nothing to the verification endpoint', () => {
    http.post('/api/verify/', new FormData()).subscribe();
    const req = controller.expectOne('/api/verify/');
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(req.request.headers.has('X-Guest-Token')).toBe(false);
    req.flush({});
  });

  it('still sends the account token everywhere else', () => {
    http.get('/api/sign-requests/').subscribe();
    const req = controller.expectOne('/api/sign-requests/');
    expect(req.request.headers.get('Authorization')).toBe('Bearer an-access-token');
    req.flush({});
  });
});
