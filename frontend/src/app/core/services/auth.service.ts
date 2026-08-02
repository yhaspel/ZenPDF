import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, finalize, shareReplay } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthTokens, User } from '../models/models';

export interface RegisterPayload {
  email: string;
  password: string;
  display_name?: string;
  /** The signup checkbox. Required by the API — an account cannot exist
   *  without a recorded acceptance (§9A). */
  accept_terms: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;
  private refreshInFlight: Observable<AuthTokens> | null = null;

  register(payload: RegisterPayload): Observable<User> {
    return this.http.post<User>(`${this.base}/users/register/`, payload);
  }

  login(email: string, password: string): Observable<AuthTokens> {
    return this.http.post<AuthTokens>(`${this.base}/auth/login/`, { email, password });
  }

  /** Returns a rotated refresh token too — the backend blacklists the old one. */
  refresh(refresh: string): Observable<AuthTokens> {
    return this.http.post<AuthTokens>(`${this.base}/auth/refresh/`, { refresh });
  }

  /**
   * Single-flight refresh. Concurrent 401s must share one request: the backend
   * rotates and blacklists the refresh token, so a second parallel call fails.
   */
  refreshOnce(refresh: string): Observable<AuthTokens> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refresh(refresh).pipe(
        finalize(() => (this.refreshInFlight = null)),
        shareReplay(1),
      );
    }
    return this.refreshInFlight;
  }

  logout(refresh: string): Observable<unknown> {
    return this.http.post(`${this.base}/auth/logout/`, { refresh });
  }

  me(): Observable<User> {
    return this.http.get<User>(`${this.base}/users/me/`);
  }

  updateMe(body: Partial<User>): Observable<User> {
    return this.http.patch<User>(`${this.base}/users/me/`, body);
  }
}
