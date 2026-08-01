import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TokenService {
  private readonly ACCESS = 'zen_access';
  private readonly REFRESH = 'zen_refresh';

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

  get access(): string | null {
    return this.storage?.getItem(this.ACCESS) ?? null;
  }

  get refresh(): string | null {
    return this.storage?.getItem(this.REFRESH) ?? null;
  }

  set(access: string, refresh?: string): void {
    const storage = this.storage;
    if (!storage) return;
    storage.setItem(this.ACCESS, access);
    if (refresh) {
      storage.setItem(this.REFRESH, refresh);
    }
  }

  clear(): void {
    const storage = this.storage;
    if (!storage) return;
    storage.removeItem(this.ACCESS);
    storage.removeItem(this.REFRESH);
  }

  get isAuthenticated(): boolean {
    return !!this.access;
  }
}
