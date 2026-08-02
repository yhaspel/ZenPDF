import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, switchMap, tap, throwError } from 'rxjs';

import { GuestFacade } from '../../abstraction/guest.facade';
import { AuthService } from '../services/auth.service';
import { GuestTokenService } from '../services/guest-token.service';
import { TokenService } from '../services/token.service';

export const GUEST_HEADER = 'X-Guest-Token';

/**
 * The signing ceremony and the verification page carry **no** credential
 * (phase-08): the token in the URL is the whole capability, and attaching this
 * browser's account or guest token would tie a stranger's signing session to
 * it — and mint a guest session for somebody who only came to sign a PDF.
 */
function isCredentialFree(url: string): boolean {
  return (
    url.includes('/public/sign/')
    || url.includes('/verify/')
    // The ceremony's "Type" tab renders through this, and a stale token on it
    // navigated a *stranger* to our login page mid-signature.
    || url.includes('/signatures/render/')
  );
}

function isAuthEndpoint(url: string): boolean {
  return (
    url.includes('/auth/login') ||
    url.includes('/auth/refresh') ||
    url.includes('/users/register')
  );
}

/**
 * Attaches exactly one credential and handles its failure mode (§7, §21.2).
 *
 * JWT when there is one, else `X-Guest-Token`. A freshly minted guest token
 * arrives on the response of the first write and is captured here, so no call
 * site has to remember to do it.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const tokens = inject(TokenService);
  const guestTokens = inject(GuestTokenService);
  const guests = inject(GuestFacade);
  const auth = inject(AuthService);
  const router = inject(Router);

  const access = tokens.access;
  const guestToken = guestTokens.token;

  // Auth endpoints carry the guest token *deliberately*: register and login
  // claim that session inline on success (§21.5). They never carry the JWT.
  let outgoing = req;
  if (isCredentialFree(req.url)) {
    return next(req);
  }
  if (isAuthEndpoint(req.url)) {
    if (guestToken) {
      outgoing = req.clone({ setHeaders: { [GUEST_HEADER]: guestToken } });
    }
  } else if (access) {
    outgoing = req.clone({ setHeaders: { Authorization: `Bearer ${access}` } });
  } else if (guestToken) {
    outgoing = req.clone({ setHeaders: { [GUEST_HEADER]: guestToken } });
  }

  return next(outgoing).pipe(
    tap((event) => {
      if (event instanceof HttpResponse) {
        const minted = event.headers.get(GUEST_HEADER);
        if (minted && minted !== guestToken) {
          guests.captureToken(minted);
        }
      }
    }),
    catchError((err: HttpErrorResponse) => {
      const code = err.error?.error?.code;

      // A guest session ended. Clearing the token means the next write mints a
      // fresh one; an inline notice explains it. Redirecting a guest to a login
      // form would reinstate exactly the wall this phase removes (§21.5).
      if (err.status === 410 && code === 'guest_expired') {
        guests.onSessionExpired();
        return throwError(() => err);
      }

      // An account-only feature. Surfaced as an inline upgrade prompt that
      // names what the account unlocks — never a dead end (§21.3).
      if (err.status === 403 && code === 'account_required') {
        guests.onAccountRequired(err.error?.error?.message ?? '');
        return throwError(() => err);
      }

      // The 401 → refresh → /auth/login path is for a JWT principal ONLY.
      if (err.status === 401 && !isAuthEndpoint(req.url)) {
        if (!access) {
          if (guestToken) {
            guests.onSessionExpired();
          }
          return throwError(() => err);
        }
        if (tokens.refresh) {
          return auth.refreshOnce(tokens.refresh).pipe(
            switchMap((res) => {
              // Store the rotated refresh token: the one we just used is now
              // blacklisted server-side (ROTATE_REFRESH_TOKENS + BLACKLIST).
              tokens.set(res.access, res.refresh);
              return next(
                req.clone({ setHeaders: { Authorization: `Bearer ${res.access}` } }),
              );
            }),
            catchError((refreshErr) => {
              tokens.clear();
              router.navigate(['/auth/login']);
              return throwError(() => refreshErr);
            }),
          );
        }
      }
      return throwError(() => err);
    }),
  );
};
