import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { TokenService } from '../services/token.service';

/**
 * Account-only routes (01-architecture.md §7, §21.3).
 *
 * There is no app-wide auth guard any more: `/app/doc/:id` must render for
 * either principal. Only `/app/dashboard`, `/app/sign*` and `/app/settings`
 * are gated, and a rejection routes to **register** with a reason the page
 * renders as human copy — never a bare login wall.
 */
/**
 * The paths this guard is applied to, as prefixes of a router URL.
 *
 * A second reader needs this: when a session ends *while somebody is using the
 * app*, `AuthFacade.endSession()` has to know whether the page they are on has
 * just become unusable (send them to log in again) or still works without an
 * account (leave them where they are). `/app/doc/:id` is deliberately absent —
 * it renders for either principal, which is the whole reason there is no
 * app-wide guard.
 *
 * `account.guard.spec.ts` parses `app.routes.ts` and fails if this list and the
 * `canActivate: [accountGuard]` routes ever disagree, so it cannot drift.
 */
export const ACCOUNT_GATED_PREFIXES = ['/app/dashboard', '/app/settings', '/app/sign'];

/** Is `url` on a route only an account holder can use? */
export function isAccountGated(url: string): boolean {
  const path = url.split('?')[0].split('#')[0];
  return ACCOUNT_GATED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export const accountGuard: CanActivateFn = (route, state) => {
  const tokens = inject(TokenService);
  const router = inject(Router);
  if (tokens.isAuthenticated) {
    return true;
  }
  const reason = (route.data?.['accountReason'] as string) ?? 'account';
  router.navigate(['/auth/register'], {
    queryParams: { next: state.url, reason },
  });
  return false;
};
