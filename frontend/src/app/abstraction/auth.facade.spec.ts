import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, throwError } from 'rxjs';

import { AuthService } from '../core/services/auth.service';
import { DocumentPasswords } from '../core/services/document-passwords';
import { TokenService } from '../core/services/token.service';
import { AuthFacade } from './auth.facade';

describe('AuthFacade', () => {
  const tokenStore = { access: null as string | null, refresh: null as string | null };
  const fakeTokens: Partial<TokenService> = {
    get refresh() {
      return tokenStore.refresh;
    },
    set: (a: string, r?: string) => {
      tokenStore.access = a;
      if (r) tokenStore.refresh = r;
    },
    clear: () => {
      tokenStore.access = null;
      tokenStore.refresh = null;
    },
    get isAuthenticated() {
      return !!tokenStore.access;
    },
  };
  const fakeAuth: Partial<AuthService> = {
    login: () => of({ access: 'acc', refresh: 'ref' }),
    logout: () => of({}),
    refreshOnce: () => of({ access: 'fresh-acc', refresh: 'fresh-ref' }),
    me: () => of({ id: '1', email: 'a@b.com', display_name: '', email_verified: false, accepted_tos_at: null, storage_bytes_used: 0, date_joined: '' }),
  };

  beforeEach(() => {
    tokenStore.access = null;
    tokenStore.refresh = null;
    TestBed.configureTestingModule({
      providers: [
        AuthFacade,
        { provide: AuthService, useValue: fakeAuth },
        { provide: TokenService, useValue: fakeTokens },
        { provide: Router, useValue: { navigate: () => { /* routing is not under test */ } } },
      ],
    });
  });

  it('forgets the document passwords when the session ends (L7)', () => {
    const facade = TestBed.inject(AuthFacade);
    const passwords = TestBed.inject(DocumentPasswords);
    passwords.remember('doc-1', 'hunter2');
    tokenStore.access = 'acc';
    tokenStore.refresh = 'ref';

    facade.logout();

    // A token is not the only credential a session holds: these live in a
    // tab-scoped map and were inherited by whoever signed in next.
    expect(passwords.passwordFor('doc-1')).toBe('');
    expect(passwords.unlocked()).toEqual([]);
    expect(tokenStore.access).toBeNull();
  });

  it('refreshes the access token for callers outside HttpClient (L10)', () =>
    new Promise<void>((resolve) => {
      const facade = TestBed.inject(AuthFacade);
      tokenStore.refresh = 'ref';
      facade.refreshAccess().subscribe(() => {
        expect(tokenStore.access).toBe('fresh-acc');
        expect(tokenStore.refresh).toBe('fresh-ref');
        resolve();
      });
    }));

  it('does not attempt a refresh a guest cannot make (L10)', () =>
    new Promise<void>((resolve) => {
      const facade = TestBed.inject(AuthFacade);
      tokenStore.refresh = null;
      facade.refreshAccess().subscribe({
        next: () => { throw new Error('a guest has no refresh token to spend'); },
        error: () => resolve(),
      });
    }));

  it('stores tokens and user on login', () =>
    new Promise<void>((resolve) => {
      const facade = TestBed.inject(AuthFacade);
      facade.login('a@b.com', 'pw').subscribe(() => {
        expect(tokenStore.access).toBe('acc');
        expect(facade.user()?.email).toBe('a@b.com');
        expect(facade.isAuthenticated()).toBe(true);
        resolve();
      });
    }));
  /**
   * A transient server error is not a sign-out.
   *
   * `loadUser` used to clear the session on *any* error from `/users/me/`, so a
   * 500 from a busy box — or a request aborted because the person navigated
   * away while it was in flight — silently threw the tokens away and bounced
   * the next guarded route to `/auth/register`. Measured 2026-08-24 as the
   * cause of three intermittently failing e2e specs.
   */
  const failMeWith = (status: number) => {
    tokenStore.access = 'acc';
    tokenStore.refresh = 'ref';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AuthFacade,
        {
          provide: AuthService,
          useValue: {
            ...fakeAuth,
            me: () => throwError(() => new HttpErrorResponse({ status })),
          },
        },
        { provide: TokenService, useValue: fakeTokens },
        { provide: Router, useValue: { navigate: () => { /* not under test */ } } },
      ],
    });
    TestBed.inject(AuthFacade).loadUser();
  };

  it('keeps the session when /users/me fails for a reason that is not the credential', () => {
    for (const status of [0, 429, 500, 502, 503, 504]) {
      failMeWith(status);
      expect(tokenStore.access, `status ${status} must not end the session`).toBe('acc');
    }
  });

  it('ends the session only when the credential is actually rejected', () => {
    failMeWith(401);
    expect(tokenStore.access).toBeNull();
    expect(tokenStore.refresh).toBeNull();
  });
});
