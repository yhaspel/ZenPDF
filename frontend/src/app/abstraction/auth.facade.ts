import { HttpErrorResponse } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, map, switchMap, tap, throwError } from 'rxjs';

import { ClaimSummary, User } from '../core/models/models';
import { isAccountGated } from '../core/guards/account.guard';
import { AuthService, RegisterPayload } from '../core/services/auth.service';
import { DocumentPasswords } from '../core/services/document-passwords';
import { TokenService } from '../core/services/token.service';
import { ToastService } from '../shared/toast.service';
import { GuestFacade } from './guest.facade';

/** A sentence to read and act on, so it gets the error dwell rather than a receipt's. */
const SESSION_ENDED_MS = 9000;

@Injectable({ providedIn: 'root' })
export class AuthFacade {
  private authSvc = inject(AuthService);
  private tokens = inject(TokenService);
  private guests = inject(GuestFacade);
  private passwords = inject(DocumentPasswords);
  private router = inject(Router);
  private toasts = inject(ToastService);
  private doc = inject(DOCUMENT);

  private _user = signal<User | null>(null);
  /** What the last signup/login claimed — the payoff moment must be visible. */
  private _lastClaim = signal<ClaimSummary | null>(null);

  readonly user = this._user.asReadonly();
  readonly lastClaim = this._lastClaim.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user() || this.tokens.isAuthenticated);

  /**
   * Fetch the signed-in user, and end the session **only if the credential was
   * rejected**.
   *
   * This used to be `error: () => this.clearSession()` — any failure at all,
   * and the tokens were gone. So a 500 from an overloaded box, a 429, a
   * DNS blip, or a request aborted because the person clicked a link while it
   * was in flight all logged them out and threw the session away. There is no
   * user-visible sign-out either: the tokens vanish, and the next guarded route
   * bounces to `/auth/register` (`accountGuard`) with the reason chrome of a
   * brand-new visitor.
   *
   * Measured 2026-08-24, which is how it was finally caught: a probe that trapped
   * every write to `zen_*` recorded `TokenService.clear` under
   * `AuthFacade.clearSession` under this `error` callback, on a run where
   * `/api/documents/`, `/api/folders/`, `/api/config/` and `/api/jobs/` were all
   * answering **500**. Nothing had refused the credential — the box was simply
   * busy. Three e2e specs had been failing on it intermittently for two days
   * (~1 in 3 on a loaded machine, ~1 in 6 otherwise) and it was being read as a
   * test flake.
   *
   * **401 is the only status that means "this credential is no good".** By the
   * time one reaches here the interceptor has already tried to refresh and
   * failed, or there was no refresh token to try — either way the access token
   * is unrecoverable and the session really is over — and `endSession()` then
   * says so out loud, which it did not until 2026-08-24. Every other status
   * leaves the session alone: the tokens are still valid and the next request
   * can succeed.
   */
  loadUser(): void {
    if (this.tokens.isAuthenticated && !this._user()) {
      this.authSvc.me().subscribe({
        next: (u) => this._user.set(u),
        error: (err: unknown) => {
          if (err instanceof HttpErrorResponse && err.status === 401) {
            this.endSession();
          }
        },
      });
    }
  }

  login(email: string, password: string): Observable<User> {
    return this.authSvc.login(email, password).pipe(
      tap((t) => {
        this.tokens.set(t.access, t.refresh);
        this.onClaimed(t.claimed);
      }),
      switchMap(() => this.authSvc.me()),
      tap((u) => this._user.set(u)),
    );
  }

  register(payload: RegisterPayload): Observable<User> {
    return this.authSvc
      .register(payload)
      .pipe(tap((u) => this.onClaimed((u as User & { claimed?: ClaimSummary }).claimed)));
  }

  /**
   * Force a token refresh for a caller outside `HttpClient` (L10).
   *
   * The PDF viewer fetches the document itself, so the auth interceptor —
   * including its refresh-and-retry — never runs for it. An access token that
   * expired while the workspace was open therefore produced a 401 and a blank
   * pane, with a perfectly usable refresh token sitting in storage. Shares the
   * interceptor's single-flight refresh, because the backend rotates and
   * blacklists the refresh token and a second parallel call would fail.
   */
  refreshAccess(): Observable<void> {
    const refresh = this.tokens.refresh;
    if (!refresh) {
      return throwError(() => new Error('no refresh token'));
    }
    return this.authSvc.refreshOnce(refresh).pipe(
      tap((t) => this.tokens.set(t.access, t.refresh)),
      map(() => undefined),
    );
  }

  updateProfile(body: Partial<User>): Observable<User> {
    return this.authSvc.updateMe(body).pipe(tap((u) => this._user.set(u)));
  }

  /**
   * A session that ended without anybody asking for it.
   *
   * The involuntary twin of `logout()`, and it exists because ending one
   * silently is its own defect: `clearSession()` navigates nowhere, so the page
   * carried on rendering as though nothing had happened and the person found
   * out at the next guarded route — bounced to `/auth/register`, wearing the
   * chrome of somebody who has never had an account. They had one. Two paths
   * reached that state (a 401 on `me()`, and a 401 with no refresh token to
   * spend) and neither said a word.
   *
   * **Says so, always.** A toast, because §3 is explicit about which pattern
   * this is: *"a toast is for something that just happened and can be missed"* —
   * a notice is for a condition somebody arrives at later. Info tone, not error:
   * nothing is broken and nobody did anything wrong, and §1 keeps the colour off
   * the words either way. It is given the error dwell time regardless, because
   * this is a sentence to read and act on rather than a receipt.
   *
   * **Moves them only when it must.** Sending everybody to a login form would
   * be the login wall §10 forbids — every public route works without an account,
   * and `/app/doc/:id` renders for either principal, so a stale token is no
   * reason to interrupt a document somebody is reading. Only the routes
   * `accountGuard` actually gates have become unusable, and only those redirect
   * — to **login**, not register, carrying `next` so they land back where they
   * were.
   *
   * **Idempotent by arithmetic.** Several requests are usually in flight when a
   * credential dies and each reports its own 401; the first ends the session and
   * the rest find the tokens already gone. No stack of toasts, no second
   * navigation, no flag to keep in step.
   */
  endSession(): void {
    if (!this.tokens.isAuthenticated) return;
    // The *browser's* URL, not `Router.url`. `loadUser()` runs from the `App`
    // and `AppShell` constructors, which is during the first navigation — the
    // router has not committed the new URL yet, so `Router.url` still reads the
    // page being left. On a cold load of `/app/dashboard` that is `/`, and the
    // redirect silently never happened. `location` is already correct by then,
    // and it is also the honest answer to "where is this person".
    const loc = this.doc.location;
    const from = loc ? `${loc.pathname}${loc.search}` : '';
    this.clearSession();
    this.toasts.info('Your session ended. Please sign in again.', SESSION_ENDED_MS);
    if (isAccountGated(from)) {
      // The toast above has already said what happened; the move is a courtesy
      // on top of it, and nothing downstream branches on whether it landed.
      void this.router.navigate(['/auth/login'], { queryParams: { next: from } });
    }
  }

  logout(): void {
    const refresh = this.tokens.refresh;
    if (refresh) {
      this.authSvc.logout(refresh).subscribe({
        // Best-effort: the local session is cleared either way.
        error: () => { /* ignored */ },
      });
    }
    this.clearSession();
    // The session is already gone by here — `clearSession()` is the logout.
    // Where the browser ends up afterwards cannot un-log-them-out.
    void this.router.navigate(['/auth/login']);
  }

  clearLastClaim(): void {
    this._lastClaim.set(null);
  }

  /**
   * After a successful claim the client MUST discard its guest token (§21.5):
   * a claimed token is dead server-side, and continuing to write into a claimed
   * session means `guest_purge` deletes a logged-in user's files within 72 h —
   * the worst failure this design can produce.
   */
  private onClaimed(claimed?: ClaimSummary): void {
    this.guests.discardAfterClaim();
    if (claimed && !claimed.already_claimed) {
      this._lastClaim.set(claimed);
    }
  }

  private clearSession(): void {
    this.tokens.clear();
    this._user.set(null);
    // A token is not the only credential a session holds: the in-memory
    // document passwords are scoped to the *tab*, so without this they
    // survived a sign-out and were attached, by document id, to whatever the
    // next person did on a shared machine (L7).
    this.passwords.clearAll();
  }
}
