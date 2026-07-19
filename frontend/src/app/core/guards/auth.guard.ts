import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { TokenService } from '../services/token.service';

export const authGuard: CanActivateFn = () => {
  const tokens = inject(TokenService);
  const router = inject(Router);
  if (tokens.isAuthenticated) {
    return true;
  }
  router.navigate(['/auth/login']);
  return false;
};
