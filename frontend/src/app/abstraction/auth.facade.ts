import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Observable, switchMap, tap } from 'rxjs';

import { RegisterPayload, AuthService } from '../core/services/auth.service';
import { TokenService } from '../core/services/token.service';
import { User } from '../core/models/models';

@Injectable({ providedIn: 'root' })
export class AuthFacade {
  private authSvc = inject(AuthService);
  private tokens = inject(TokenService);
  private router = inject(Router);

  private _user = signal<User | null>(null);
  readonly user = this._user.asReadonly();
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
      tap((t) => this.tokens.set(t.access, t.refresh)),
      switchMap(() => this.authSvc.me()),
      tap((u) => this._user.set(u)),
    );
  }

  register(payload: RegisterPayload): Observable<User> {
    return this.authSvc.register(payload);
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

  private clearSession(): void {
    this.tokens.clear();
    this._user.set(null);
  }
}
