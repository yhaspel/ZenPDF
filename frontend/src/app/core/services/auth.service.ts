import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AuthTokens, User } from '../models/models';

export interface RegisterPayload {
  email: string;
  password: string;
  display_name?: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  register(payload: RegisterPayload): Observable<User> {
    return this.http.post<User>(`${this.base}/users/register/`, payload);
  }

  login(email: string, password: string): Observable<AuthTokens> {
    return this.http.post<AuthTokens>(`${this.base}/auth/login/`, { email, password });
  }

  refresh(refresh: string): Observable<{ access: string }> {
    return this.http.post<{ access: string }>(`${this.base}/auth/refresh/`, { refresh });
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
