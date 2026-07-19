import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import { Folder } from '../models/models';

@Injectable({ providedIn: 'root' })
export class FoldersService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  list(): Observable<Folder[]> {
    return this.http.get<Folder[]>(`${this.base}/folders/`);
  }

  create(name: string, parent: string | null = null): Observable<Folder> {
    return this.http.post<Folder>(`${this.base}/folders/`, { name, parent });
  }

  remove(id: string, cascade = false): Observable<unknown> {
    const q = cascade ? '?cascade=trash' : '';
    return this.http.delete(`${this.base}/folders/${id}/${q}`);
  }
}
