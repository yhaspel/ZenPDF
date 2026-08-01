import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  provideRouter,
} from '@angular/router';

import { TokenService } from '../services/token.service';
import { accountGuard } from './account.guard';

describe('accountGuard', () => {
  let navigated: { commands: unknown[]; extras?: { queryParams?: Record<string, string> } } | null;

  function run(url: string, data: Record<string, unknown> = {}) {
    const route = { data } as unknown as ActivatedRouteSnapshot;
    const state = { url } as RouterStateSnapshot;
    return TestBed.runInInjectionContext(() => accountGuard(route, state));
  }

  beforeEach(() => {
    localStorage.clear();
    navigated = null;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: Router,
          useValue: {
            navigate: (commands: unknown[], extras?: { queryParams?: Record<string, string> }) => {
              navigated = { commands, extras };
              return Promise.resolve(true);
            },
          },
        },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  it('allows an authenticated account through', () => {
    TestBed.inject(TokenService).set('jwt-access');
    expect(run('/app/dashboard')).toBe(true);
    expect(navigated).toBeNull();
  });

  it('redirects a guest away from /app/dashboard, stating why', () => {
    expect(run('/app/dashboard', { accountReason: 'library' })).toBe(false);
    // Register, not login: a rejection is an upgrade prompt, never a bare wall.
    expect(navigated!.commands).toEqual(['/auth/register']);
    expect(navigated!.extras!.queryParams).toEqual({
      next: '/app/dashboard',
      reason: 'library',
    });
  });

  it('redirects a guest away from /app/settings', () => {
    expect(run('/app/settings', { accountReason: 'settings' })).toBe(false);
    expect(navigated!.extras!.queryParams!['reason']).toBe('settings');
  });

  it('falls back to a generic reason when none is declared', () => {
    expect(run('/app/whatever')).toBe(false);
    expect(navigated!.extras!.queryParams!['reason']).toBe('account');
  });
});
