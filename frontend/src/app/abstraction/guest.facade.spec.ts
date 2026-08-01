import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
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

  it('clears the token and shows an inline notice when the session expires', () => {
    facade.captureToken('raw-guest-token');
    facade.onSessionExpired();
    expect(guestTokens.token).toBeNull();
    expect(facade.principal()).toBeNull();
    // Inline notice, never a redirect to a login form (§21.5).
    expect(facade.expiredNotice()).toBe(true);
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

  it('surfaces account_required as an upgrade prompt', () => {
    facade.onAccountRequired('Create a free account to organize files into folders.');
    expect(facade.accountRequired()).toContain('free account');
    facade.dismissAccountRequired();
    expect(facade.accountRequired()).toBeNull();
  });
});
