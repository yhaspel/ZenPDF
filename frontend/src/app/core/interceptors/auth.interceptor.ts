import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, switchMap, throwError } from 'rxjs';

import { AuthService } from '../services/auth.service';
import { TokenService } from '../services/token.service';

function isAuthEndpoint(url: string): boolean {
  return (
    url.includes('/auth/login') ||
    url.includes('/auth/refresh') ||
    url.includes('/users/register')
  );
}

/** Attaches the JWT and runs the 401 → refresh → retry → logout flow (§7). */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const tokens = inject(TokenService);
  const auth = inject(AuthService);
  const router = inject(Router);

  const access = tokens.access;
  const authReq =
    access && !isAuthEndpoint(req.url)
      ? req.clone({ setHeaders: { Authorization: `Bearer ${access}` } })
      : req;

  return next(authReq).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status === 401 && !isAuthEndpoint(req.url) && tokens.refresh) {
        return auth.refresh(tokens.refresh).pipe(
          switchMap((res) => {
            tokens.set(res.access);
            return next(req.clone({ setHeaders: { Authorization: `Bearer ${res.access}` } }));
          }),
          catchError((refreshErr) => {
            tokens.clear();
            router.navigate(['/auth/login']);
            return throwError(() => refreshErr);
          }),
        );
      }
      return throwError(() => err);
    }),
  );
};
