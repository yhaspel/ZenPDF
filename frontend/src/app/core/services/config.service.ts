import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AppConfig, GuestState, Usage } from '../models/models';

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  /** The last payload, so the ad layer and the consent banner read one source
   *  rather than each fetching their own. */
  private _snapshot = signal<AppConfig | null>(null);
  readonly snapshot = this._snapshot.asReadonly();

  readonly ads = () => this._snapshot()?.ads ?? { enabled: false };
  readonly consentRequired = () => this._snapshot()?.consent_required ?? true;

  config(): Observable<AppConfig> {
    // The browser knows its own region; sending it beats geolocating an IP,
    // and the decision itself is made server-side against one list (§9A).
    const region = regionOfBrowser();
    const query = region ? `?region=${encodeURIComponent(region)}` : '';
    return this.http.get<AppConfig>(`${this.base}/config/${query}`).pipe(
      tap((config) => this._snapshot.set(config)),
    );
  }

  usage(): Observable<Usage> {
    return this.http.get<Usage>(`${this.base}/users/me/usage/`);
  }

  /** Explicitly mint (or inspect) a guest session — `POST`, never a page view. */
  mintGuestSession(): Observable<GuestState> {
    return this.http.post<GuestState>(`${this.base}/guest/session/`, {});
  }
}

/** A rough region for the consent rule: the country half of the browser's
 *  locale, which is the only thing available without asking for a permission
 *  or geolocating an address. Unknown is treated as "ask" server-side. */
export function regionOfBrowser(): string {
  if (typeof navigator === 'undefined') return '';
  const locale = navigator.language || '';
  const parts = locale.split('-');
  return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
}
