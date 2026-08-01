import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TokenService {
  private readonly ACCESS = 'zen_access';
  private readonly REFRESH = 'zen_refresh';

  /**
   * The access token as a **signal**, not just a localStorage read.
   *
   * Anything derived from "is somebody logged in" is a `computed`, and a
   * computed over a plain getter never recomputes: it caches whatever the
   * getter said the first time it ran. That is what silently stripped the
   * credential off the viewer's own fetch — `GuestFacade.principal()` had been
   * evaluated on the login page, before there was a token, and stayed `null`
   * for the rest of the session.
   */
  private readonly _access = signal<string | null>(null);

  /**
   * SSR-safe accessor: the landing and tool pages are prerendered in Node,
   * where `localStorage` does not exist. Reading it unguarded throws during
   * prerendering and takes the whole page down.
   */
  private get storage(): Storage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

  constructor() {
    this._access.set(this.storage?.getItem(this.ACCESS) ?? null);
  }

  get access(): string | null {
    return this._access();
  }

  get refresh(): string | null {
    return this.storage?.getItem(this.REFRESH) ?? null;
  }

  set(access: string, refresh?: string): void {
    const storage = this.storage;
    if (storage) {
      storage.setItem(this.ACCESS, access);
      if (refresh) {
        storage.setItem(this.REFRESH, refresh);
      }
    }
    this._access.set(access);
  }

  clear(): void {
    const storage = this.storage;
    if (storage) {
      storage.removeItem(this.ACCESS);
      storage.removeItem(this.REFRESH);
    }
    this._access.set(null);
  }

  get isAuthenticated(): boolean {
    return !!this.access;
  }
}
