import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TokenService {
  private readonly ACCESS = 'zen_access';
  private readonly REFRESH = 'zen_refresh';

  get access(): string | null {
    return localStorage.getItem(this.ACCESS);
  }

  get refresh(): string | null {
    return localStorage.getItem(this.REFRESH);
  }

  set(access: string, refresh?: string): void {
    localStorage.setItem(this.ACCESS, access);
    if (refresh) {
      localStorage.setItem(this.REFRESH, refresh);
    }
  }

  clear(): void {
    localStorage.removeItem(this.ACCESS);
    localStorage.removeItem(this.REFRESH);
  }

  get isAuthenticated(): boolean {
    return !!this.access;
  }
}
