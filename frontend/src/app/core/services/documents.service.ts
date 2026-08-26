import { HttpClient, HttpEvent, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  Annotation,
  DocumentModel,
  DocumentVersion,
  FormModel,
  ImageAsset,
  Job,
  OutlineItem,
  PageImage,
  PageLink,
  PageTextBlocks,
  PageWords,
  Paginated,
  SearchHit,
  SourceAsset,
} from '../models/models';
import { DocumentPasswords } from './document-passwords';

export interface DocListParams {
  q?: string;
  folder?: string | null;
  starred?: boolean;
  trashed?: boolean;
  ordering?: string;
  limit?: number;
  offset?: number;
}

@Injectable({ providedIn: 'root' })
export class DocumentsService {
  private http = inject(HttpClient);
  private passwords = inject(DocumentPasswords);
  private base = environment.apiUrl;

  list(params: DocListParams = {}): Observable<Paginated<DocumentModel>> {
    let hp = new HttpParams();
    if (params.q) hp = hp.set('q', params.q);
    if (params.folder) hp = hp.set('folder', params.folder);
    if (params.starred) hp = hp.set('starred', 'true');
    if (params.trashed) hp = hp.set('trashed', 'true');
    if (params.ordering) hp = hp.set('ordering', params.ordering);
    if (params.limit) hp = hp.set('limit', String(params.limit));
    if (params.offset) hp = hp.set('offset', String(params.offset));
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

  versions(id: string, limit = 50, offset = 0): Observable<Paginated<DocumentVersion>> {
    let hp = new HttpParams().set('limit', String(limit));
    if (offset) hp = hp.set('offset', String(offset));
    return this.http.get<Paginated<DocumentVersion>>(
      `${this.base}/documents/${id}/versions/`, { params: hp });
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

  /** Phase 3 — annotations read straight out of the PDF (no sidecar table). */
  annotations(id: string, version?: number | null, page?: number): Observable<{ version: number; annotations: Annotation[] }> {
    let hp = new HttpParams();
    if (version) hp = hp.set('version', String(version));
    if (page !== undefined) hp = hp.set('page', String(page));
    return this.http.get<{ version: number; annotations: Annotation[] }>(
      `${this.base}/documents/${id}/annotations/`,
      { params: hp },
    );
  }

  /** The overlay's text layer — word rects for turning a selection into quads. */
  textWords(id: string, page: number, version?: number | null): Observable<PageWords> {
    let hp = new HttpParams().set('page', String(page));
    if (version) hp = hp.set('version', String(version));
    return this.http.get<PageWords>(`${this.base}/documents/${id}/text-words/`, { params: hp });
  }

  /** Phase 4 — editable text blocks for one page. */
  textBlocks(id: string, page: number, version?: number | null): Observable<PageTextBlocks> {
    let hp = new HttpParams().set('page', String(page));
    if (version) hp = hp.set('version', String(version));
    return this.http.get<PageTextBlocks>(`${this.base}/documents/${id}/text-blocks/`, {
      params: hp,
    });
  }

  pageImages(id: string, page: number, version?: number | null): Observable<{ page: number; images: PageImage[] }> {
    let hp = new HttpParams().set('page', String(page));
    if (version) hp = hp.set('version', String(version));
    return this.http.get<{ page: number; images: PageImage[] }>(
      `${this.base}/documents/${id}/images/`, { params: hp },
    );
  }

  pageLinks(id: string, page: number, version?: number | null): Observable<{ page: number; links: PageLink[] }> {
    let hp = new HttpParams().set('page', String(page));
    if (version) hp = hp.set('version', String(version));
    return this.http.get<{ page: number; links: PageLink[] }>(
      `${this.base}/documents/${id}/links/`, { params: hp },
    );
  }

  /** Phase 5 — the AcroForm read model. */
  form(id: string, version?: number | null): Observable<FormModel> {
    let hp = new HttpParams();
    if (version) hp = hp.set('version', String(version));
    return this.http.get<FormModel>(`${this.base}/documents/${id}/form/`, { params: hp });
  }

  /** Current field values as a downloadable file. */
  exportForm(id: string, format: 'json' | 'csv'): Observable<Blob> {
    const hp = new HttpParams().set('format', format);
    return this.http.get(`${this.base}/documents/${id}/form/export/`, {
      params: hp,
      responseType: 'blob',
    });
  }

  /** Phase 6 — park a file for `convert_from` (office/image/html). */
  uploadSource(file: File): Observable<SourceAsset> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<SourceAsset>(`${this.base}/uploads/source/`, form);
  }

  /** The artefact a `convert_to` job produced (§15, 24 h TTL). */
  downloadExport(jobId: string): Observable<Blob> {
    return this.http.get(`${this.base}/jobs/${jobId}/download/`, { responseType: 'blob' });
  }

  /** Ephemeral image asset (§13 `uploads/…`) → an opaque, principal-scoped ref. */
  uploadImage(file: File): Observable<ImageAsset> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<ImageAsset>(`${this.base}/uploads/image/`, form);
  }

  operation(
    id: string,
    body: {
      type: string;
      params: unknown;
      base_version_seq?: number | null;
      /** The session password for an encrypted document (phase-07) — a sibling
       *  of `params`, because it belongs to the document, not to the op. */
      document_password?: string;
    },
  ): Observable<Job> {
    // Attached here rather than at each call site: an encrypted document
    // refuses *every* operation without it, so rotating a page needs it as
    // much as re-encrypting does, and one forgetful facade would put the
    // password prompt back in front of the user (phase-07).
    const password = body.document_password ?? this.passwords.passwordFor(id);
    return this.http.post<Job>(`${this.base}/documents/${id}/operations/`, {
      ...body,
      ...(password ? { document_password: password } : {}),
    });
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

  /**
   * A rendered page.
   *
   * `annots: false` asks for the page **without the file's own annotations**
   * (`?annots=false`) — the raster the annotate overlay draws on, since it
   * renders every annotation itself as an editable item. The backend has
   * offered the flag, with a test naming the overlay as its reason, since
   * Phase 3; nothing on this side ever sent it, so after every save the page
   * showed each mark twice — once baked into the raster and once as the
   * editable copy on top, and the baked one stayed put when the other was
   * dragged.
   */
  thumbnailBlob(
    id: string,
    page: number,
    w = 240,
    version?: number,
    options: { annots?: boolean } = {},
  ): Observable<Blob> {
    let hp = new HttpParams().set('w', String(w));
    if (version) hp = hp.set('version', String(version));
    if (options.annots === false) hp = hp.set('annots', 'false');
    return this.http.get(`${this.base}/documents/${id}/pages/${page}/thumbnail/`, {
      params: hp,
      responseType: 'blob',
    });
  }
}
