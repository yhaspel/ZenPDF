import { Injectable, computed, inject, signal } from '@angular/core';

import { apiError } from '../core/api-error';
import { DocumentModel, Usage } from '../core/models/models';
import { ConfigService } from '../core/services/config.service';
import { DocListParams, DocumentsService } from '../core/services/documents.service';

/** Mirrors DRF's `DefaultPagination.default_limit` (01-architecture.md §6). */
const PAGE_SIZE = 50;

/**
 * The server's own sentence, or a plain fallback — never a status code.
 *
 * `_purge` writes the reason a document cannot be deleted, and it is the only
 * place that sentence exists. Rewriting it here would be a second copy that
 * drifts; showing "403" instead would be no explanation at all.
 */
function purgeMessage(err: unknown): string {
  return (
    apiError(err).message
    ?? 'That document could not be deleted. Try again in a moment.'
  );
}

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
   * Which query the visible list belongs to.
   *
   * `load()` and `loadMore()` hold no subscription, so a filter change while a
   * page is in flight used to append the *old* query's rows to the *new*
   * query's list — fourteen documents that do not match the search, and a
   * count from the query nobody is looking at any more.
   */
  private generation = 0;

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
    const generation = ++this.generation;
    this.offset = 0;
    this.docsSvc.list({ ...this.params(), limit: PAGE_SIZE, offset: 0 }).subscribe({
      next: (page) => {
        if (generation !== this.generation) return;
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
    const generation = this.generation;
    this._loadingMore.set(true);
    this.docsSvc.list({ ...this.params(), limit: PAGE_SIZE, offset: this.offset }).subscribe({
      next: (page) => {
        if (generation !== this.generation) {
          // The filter changed while this page was in flight. Dropping it is
          // the whole point: appending would mix two queries' results.
          this._loadingMore.set(false);
          return;
        }
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
    this.docsSvc.patch(id, { title }).subscribe({
      // Same reasoning as `toggleStar`: a rename that stops matching the
      // active search drops the row out of the server's result set.
      next: () => { if (this.q()) this.load(); },
      error: () => this.load(),
    });
  }

  toggleStar(doc: DocumentModel): void {
    const next = !doc.starred;
    this.patchLocal(doc.id, { starred: next });
    this.docsSvc.patch(doc.id, { starred: next }).subscribe({
      // Un-starring inside the Starred filter removes the row from the
      // *server's* result set too, so the window we have consumed is one
      // shorter — and without reloading, "Load more" skips exactly that many
      // documents while `next: null` turns the button off, reporting a
      // complete list that is missing a document.
      next: () => { if (this.starred() && !next) this.load(); },
      error: () => this.load(),
    });
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

  /**
   * Why a permanent deletion was refused, keyed by document id.
   *
   * A refusal here is not a transient failure to retry — it is a standing fact
   * about the document ("a signature request points at it") that will be just
   * as true tomorrow. The old handler discarded it entirely: `error: () =>
   * this.load()` put the row back and said nothing, so the user pressed Delete
   * forever, watched the card vanish and reappear, and was told nothing at all.
   * The card renders this next to the document it is about.
   */
  private _purgeErrors = signal<Record<string, string>>({});
  readonly purgeErrors = this._purgeErrors.asReadonly();

  purge(id: string): void {
    this.removeLocal(id);
    // A retry starts with a clean slate: the previous refusal may have been
    // fixed (the request cancelled) and leaving it up would contradict the
    // card that just disappeared.
    this.clearPurgeError(id);
    this.docsSvc.purge(id).subscribe({
      next: () => this.refreshUsage(),
      error: (err: unknown) => {
        this._purgeErrors.update((errors) => ({ ...errors, [id]: purgeMessage(err) }));
        this.load();
      },
    });
  }

  /** Forget a refusal — the row is gone from view, so its explanation is too. */
  clearPurgeError(id: string): void {
    this._purgeErrors.update((errors) => {
      if (!(id in errors)) return errors;
      const rest = { ...errors };
      delete rest[id];
      return rest;
    });
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
