import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  provideRouter,
} from '@angular/router';

import { TokenService } from '../services/token.service';
import { ACCOUNT_GATED_PREFIXES, accountGuard, isAccountGated } from './account.guard';

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

  /**
   * `ACCOUNT_GATED_PREFIXES` is read by `AuthFacade.endSession()` to decide
   * whether a session ending has made the current page unusable. A second
   * reader of a list that lives somewhere else is exactly how a list goes
   * stale, so this parses the routes file and refuses to let them disagree.
   */
  it('the gated-prefix list still matches the routes accountGuard is applied to', () => {
    const routes = readFileSync(
      join(__dirname, '..', '..', 'app.routes.ts'),
      'utf8',
    );
    // Every `path: 'x'` that has a `canActivate: [accountGuard]` after it and
    // before the next `path:`.
    const guarded = [...routes.matchAll(/path:\s*'([^']*)'([\s\S]*?)(?=path:\s*'|$)/g)]
      .filter(([, , body]) => body.includes('accountGuard'))
      .map(([, p]) => `/app/${p}`.replace(/\/:[^/]+/g, ''));

    expect(guarded.length, 'no accountGuard routes found — the parser broke').toBeGreaterThan(0);
    for (const path of guarded) {
      expect(isAccountGated(path), `${path} is guarded but not in the list`).toBe(true);
    }
    // And nothing in the list is dead: each prefix must own a real guarded route.
    for (const prefix of ACCOUNT_GATED_PREFIXES) {
      expect(
        guarded.some((g) => g === prefix || g.startsWith(`${prefix}/`)),
        `${prefix} is in the list but guards nothing`,
      ).toBe(true);
    }
  });

  it('leaves the routes that render for either principal alone', () => {
    // `/app/doc/:id` has no guard by design — a signed-out person can still be
    // reading a document there, so a dead token is no reason to move them.
    expect(isAccountGated('/app/doc/abc-123')).toBe(false);
    expect(isAccountGated('/merge-pdf')).toBe(false);
    expect(isAccountGated('/verify-email/tok')).toBe(false);
    expect(isAccountGated('/')).toBe(false);
    // Query and fragment must not change the answer.
    expect(isAccountGated('/app/dashboard?folder=1#x')).toBe(true);
    // A prefix must be a path segment, not a string prefix.
    expect(isAccountGated('/app/settings-export')).toBe(false);
  });
});
