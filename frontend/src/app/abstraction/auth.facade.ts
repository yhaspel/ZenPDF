import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, switchMap, tap } from 'rxjs';

import { ClaimSummary, User } from '../core/models/models';
import { AuthService, RegisterPayload } from '../core/services/auth.service';
import { TokenService } from '../core/services/token.service';
import { GuestFacade } from './guest.facade';

@Injectable({ providedIn: 'root' })
export class AuthFacade {
  private authSvc = inject(AuthService);
  private tokens = inject(TokenService);
  private guests = inject(GuestFacade);
  private router = inject(Router);

  private _user = signal<User | null>(null);
  /** What the last signup/login claimed — the payoff moment must be visible. */
  private _lastClaim = signal<ClaimSummary | null>(null);

  readonly user = this._user.asReadonly();
  readonly lastClaim = this._lastClaim.asReadonly();
  readonly isAuthenticated = computed(() => !!this._user() || this.tokens.isAuthenticated);

  loadUser(): void {
    if (this.tokens.isAuthenticated && !this._user()) {
      this.authSvc.me().subscribe({
        next: (u) => this._user.set(u),
        error: () => this.clearSession(),
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

  updateProfile(body: Partial<User>): Observable<User> {
    return this.authSvc.updateMe(body).pipe(tap((u) => this._user.set(u)));
  }

  logout(): void {
    const refresh = this.tokens.refresh;
    if (refresh) {
      this.authSvc.logout(refresh).subscribe({ error: () => {} });
    }
    this.clearSession();
    this.router.navigate(['/auth/login']);
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
  }
}
