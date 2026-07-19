import { Injectable, computed, inject, signal } from '@angular/core';

import { DocumentModel, Usage } from '../core/models/models';
import { ConfigService } from '../core/services/config.service';
import { DocListParams, DocumentsService } from '../core/services/documents.service';

@Injectable({ providedIn: 'root' })
export class DocumentsFacade {
  private docsSvc = inject(DocumentsService);
  private configSvc = inject(ConfigService);

  private _documents = signal<DocumentModel[]>([]);
  private _loading = signal(false);
  private _usage = signal<Usage | null>(null);

  readonly documents = this._documents.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly usage = this._usage.asReadonly();

  readonly q = signal('');
  readonly folder = signal<string | null>(null);
  readonly starred = signal(false);
  readonly trashed = signal(false);
  readonly ordering = signal('-updated_at');

  readonly storagePercent = computed(() => {
    const u = this._usage();
    if (!u || !u.storage.quota_bytes) return 0;
    return Math.min(100, Math.round((u.storage.used_bytes / u.storage.quota_bytes) * 100));
  });

  load(): void {
    this._loading.set(true);
    const params: DocListParams = {
      q: this.q() || undefined,
      folder: this.folder(),
      starred: this.starred() || undefined,
      trashed: this.trashed() || undefined,
      ordering: this.ordering(),
    };
    this.docsSvc.list(params).subscribe({
      next: (page) => {
        this._documents.set(page.results);
        this._loading.set(false);
      },
      error: () => this._loading.set(false),
    });
    this.refreshUsage();
  }

  refreshUsage(): void {
    this.configSvc.usage().subscribe({ next: (u) => this._usage.set(u) });
  }

  rename(id: string, title: string): void {
    this.patchLocal(id, { title });
    this.docsSvc.patch(id, { title }).subscribe({ error: () => this.load() });
  }

  toggleStar(doc: DocumentModel): void {
    const next = !doc.starred;
    this.patchLocal(doc.id, { starred: next });
    this.docsSvc.patch(doc.id, { starred: next }).subscribe({ error: () => this.load() });
  }

  move(id: string, folder: string | null): void {
    this.docsSvc.patch(id, { folder }).subscribe({ next: () => this.load() });
  }

  trash(id: string): void {
    this._documents.update((docs) => docs.filter((d) => d.id !== id));
    this.docsSvc.trash(id).subscribe({ next: () => this.refreshUsage(), error: () => this.load() });
  }

  restore(id: string): void {
    this._documents.update((docs) => docs.filter((d) => d.id !== id));
    this.docsSvc.restore(id).subscribe({ error: () => this.load() });
  }

  purge(id: string): void {
    this._documents.update((docs) => docs.filter((d) => d.id !== id));
    this.docsSvc.purge(id).subscribe({ next: () => this.refreshUsage(), error: () => this.load() });
  }

  private patchLocal(id: string, patch: Partial<DocumentModel>): void {
    this._documents.update((docs) =>
      docs.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
  }
}
