import { Injectable, computed, inject, signal } from '@angular/core';

import { DocumentModel, Usage } from '../core/models/models';
import { ConfigService } from '../core/services/config.service';
import { DocListParams, DocumentsService } from '../core/services/documents.service';

/** Mirrors DRF's `DefaultPagination.default_limit` (01-architecture.md §6). */
const PAGE_SIZE = 50;

@Injectable({ providedIn: 'root' })
export class DocumentsFacade {
  private docsSvc = inject(DocumentsService);
  private configSvc = inject(ConfigService);

  private _documents = signal<DocumentModel[]>([]);
  private _loading = signal(false);
  private _loadingMore = signal(false);
  private _hasMore = signal(false);
  private _total = signal(0);
  private _usage = signal<Usage | null>(null);

  /**
   * Rows the server has already handed us for the current filter.
   *
   * Tracked separately from `documents().length` because the optimistic
   * removals below shrink the list *and* the server's result set: after
   * trashing one of fifty, `offset = 50` would skip the fifty-first document
   * and `offset = documents().length` would fetch the fiftieth twice.
   */
  private offset = 0;

  readonly documents = this._documents.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly loadingMore = this._loadingMore.asReadonly();
  /** From the server's `next` link, not a length comparison — trashing the
   *  last document must not turn "nothing more" back into "load more". */
  readonly hasMore = this._hasMore.asReadonly();
  readonly total = this._total.asReadonly();
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

  /** A fresh first window. Every filter change already funnels through here,
   *  which is what resets the window. */
  load(): void {
    this._loading.set(true);
    this.offset = 0;
    this.docsSvc.list({ ...this.params(), limit: PAGE_SIZE, offset: 0 }).subscribe({
      next: (page) => {
        this._documents.set(page.results);
        this.offset = page.results.length;
        this._total.set(page.count);
        this._hasMore.set(page.next !== null);
        this._loading.set(false);
      },
      error: () => this._loading.set(false),
    });
    this.refreshUsage();
  }

  /**
   * The next window, appended.
   *
   * Deduped by id because `-updated_at` is not a stable sort key: starring or
   * renaming a document already on screen moves it to the front of the
   * server's ordering, and it would otherwise arrive a second time.
   */
  loadMore(): void {
    if (this._loading() || this._loadingMore() || !this._hasMore()) return;
    this._loadingMore.set(true);
    this.docsSvc.list({ ...this.params(), limit: PAGE_SIZE, offset: this.offset }).subscribe({
      next: (page) => {
        this.offset += page.results.length;
        this._total.set(page.count);
        this._hasMore.set(page.next !== null);
        this._documents.update((docs) => {
          const seen = new Set(docs.map((d) => d.id));
          return [...docs, ...page.results.filter((d) => !seen.has(d.id))];
        });
        this._loadingMore.set(false);
      },
      error: () => this._loadingMore.set(false),
    });
  }

  private params(): DocListParams {
    return {
      q: this.q() || undefined,
      folder: this.folder(),
      starred: this.starred() || undefined,
      trashed: this.trashed() || undefined,
      ordering: this.ordering(),
    };
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
    this.removeLocal(id);
    this.docsSvc.trash(id).subscribe({ next: () => this.refreshUsage(), error: () => this.load() });
  }

  restore(id: string): void {
    this.removeLocal(id);
    this.docsSvc.restore(id).subscribe({ error: () => this.load() });
  }

  purge(id: string): void {
    this.removeLocal(id);
    this.docsSvc.purge(id).subscribe({ next: () => this.refreshUsage(), error: () => this.load() });
  }

  /** The row left the current result set on the server too, so the window we
   *  have consumed is one shorter. */
  private removeLocal(id: string): void {
    this._documents.update((docs) => docs.filter((d) => d.id !== id));
    this.offset = Math.max(0, this.offset - 1);
    this._total.update((n) => Math.max(0, n - 1));
  }

  private patchLocal(id: string, patch: Partial<DocumentModel>): void {
    this._documents.update((docs) =>
      docs.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
  }
}
