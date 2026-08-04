import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Job, Paginated } from '../models/models';

@Injectable({ providedIn: 'root' })
export class JobsService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  get(id: string): Observable<Job> {
    return this.http.get<Job>(`${this.base}/jobs/${id}/`);
  }

  list(status?: string): Observable<Paginated<Job>> {
    let hp = new HttpParams();
    if (status) hp = hp.set('status', status);
    return this.http.get<Paginated<Job>>(`${this.base}/jobs/`, { params: hp });
  }

  cancel(id: string): Observable<Job> {
    return this.http.post<Job>(`${this.base}/jobs/${id}/cancel/`, {});
  }
}
