import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { GuestTokenService } from '../core/services/guest-token.service';
import { TokenService } from '../core/services/token.service';
import { GuestFacade } from './guest.facade';

describe('GuestFacade', () => {
  let facade: GuestFacade;
  let guestTokens: GuestTokenService;
  let tokens: TokenService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    facade = TestBed.inject(GuestFacade);
    guestTokens = TestBed.inject(GuestTokenService);
    tokens = TestBed.inject(TokenService);
  });

  afterEach(() => localStorage.clear());

  it('reports no principal before anything is minted', () => {
    expect(facade.principal()).toBeNull();
    expect(guestTokens.hasToken).toBe(false);
  });

  it('captures and persists a minted token', () => {
    facade.captureToken('raw-guest-token');
    expect(facade.principal()).toBe('guest');
    expect(guestTokens.token).toBe('raw-guest-token');
    expect(localStorage.getItem('zen_guest')).toBe('raw-guest-token');
  });

  it('prefers the account principal when a JWT is present', () => {
    facade.captureToken('raw-guest-token');
    tokens.set('jwt-access', 'jwt-refresh');
    expect(facade.principal()).toBe('user');
  });

  it('notices a JWT that arrives after the principal was first read', () => {
    // The order that broke it: something reads `principal()` on the login page,
    // before there is a token, and the computed caches `null` — because the
    // JWT was a plain getter with no signal behind it. Everything derived from
    // it then stayed logged-out for the rest of the session, which is what
    // stripped the credential off the PDF viewer's own fetch.
    expect(facade.principal()).toBeNull();
    tokens.set('jwt-access', 'jwt-refresh');
    expect(facade.principal()).toBe('user');

    tokens.clear();
    expect(facade.principal()).toBeNull();
  });

  it('clears the token when the session expires', () => {
    facade.captureToken('raw-guest-token');
    expect(facade.onSessionExpired()).toBe('cleared');
    expect(guestTokens.token).toBeNull();
    expect(facade.principal()).toBeNull();
    // No banner yet: the interceptor starts a fresh session and replays the
    // request first, and only says so if that recovery fails too (§21.5).
    expect(facade.expiredNotice()).toBe(false);
    facade.noteSessionExpired();
    // Inline notice, never a redirect to a login form (§21.5).
    expect(facade.expiredNotice()).toBe(true);
  });

  it('ignores a verdict about a token it has already replaced', () => {
    // Two requests go out on a token that expired overnight. The first 410
    // clears it and a fresh session is minted; the second 410 arrives after
    // that and used to wipe the *new* token, stranding whatever had been
    // uploaded into it behind a bare "An error occurred."
    facade.captureToken('stale-token');
    expect(facade.onSessionExpired('stale-token')).toBe('cleared');
    facade.captureToken('fresh-token');
    expect(facade.onSessionExpired('stale-token')).toBe('superseded');
    expect(guestTokens.token).toBe('fresh-token');
    expect(facade.principal()).toBe('guest');
    expect(facade.expiredNotice()).toBe(false);
  });

  it('discards the token after a claim', () => {
    // Without this the browser keeps writing into a claimed session that
    // guest_purge deletes within 72 h — losing a logged-in user's files.
    facade.captureToken('raw-guest-token');
    facade.discardAfterClaim();
    expect(guestTokens.token).toBeNull();
    expect(localStorage.getItem('zen_guest')).toBeNull();
    expect(facade.expiredNotice()).toBe(false);
  });

  it('ensureSession mints once when there is no principal', () => {
    const httpMock = TestBed.inject(HttpTestingController);
    let done = false;
    facade.ensureSession().subscribe(() => (done = true));
    httpMock
      .expectOne((r) => r.url.endsWith('/guest/session/'))
      .flush({ id: 'g1' }, { headers: { 'X-Guest-Token': 'minted' } });
    expect(done).toBe(true);
    httpMock.verify();
  });

  it('ensureSession is a no-op once a principal exists', () => {
    // Minting is per-request, so two concurrent tokenless writes would create
    // two sessions and split the files across them (§21.2). Once one exists,
    // no further round trip may happen.
    const httpMock = TestBed.inject(HttpTestingController);
    facade.captureToken('already-have-one');
    httpMock.match((r) => r.url.includes('/config/')).forEach((r) => r.flush({}));

    let done = false;
    facade.ensureSession().subscribe(() => (done = true));
    expect(done).toBe(true);
    httpMock.expectNone((r) => r.url.endsWith('/guest/session/'));
    httpMock.verify();
  });

  it('surfaces account_required as an upgrade prompt', () => {
    facade.onAccountRequired('Create a free account to organize files into folders.');
    expect(facade.accountRequired()).toContain('free account');
    facade.dismissAccountRequired();
    expect(facade.accountRequired()).toBeNull();
  });
});
