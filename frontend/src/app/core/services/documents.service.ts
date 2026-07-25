import { HttpClient, HttpEvent, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  DocumentModel,
  DocumentVersion,
  Job,
  OutlineItem,
  Paginated,
  SearchHit,
} from '../models/models';

export interface DocListParams {
  q?: string;
  folder?: string | null;
  starred?: boolean;
  trashed?: boolean;
  ordering?: string;
}

@Injectable({ providedIn: 'root' })
export class DocumentsService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  list(params: DocListParams = {}): Observable<Paginated<DocumentModel>> {
    let hp = new HttpParams();
    if (params.q) hp = hp.set('q', params.q);
    if (params.folder) hp = hp.set('folder', params.folder);
    if (params.starred) hp = hp.set('starred', 'true');
    if (params.trashed) hp = hp.set('trashed', 'true');
    if (params.ordering) hp = hp.set('ordering', params.ordering);
    return this.http.get<Paginated<DocumentModel>>(`${this.base}/documents/`, { params: hp });
  }

  get(id: string): Observable<DocumentModel> {
    return this.http.get<DocumentModel>(`${this.base}/documents/${id}/`);
  }

  patch(id: string, body: Partial<DocumentModel>): Observable<DocumentModel> {
    return this.http.patch<DocumentModel>(`${this.base}/documents/${id}/`, body);
  }

  trash(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/documents/${id}/`);
  }

  restore(id: string): Observable<DocumentModel> {
    return this.http.post<DocumentModel>(`${this.base}/documents/${id}/restore/`, {});
  }

  purge(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/documents/${id}/?permanent=true`);
  }

  upload(file: File, folder?: string | null, repair = false): Observable<HttpEvent<DocumentModel>> {
    const form = new FormData();
    form.append('file', file);
    if (folder) form.append('folder', folder);
    const url = `${this.base}/documents/${repair ? '?repair=true' : ''}`;
    return this.http.post<DocumentModel>(url, form, {
      reportProgress: true,
      observe: 'events',
    });
  }

  versions(id: string): Observable<DocumentVersion[]> {
    return this.http.get<DocumentVersion[]>(`${this.base}/documents/${id}/versions/`);
  }

  revert(id: string, seq: number): Observable<Job> {
    return this.http.post<Job>(`${this.base}/documents/${id}/versions/${seq}/revert/`, {});
  }

  outline(id: string): Observable<{ outline: OutlineItem[] }> {
    return this.http.get<{ outline: OutlineItem[] }>(`${this.base}/documents/${id}/outline/`);
  }

  search(id: string, q: string): Observable<{ query: string; hits: SearchHit[] }> {
    const hp = new HttpParams().set('q', q);
    return this.http.get<{ query: string; hits: SearchHit[] }>(
      `${this.base}/documents/${id}/text-search/`,
      { params: hp },
    );
  }

  operation(id: string, body: { type: string; params: unknown; base_version_seq?: number | null }): Observable<Job> {
    return this.http.post<Job>(`${this.base}/documents/${id}/operations/`, body);
  }

  crossOperation(body: { type: string; params: unknown }): Observable<Job> {
    return this.http.post<Job>(`${this.base}/operations/`, body);
  }

  contentUrl(id: string, version?: number): string {
    const q = version ? `?version=${version}` : '';
    return `${this.base}/documents/${id}/content/${q}`;
  }

  /** Fetched through HttpClient so the interceptor can attach the JWT. */
  download(id: string): Observable<Blob> {
    return this.http.get(`${this.base}/documents/${id}/download/`, { responseType: 'blob' });
  }

  thumbnailBlob(id: string, page: number, w = 240, version?: number): Observable<Blob> {
    let hp = new HttpParams().set('w', String(w));
    if (version) hp = hp.set('version', String(version));
    return this.http.get(`${this.base}/documents/${id}/pages/${page}/thumbnail/`, {
      params: hp,
      responseType: 'blob',
    });
  }
}
