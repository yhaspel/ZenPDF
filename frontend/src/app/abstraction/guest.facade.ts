import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, finalize, of, shareReplay, tap } from 'rxjs';

import { AppConfig, GuestState, TierLimits } from '../core/models/models';
import { ConfigService } from '../core/services/config.service';
import { GuestTokenService } from '../core/services/guest-token.service';
import { TokenService } from '../core/services/token.service';

export type Principal = 'guest' | 'user' | null;

/**
 * Guest session state for the UI (01-architecture.md §21.2, §21.4).
 *
 * Holds the token, exposes which principal is active, when the session ends and
 * what this principal is allowed to do — so the client can pre-empt a rejection
 * instead of discovering it at 429.
 */
@Injectable({ providedIn: 'root' })
export class GuestFacade {
  private guestTokens = inject(GuestTokenService);
  private jwt = inject(TokenService);
  private configSvc = inject(ConfigService);

  private _guest = signal<GuestState | null>(null);
  private _limits = signal<TierLimits | null>(null);
  private _hasToken = signal<boolean>(this.guestTokens.hasToken);
  /** Set when a guest session ends mid-use — rendered inline, never as a redirect. */
  private _expiredNotice = signal(false);
  /** The message from the last `account_required`, rendered as an upgrade prompt. */
  private _accountRequired = signal<string | null>(null);
  /** The mint in flight, shared by every caller that asked while it was open. */
  private minting: Observable<unknown> | null = null;

  readonly guest = this._guest.asReadonly();
  readonly limits = this._limits.asReadonly();
  readonly expiredNotice = this._expiredNotice.asReadonly();
  readonly accountRequired = this._accountRequired.asReadonly();

  readonly principal = computed<Principal>(() => {
    if (this.jwt.isAuthenticated) return 'user';
    return this._hasToken() ? 'guest' : null;
  });

  readonly expiresAt = computed(() => this._guest()?.expires_at ?? null);
  readonly secondsRemaining = computed(() => this._guest()?.seconds_remaining ?? null);

  /** Calm, not alarming — guests must never lose work silently (§21.4). */
  readonly timeRemainingLabel = computed(() => {
    const seconds = this.secondsRemaining();
    if (seconds === null) return '';
    const hours = Math.floor(seconds / 3600);
    if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'} left`;
    const minutes = Math.max(1, Math.floor(seconds / 60));
    return `${minutes} minute${minutes === 1 ? '' : 's'} left`;
  });

  /**
   * Guarantee a principal exists before firing writes **in parallel** (§21.2).
   *
   * Lazy minting is per-request: two concurrent tokenless writes each mint
   * their own session, so the files land in different sessions and a
   * cross-document op like merge can then see only one of them. Serialising the
   * mint once, up front, is what `POST /api/guest/session/` is for.
   */
  ensureSession(): Observable<unknown> {
    if (this.principal() !== null) {
      return of(null);
    }
    // One mint, however many callers. Serialising *inside* the facade is what
    // makes the guarantee hold when the callers are not a single tool page but
    // a handful of requests that all came back `guest_expired` at once: each
    // one used to mint its own session, and the last capture won — stranding
    // whatever the earlier ones had already written.
    if (this.minting) {
      return this.minting;
    }
    this.minting = this.configSvc.mintGuestSession().pipe(
      tap(() => this._hasToken.set(this.guestTokens.hasToken)),
      catchError(() => of(null)),
      finalize(() => { this.minting = null; }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    return this.minting;
  }

  loadConfig(): void {
    this.configSvc.config().subscribe({
      next: (config: AppConfig) => {
        this._limits.set(config.limits);
        this._guest.set(config.guest?.id ? config.guest : null);
      },
      error: () => { /* config is optional; the app runs on defaults */ },
    });
  }

  /** The interceptor calls this when a write returns a freshly minted token. */
  captureToken(token: string): void {
    this.guestTokens.set(token);
    this._hasToken.set(true);
    this._expiredNotice.set(false);
    this.loadConfig();
  }

  /**
   * A guest 401/410 means "your session ended", not "log in" (§21.5).
   *
   * `deadToken` is the credential the failing request actually carried. It
   * matters because responses do not arrive in the order they were sent: two
   * `/api/config/` calls made with a token that had expired overnight would
   * both come back 410 — and the second one, landing *after* the tool page had
   * already minted a fresh session and uploaded a file into it, wiped the new
   * token. The visitor was then holding a document nothing could open, on a
   * screen that said only "An error occurred." Ignoring a verdict about a
   * credential we no longer hold is what stops that.
   *
   * Returns `'superseded'` when the dead token has already been replaced —
   * the caller can simply retry — and `'cleared'` when this call really did
   * end the current session.
   */
  onSessionExpired(deadToken?: string | null): 'superseded' | 'cleared' {
    if (deadToken && this.guestTokens.token !== deadToken) {
      return 'superseded';
    }
    this.guestTokens.clear();
    this._hasToken.set(false);
    this._guest.set(null);
    return 'cleared';
  }

  /**
   * Say the session ended, once the recovery has been tried and failed.
   *
   * Separated from `onSessionExpired` so that the ordinary case — somebody
   * comes back the next morning, their token is a day old, the next thing they
   * do quietly starts a new session — shows no banner at all. The notice is for
   * the case that actually lost something: work that was open when the session
   * died and cannot be fetched again.
   */
  noteSessionExpired(): void {
    this._expiredNotice.set(true);
  }

  dismissExpiredNotice(): void {
    this._expiredNotice.set(false);
  }

  /**
   * A guest hit an account-only feature. The UI turns this into a signup prompt
   * that says what the account unlocks — never a dead end (§21.3).
   */
  onAccountRequired(message: string): void {
    this._accountRequired.set(message || 'Create a free account to use this feature.');
  }

  dismissAccountRequired(): void {
    this._accountRequired.set(null);
  }

  /**
   * After a successful claim the client MUST discard its guest token (§21.5).
   * Without this the browser keeps writing into a claimed session that
   * `guest_purge` deletes within 72 h — losing a logged-in user's files, the
   * worst failure this design can produce.
   */
  discardAfterClaim(): void {
    this.guestTokens.clear();
    this._hasToken.set(false);
    this._guest.set(null);
    this._expiredNotice.set(false);
  }

  refresh(): void {
    this._hasToken.set(this.guestTokens.hasToken);
    this.loadConfig();
  }
}
