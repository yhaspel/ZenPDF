import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { DocumentModel, DocumentVersion, Job, OutlineItem } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';

@Injectable({ providedIn: 'root' })
export class ViewerFacade {
  private docsSvc = inject(DocumentsService);

  private _doc = signal<DocumentModel | null>(null);
  private _versions = signal<DocumentVersion[]>([]);
  private _outline = signal<OutlineItem[]>([]);

  readonly doc = this._doc.asReadonly();
  readonly versions = this._versions.asReadonly();
  readonly outline = this._outline.asReadonly();
  readonly pageCount = computed(() => this._doc()?.page_count ?? 0);
  readonly currentSeq = computed(() => this._doc()?.current_version?.seq ?? null);

  load(id: string): void {
    this.docsSvc.get(id).subscribe({ next: (d) => this._doc.set(d) });
    this.loadVersions(id);
    this.loadOutline(id);
  }

  loadVersions(id: string): void {
    this.docsSvc.versions(id).subscribe({ next: (v) => this._versions.set(v) });
  }

  loadOutline(id: string): void {
    this.docsSvc.outline(id).subscribe({
      next: (o) => this._outline.set(o.outline),
      error: () => this._outline.set([]),
    });
  }

  /** Re-fetch after an operation produced a new version. */
  reload(): void {
    const d = this._doc();
    if (d) {
      this.load(d.id);
    }
  }

  rename(title: string): void {
    const d = this._doc();
    if (!d) return;
    this._doc.set({ ...d, title });
    this.docsSvc.patch(d.id, { title }).subscribe({ error: () => this.reload() });
  }

  revert(seq: number): Observable<Job> {
    const d = this._doc();
    return this.docsSvc.revert(d!.id, seq);
  }
}
