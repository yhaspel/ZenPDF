import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { GuestFacade } from '../../abstraction/guest.facade';
import { GuestTokenService } from '../services/guest-token.service';
import { TokenService } from '../services/token.service';
import { authInterceptor } from './auth.interceptor';

/** The credential branch and the guest failure mode (§21.2, §21.5). */
describe('authInterceptor — guest credential', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let tokens: TokenService;
  let guestTokens: GuestTokenService;
  let guests: GuestFacade;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    tokens = TestBed.inject(TokenService);
    guestTokens = TestBed.inject(GuestTokenService);
    guests = TestBed.inject(GuestFacade);
  });

  afterEach(() => {
    // Capturing a minted token re-reads /api/config/ so the UI knows the new
    // principal's limits; drain it before verifying.
    httpMock.match((r) => r.url.includes('/api/config/'))
      .forEach((r) => r.flush({}));
    httpMock.verify();
    localStorage.clear();
  });

  it('sends no credential when there is neither', () => {
    http.get('/api/documents/').subscribe();
    const req = httpMock.expectOne('/api/documents/');
    expect(req.request.headers.has('Authorization')).toBe(false);
    expect(req.request.headers.has('X-Guest-Token')).toBe(false);
    req.flush({ count: 0, results: [] });
  });

  it('attaches X-Guest-Token when only a guest token exists', () => {
    guestTokens.set('guest-abc');
    http.get('/api/documents/').subscribe();
    const req = httpMock.expectOne('/api/documents/');
    expect(req.request.headers.get('X-Guest-Token')).toBe('guest-abc');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({ count: 0, results: [] });
  });

  it('prefers the JWT when both credentials exist', () => {
    guestTokens.set('guest-abc');
    tokens.set('jwt-access');
    http.get('/api/documents/').subscribe();
    const req = httpMock.expectOne('/api/documents/');
    expect(req.request.headers.get('Authorization')).toBe('Bearer jwt-access');
    expect(req.request.headers.has('X-Guest-Token')).toBe(false);
    req.flush({ count: 0, results: [] });
  });

  it('captures a token minted on the first write', () => {
    http.post('/api/documents/', {}).subscribe();
    httpMock
      .expectOne('/api/documents/')
      .flush({ id: 'doc' }, { headers: { 'X-Guest-Token': 'freshly-minted' } });

    expect(guestTokens.token).toBe('freshly-minted');
    expect(guests.principal()).toBe('guest');
  });

  it('sends the guest token to register so the session is claimed inline', () => {
    guestTokens.set('guest-abc');
    tokens.set('jwt-access');
    http.post('/api/users/register/', {}).subscribe();
    const req = httpMock.expectOne('/api/users/register/');
    // Register carries the guest credential, never the JWT (§21.5).
    expect(req.request.headers.get('X-Guest-Token')).toBe('guest-abc');
    expect(req.request.headers.has('Authorization')).toBe(false);
    req.flush({ id: '1' });
  });

  it('starts a fresh session on guest_expired and replays the request', () => {
    // The returning visitor: yesterday's token, today's first click. Nothing
    // about that is worth a banner — it just has to work.
    guestTokens.set('stale-token');
    let body: unknown = null;
    http.get('/api/documents/').subscribe({ next: (r) => (body = r) });
    httpMock.expectOne('/api/documents/').flush(
      { error: { code: 'guest_expired', message: 'gone', details: {} } },
      { status: 410, statusText: 'Gone' },
    );

    httpMock
      .expectOne('/api/guest/session/')
      .flush({ id: 'g1' }, { headers: { 'X-Guest-Token': 'fresh-token' } });

    const replay = httpMock.expectOne('/api/documents/');
    expect(replay.request.headers.get('X-Guest-Token')).toBe('fresh-token');
    replay.flush({ count: 0, results: [] });

    expect(body).toEqual({ count: 0, results: [] });
    expect(guestTokens.token).toBe('fresh-token');
    // No banner: nothing was lost that the visitor had in front of them.
    expect(guests.expiredNotice()).toBe(false);
    // No refresh call: that path belongs to a JWT principal alone.
    httpMock.expectNone('/api/auth/refresh/');
  });

  it('replays on the current token when the dead one was already replaced', () => {
    // Two requests went out on the stale token; the second verdict lands after
    // a fresh session already exists. Acting on it wiped the new token and
    // stranded the document that had just been uploaded into it.
    guestTokens.set('stale-token');
    http.get('/api/documents/').subscribe({ error: () => undefined });
    const first = httpMock.expectOne('/api/documents/');
    guestTokens.set('fresh-token');
    first.flush(
      { error: { code: 'guest_expired', message: 'gone', details: {} } },
      { status: 410, statusText: 'Gone' },
    );

    httpMock.expectNone('/api/guest/session/');
    const replay = httpMock.expectOne('/api/documents/');
    expect(replay.request.headers.get('X-Guest-Token')).toBe('fresh-token');
    replay.flush({ count: 0, results: [] });

    expect(guestTokens.token).toBe('fresh-token');
    expect(guests.expiredNotice()).toBe(false);
  });

  it('says the session ended when the replay fails too, and stops there', () => {
    guestTokens.set('stale-token');
    http.get('/api/documents/doc-1/').subscribe({ error: () => undefined });
    httpMock.expectOne('/api/documents/doc-1/').flush(
      { error: { code: 'guest_expired', message: 'gone', details: {} } },
      { status: 410, statusText: 'Gone' },
    );
    httpMock
      .expectOne('/api/guest/session/')
      .flush({ id: 'g1' }, { headers: { 'X-Guest-Token': 'fresh-token' } });
    // The document belonged to the session that died — it is not coming back.
    httpMock.expectOne('/api/documents/doc-1/').flush(
      { error: { code: 'guest_expired', message: 'gone', details: {} } },
      { status: 410, statusText: 'Gone' },
    );

    // One replay, never a loop.
    httpMock.expectNone('/api/documents/doc-1/');
    expect(guests.expiredNotice()).toBe(true);
  });

  it('does not redirect a guest to the login form on 401', () => {
    guestTokens.set('guest-abc');
    http.get('/api/documents/').subscribe({ error: () => { /* the assertion is below */ } });
    httpMock
      .expectOne('/api/documents/')
      .flush(null, { status: 401, statusText: 'Unauthorized' });

    // A guest 401 means "your session ended" — never the login wall (§21.5).
    httpMock.expectNone('/api/auth/refresh/');
    httpMock
      .expectOne('/api/guest/session/')
      .flush({ id: 'g1' }, { headers: { 'X-Guest-Token': 'fresh-token' } });
    httpMock.expectOne('/api/documents/').flush({ count: 0, results: [] });
    expect(guests.expiredNotice()).toBe(false);
  });

  it('surfaces account_required as an upgrade prompt', () => {
    guestTokens.set('guest-abc');
    http.get('/api/folders/').subscribe({ error: () => { /* the assertion is below */ } });
    httpMock.expectOne('/api/folders/').flush(
      {
        error: {
          code: 'account_required',
          message: 'Create a free account to organize files into folders.',
          details: {},
        },
      },
      { status: 403, statusText: 'Forbidden' },
    );

    expect(guests.accountRequired()).toContain('free account');
    // The guest token survives: this is an upgrade prompt, not an expiry.
    expect(guestTokens.token).toBe('guest-abc');
  });
});
