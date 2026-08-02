import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  AuditEventModel,
  CeremonyMeta,
  SavedSignature,
  SignRequestModel,
  VerifyReport,
} from '../models/models';

/**
 * The e-signature HTTP surface (phase-08).
 *
 * Split the way the API is: `/signatures/` and `/sign-requests/` carry the
 * account's JWT through the interceptor, and everything under `public/sign/`
 * carries **nothing** — the token in the URL is the whole credential, and
 * attaching a stray Authorization header to a stranger's ceremony would be a
 * way to leak one session into another.
 */
@Injectable({ providedIn: 'root' })
export class EsignService {
  private http = inject(HttpClient);
  private base = environment.apiUrl;

  // ---- signatures ---------------------------------------------------- //
  listSignatures(): Observable<SavedSignature[]> {
    return this.http.get<SavedSignature[]>(`${this.base}/signatures/`);
  }

  createSignature(body: {
    method: string; kind?: string; image?: string; text?: string;
    font?: string; is_default?: boolean;
  }): Observable<SavedSignature> {
    return this.http.post<SavedSignature>(`${this.base}/signatures/`, body);
  }

  deleteSignature(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/signatures/${id}/`);
  }

  signatureImageUrl(id: string): string {
    return `${this.base}/signatures/${id}/image/`;
  }

  /** Server-side preview of a typed signature — public, stores nothing. */
  renderTyped(text: string, font: string): Observable<Blob> {
    return this.http.post(`${this.base}/signatures/render/`, { text, font },
                          { responseType: 'blob' });
  }

  // ---- requests (owner) ---------------------------------------------- //
  listRequests(): Observable<{ results: SignRequestModel[] }> {
    return this.http.get<{ results: SignRequestModel[] }>(
      `${this.base}/sign-requests/`);
  }

  createRequest(body: {
    document: string; title?: string; message?: string;
    expires_in_days?: number; reminder_every_days?: number;
  }): Observable<SignRequestModel> {
    return this.http.post<SignRequestModel>(`${this.base}/sign-requests/`, body);
  }

  getRequest(id: string): Observable<SignRequestModel> {
    return this.http.get<SignRequestModel>(`${this.base}/sign-requests/${id}/`);
  }

  patchRequest(id: string, body: Record<string, unknown>): Observable<SignRequestModel> {
    return this.http.patch<SignRequestModel>(`${this.base}/sign-requests/${id}/`,
                                             body);
  }

  sendRequest(id: string): Observable<SignRequestModel> {
    return this.http.post<SignRequestModel>(
      `${this.base}/sign-requests/${id}/send/`, {});
  }

  cancelRequest(id: string): Observable<SignRequestModel> {
    return this.http.post<SignRequestModel>(
      `${this.base}/sign-requests/${id}/cancel/`, {});
  }

  remind(id: string): Observable<{ reminded: string[]; skipped: string[] }> {
    return this.http.post<{ reminded: string[]; skipped: string[] }>(
      `${this.base}/sign-requests/${id}/remind/`, {});
  }

  audit(id: string): Observable<{
    events: AuditEventModel[];
    chain: { intact: boolean; count: number; head?: string };
  }> {
    return this.http.get<{
      events: AuditEventModel[];
      chain: { intact: boolean; count: number; head?: string };
    }>(`${this.base}/sign-requests/${id}/audit/`);
  }

  downloadUrl(id: string, what: 'final' | 'certificate'): string {
    return `${this.base}/sign-requests/${id}/download/${what}/`;
  }

  download(id: string, what: 'final' | 'certificate'): Observable<Blob> {
    return this.http.get(this.downloadUrl(id, what), { responseType: 'blob' });
  }

  // ---- the ceremony (no credential but the token) --------------------- //
  ceremony(token: string): Observable<CeremonyMeta> {
    return this.http.get<CeremonyMeta>(`${this.base}/public/sign/${token}/`);
  }

  ceremonyContentUrl(token: string): string {
    return `${this.base}/public/sign/${token}/content/`;
  }

  /** A rendered page, for the read-only viewer in the ceremony. */
  ceremonyPageUrl(token: string, page: number, width = 900): string {
    return `${this.base}/public/sign/${token}/pages/${page}/?w=${width}`;
  }

  disclosure(): Observable<{ version: string; text: string; disclosure_sha256: string }> {
    return this.http.get<{ version: string; text: string; disclosure_sha256: string }>(
      `${this.base}/public/sign/disclosure/`);
  }

  consent(token: string): Observable<{ consented: boolean }> {
    return this.http.post<{ consented: boolean }>(
      `${this.base}/public/sign/${token}/consent/`, { agree: true });
  }

  fillField(token: string, body: {
    field_id: string; value?: string | boolean; signature_image?: string;
  }): Observable<{ id: string; filled: boolean }> {
    return this.http.post<{ id: string; filled: boolean }>(
      `${this.base}/public/sign/${token}/fields/`, body);
  }

  complete(token: string): Observable<{ completed: boolean; next: string }> {
    return this.http.post<{ completed: boolean; next: string }>(
      `${this.base}/public/sign/${token}/complete/`, {});
  }

  decline(token: string, reason: string): Observable<{ declined: boolean }> {
    return this.http.post<{ declined: boolean }>(
      `${this.base}/public/sign/${token}/decline/`, { reason });
  }

  report(token: string, reason: string):
    Observable<{ reported: boolean; reports: number; paused: boolean }> {
    return this.http.post<{ reported: boolean; reports: number; paused: boolean }>(
      `${this.base}/public/sign/${token}/report/`, { reason });
  }

  recipientDownloadUrl(token: string, what: 'final' | 'certificate'): string {
    return `${this.base}/public/sign/${token}/download/${what}/`;
  }

  // ---- verification (public) ------------------------------------------ //
  verify(file: File): Observable<VerifyReport> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<VerifyReport>(`${this.base}/verify/`, form);
  }
}
