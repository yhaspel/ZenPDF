import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of } from 'rxjs';

import { AuthService } from '../core/services/auth.service';
import { TokenService } from '../core/services/token.service';
import { AuthFacade } from './auth.facade';

describe('AuthFacade', () => {
  const tokenStore = { access: null as string | null, refresh: null as string | null };
  const fakeTokens: Partial<TokenService> = {
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
});
