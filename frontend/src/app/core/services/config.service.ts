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

/**
 * A rough region for the consent rule, without asking for a permission or
 * geolocating an address.
 *
 * **The IANA timezone, not the locale.** `navigator.language` is a *UI
 * preference*: `en-US` is the most common value in the world, including on
 * machines in Berlin and Paris, so reading the country out of it would tell a
 * German visitor they are American and skip the banner they are entitled to.
 * `Europe/Berlin` tracks where the machine actually is. Unknown maps to no
 * region at all, which the server treats as "ask".
 */
export function regionOfBrowser(): string {
  const zone = typeof Intl !== 'undefined'
    ? (Intl.DateTimeFormat().resolvedOptions().timeZone || '') : '';
  return ZONE_REGIONS[zone] ?? '';
}

/** IANA zone → ISO country, for the zones the consent list cares about. A
 *  visitor from anywhere else lands on the server's "ask" default, which is
 *  the safe direction to be wrong in. */
const ZONE_REGIONS: Record<string, string> = {
  'Europe/Vienna': 'AT', 'Europe/Brussels': 'BE', 'Europe/Sofia': 'BG',
  'Europe/Zagreb': 'HR', 'Asia/Nicosia': 'CY', 'Europe/Prague': 'CZ',
  'Europe/Copenhagen': 'DK', 'Europe/Tallinn': 'EE', 'Europe/Helsinki': 'FI',
  'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Busingen': 'DE',
  'Europe/Athens': 'GR', 'Europe/Budapest': 'HU', 'Europe/Dublin': 'IE',
  'Europe/Rome': 'IT', 'Europe/Riga': 'LV', 'Europe/Vilnius': 'LT',
  'Europe/Luxembourg': 'LU', 'Europe/Malta': 'MT', 'Europe/Amsterdam': 'NL',
  'Europe/Warsaw': 'PL', 'Europe/Lisbon': 'PT', 'Atlantic/Azores': 'PT',
  'Atlantic/Madeira': 'PT', 'Europe/Bucharest': 'RO', 'Europe/Bratislava': 'SK',
  'Europe/Ljubljana': 'SI', 'Europe/Madrid': 'ES', 'Africa/Ceuta': 'ES',
  'Atlantic/Canary': 'ES', 'Europe/Stockholm': 'SE', 'Europe/London': 'GB',
  'Europe/Belfast': 'GB', 'Europe/Zurich': 'CH', 'Europe/Oslo': 'NO',
  'Europe/Reykjavik': 'IS', 'Atlantic/Reykjavik': 'IS',
  'Europe/Vaduz': 'LI',
};
