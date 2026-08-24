import {
  HttpContextToken,
  HttpErrorResponse,
  HttpEvent,
  HttpInterceptorFn,
  HttpResponse,
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, catchError, of, switchMap, tap, throwError } from 'rxjs';

import { AuthFacade } from '../../abstraction/auth.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { apiError } from '../api-error';
import { AuthService } from '../services/auth.service';
import { GuestTokenService } from '../services/guest-token.service';
import { TokenService } from '../services/token.service';

export const GUEST_HEADER = 'X-Guest-Token';

/**
 * Marks a request that has already been replayed on a fresh guest session, so
 * a server that keeps answering `guest_expired` cannot put us in a loop.
 */
export const GUEST_RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * The signing ceremony and the verification page carry **no** credential
 * (phase-08): the token in the URL is the whole capability, and attaching this
 * browser's account or guest token would tie a stranger's signing session to
 * it — and mint a guest session for somebody who only came to sign a PDF.
 */
function isCredentialFree(url: string): boolean {
  // Matched precisely, not by substring: `/verify/` alone also matches
  // `/api/users/verify/send/`, which is an *account* action — stripping its
  // credential turned "send me the confirmation link" into a 403.
  const path = url.split('?')[0];
  return (
    path.includes('/api/public/sign/')
    || path.endsWith('/api/verify/')
    // The ceremony's "Type" tab renders through this, and a stale token on it
    // navigated a *stranger* to our login page mid-signature.
    || path.endsWith('/api/signatures/render/')
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
  const sessions = inject(AuthFacade);

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

  /**
   * One attempt to put the guest back on their feet.
   *
   * Three cases, and only the last one is worth telling them about:
   * a token that was already replaced (a late verdict about a credential we no
   * longer hold — just replay), a token that really did expire (mint and
   * replay), and a replay that failed anyway (the work is genuinely gone, so
   * say so).
   */
  function recoverGuestSession(err: HttpErrorResponse): Observable<HttpEvent<unknown>> {
    if (req.context.get(GUEST_RETRIED)) {
      guests.noteSessionExpired();
      return throwError(() => err);
    }
    const outcome = guests.onSessionExpired(guestToken);
    const fresh = outcome === 'superseded' ? of(null) : guests.ensureSession();
    return fresh.pipe(
      switchMap(() => {
        const token = guestTokens.token;
        if (!token || token === guestToken) {
          guests.noteSessionExpired();
          return throwError(() => err);
        }
        return next(
          req.clone({
            setHeaders: { [GUEST_HEADER]: token },
            context: req.context.set(GUEST_RETRIED, true),
          }),
        ).pipe(
          catchError((retryErr: HttpErrorResponse) => {
            guests.noteSessionExpired();
            return throwError(() => retryErr);
          }),
        );
      }),
    );
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
      const { code, message } = apiError(err);

      // A guest session ended. Recover in place: start a fresh session and
      // replay the request once, so somebody who comes back a day later just
      // carries on instead of meeting a dead screen. Redirecting a guest to a
      // login form would reinstate exactly the wall this phase removes (§21.5).
      if (err.status === 410 && code === 'guest_expired') {
        return recoverGuestSession(err);
      }

      // An account-only feature. Surfaced as an inline upgrade prompt that
      // names what the account unlocks — never a dead end (§21.3).
      if (err.status === 403 && code === 'account_required') {
        guests.onAccountRequired(message ?? '');
        return throwError(() => err);
      }

      // The 401 → refresh → /auth/login path is for a JWT principal ONLY.
      if (err.status === 401 && !isAuthEndpoint(req.url)) {
        if (!access) {
          if (guestToken) {
            return recoverGuestSession(err);
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
            catchError((refreshErr: unknown) => {
              // Was `tokens.clear()` + a navigate, which cleared *less* than a
              // sign-out should: the `_user` signal and this tab's document
              // passwords both survived it, and L7 is the whole reason the
              // latter must not (a password kept by document id, handed to
              // whoever uses the machine next). One ending, one method.
              sessions.endSession();
              return throwError(() => refreshErr);
            }),
          );
        }
        // A dead access token with no refresh token to spend. This fell through
        // to the line below with no clear and nothing said, so every subsequent
        // request 401'd against a credential the client had no way to renew and
        // the person was never told. It is as over as the branch above.
        sessions.endSession();
      }
      return throwError(() => err);
    }),
  );
};
