import { Injectable, signal } from '@angular/core';

import { inBrowser, usableLocalStorage } from '../browser-storage';

@Injectable({ providedIn: 'root' })
export class TokenService {
  private readonly isBrowser = inBrowser();
  private readonly ACCESS = 'zen_access';
  private readonly REFRESH = 'zen_refresh';

  /**
   * The tokens as **signals**, not just localStorage reads.
   *
   * Anything derived from "is somebody logged in" is a `computed`, and a
   * computed over a plain getter never recomputes: it caches whatever the
   * getter said the first time it ran. That is what silently stripped the
   * credential off the viewer's own fetch — `GuestFacade.principal()` had been
   * evaluated on the login page, before there was a token, and stayed `null`
   * for the rest of the session.
   *
   * The `storage` event is what keeps that from costing us the other half.
   * Reading localStorage per call meant a token written by *another tab* was
   * picked up on this tab's next request; a signal written only locally would
   * turn every tab into a private session — one tab logging in, logging out or
   * rotating its token would be invisible to the next, which ends in a tab
   * uploading into a guest session that expires in 24 h.
   */
  private readonly _access = signal<string | null>(null);
  private readonly _refresh = signal<string | null>(null);

  /**
   * SSR-safe accessor: the landing and tool pages are prerendered in Node,
   * where there is no usable `localStorage` — see `core/browser-storage.ts` for
   * why "no usable one" is not the same question as "no global called that".
   */
  private get storage(): Storage | null {
    return usableLocalStorage(this.isBrowser);
  }

  constructor() {
    this.readStorage();
    if (typeof window !== 'undefined') {
      // Fires in the *other* tabs only, which is exactly the case this covers.
      // `key === null` is a `localStorage.clear()` somewhere else.
      window.addEventListener('storage', (event: StorageEvent) => {
        if (event.key === null || event.key === this.ACCESS || event.key === this.REFRESH) {
          this.readStorage();
        }
      });
    }
  }

  private readStorage(): void {
    const storage = this.storage;
    this._access.set(storage?.getItem(this.ACCESS) ?? null);
    this._refresh.set(storage?.getItem(this.REFRESH) ?? null);
  }

  get access(): string | null {
    return this._access();
  }

  get refresh(): string | null {
    return this._refresh();
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
    if (refresh) this._refresh.set(refresh);
  }

  clear(): void {
    const storage = this.storage;
    if (storage) {
      storage.removeItem(this.ACCESS);
      storage.removeItem(this.REFRESH);
    }
    this._access.set(null);
    this._refresh.set(null);
  }

  get isAuthenticated(): boolean {
    return !!this.access;
  }
}
