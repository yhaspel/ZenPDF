import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { AppConfig, Usage } from '../models/models';

@Injectable({ providedIn: 'root' })
export class ConfigService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  config(): Observable<AppConfig> {
    return this.http.get<AppConfig>(`${this.base}/config/`);
  }

  usage(): Observable<Usage> {
    return this.http.get<Usage>(`${this.base}/users/me/usage/`);
  }
}
