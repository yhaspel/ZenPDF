import { Injectable } from '@angular/core';

/**
 * The guest credential (01-architecture.md §21.2).
 *
 * A header in localStorage, not a cookie: it matches the existing JWT pattern,
 * keeps the API stateless and CSRF-free, and avoids a cookie-consent prompt on
 * a page whose entire job is converting a first-time visitor in seconds.
 * Accepted tradeoff: clearing site data loses in-flight guest documents — they
 * are ephemeral by design.
 *
 * SSR-safe: the tool pages are server-rendered and `localStorage` does not
 * exist there, so every access is guarded rather than assumed.
 */
@Injectable({ providedIn: 'root' })
export class GuestTokenService {
  private readonly KEY = 'zen_guest';
  private memory: string | null = null;

  private get storage(): Storage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

  get token(): string | null {
    return this.storage?.getItem(this.KEY) ?? this.memory;
  }

  set(token: string): void {
    this.memory = token;
    this.storage?.setItem(this.KEY, token);
  }

  /** Called after a claim and on `guest_expired` — a dead token must not linger. */
  clear(): void {
    this.memory = null;
    this.storage?.removeItem(this.KEY);
  }

  get hasToken(): boolean {
    return !!this.token;
  }
}
