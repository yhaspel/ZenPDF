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
