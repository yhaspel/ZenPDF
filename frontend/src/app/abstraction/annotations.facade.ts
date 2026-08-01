import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { Annotation, AnnotationOp, Job, WordBox } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { JobsFacade } from './jobs.facade';

/**
 * Annotation session state (phase-03 §2 "Session batching").
 *
 * The overlay renders drafts instantly and nothing hits the server until Save
 * (or the 30 s autosave), at which point the whole session becomes **one**
 * `annotate_batch` job — one version, not one per keystroke.
 *
 * Three stores rather than one mutable list:
 *   `saved`   — what the server last told us is in the file;
 *   `drafts`  — local adds and edits, keyed by the same NM;
 *   `removed` — NMs the user deleted.
 * Keeping them apart is what makes the batch composer trivial and, more
 * importantly, makes **replay after a version conflict** safe: the drafts are
 * independent objects addressed by stable ids, so re-applying them to a fresher
 * version is well-defined (a conflicting delete simply becomes a no-op).
 */
@Injectable({ providedIn: 'root' })
export class AnnotationsFacade {
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);

  private _saved = signal<Annotation[]>([]);
  private _drafts = signal<Map<string, Annotation>>(new Map());
  private _removed = signal<Set<string>>(new Set());
  private _words = signal<Map<number, WordBox[]>>(new Map());
  private _selectedId = signal<string | null>(null);
  private _loading = signal(false);

  readonly selectedId = this._selectedId.asReadonly();
  readonly loading = this._loading.asReadonly();

  /** Everything the user should currently see: saved ∪ drafts ∖ removed. */
  readonly all = computed<Annotation[]>(() => {
    const drafts = this._drafts();
    const removed = this._removed();
    const merged = new Map<string, Annotation>();
    for (const a of this._saved()) {
      if (!removed.has(a.id)) merged.set(a.id, a);
    }
    for (const [id, a] of drafts) {
      if (!removed.has(id)) merged.set(id, a);
    }
    return [...merged.values()].sort((a, b) => a.page - b.page);
  });

  readonly byPage = computed<Map<number, Annotation[]>>(() => {
    const grouped = new Map<number, Annotation[]>();
    for (const a of this.all()) {
      const bucket = grouped.get(a.page);
      if (bucket) bucket.push(a);
      else grouped.set(a.page, [a]);
    }
    return grouped;
  });

  readonly dirty = computed(() => this._drafts().size > 0 || this._removed().size > 0);
  readonly count = computed(() => this.all().length);
  readonly pendingChanges = computed(() => this._drafts().size + this._removed().size);

  readonly selected = computed<Annotation | null>(() => {
    const id = this._selectedId();
    return id ? (this.all().find((a) => a.id === id) ?? null) : null;
  });

  wordsFor(page: number): WordBox[] {
    return this._words().get(page) ?? [];
  }

  // ------------------------------------------------------------------ //
  // Loading
  // ------------------------------------------------------------------ //
  load(docId: string, version?: number | null): void {
    this._loading.set(true);
    this.docsSvc.annotations(docId, version).subscribe({
      next: (res) => {
        this._saved.set(res.annotations);
        this._drafts.set(new Map());
        this._removed.set(new Set());
        this._selectedId.set(null);
        this._loading.set(false);
      },
      error: () => this._loading.set(false),
    });
  }

  loadWords(docId: string, page: number, version?: number | null): void {
    if (this._words().has(page)) return;
    this.docsSvc.textWords(docId, page, version).subscribe({
      next: (res) => {
        this._words.update((map) => new Map(map).set(page, res.words));
      },
      error: () => {
        this._words.update((map) => new Map(map).set(page, []));
      },
    });
  }

  /** A new version invalidates every cached word list and every saved annot. */
  resetForVersion(): void {
    this._words.set(new Map());
  }

  // ------------------------------------------------------------------ //
  // Editing
  // ------------------------------------------------------------------ //
  add(annotation: Annotation): void {
    this._drafts.update((map) => new Map(map).set(annotation.id, annotation));
    this._selectedId.set(annotation.id);
  }

  update(id: string, patch: Partial<Annotation>): void {
    const current = this.all().find((a) => a.id === id);
    if (!current) return;
    this._drafts.update((map) => new Map(map).set(id, { ...current, ...patch, id }));
  }

  remove(id: string): void {
    this._removed.update((set) => new Set(set).add(id));
    this._drafts.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
    if (this._selectedId() === id) this._selectedId.set(null);
  }

  removeAll(): void {
    this._removed.update((set) => {
      const next = new Set(set);
      for (const a of this.all()) next.add(a.id);
      return next;
    });
    this._drafts.set(new Map());
    this._selectedId.set(null);
  }

  select(id: string | null): void {
    this._selectedId.set(id);
  }

  // ------------------------------------------------------------------ //
  // Saving — one job per session
  // ------------------------------------------------------------------ //
  ops(): AnnotationOp[] {
    const savedIds = new Set(this._saved().map((a) => a.id));
    const ops: AnnotationOp[] = [];
    for (const id of this._removed()) {
      // Deleting something that was never saved is purely local — no op.
      if (savedIds.has(id)) ops.push({ action: 'delete', annotation: { id } });
    }
    for (const [id, annotation] of this._drafts()) {
      ops.push({ action: savedIds.has(id) ? 'update' : 'add', annotation });
    }
    return ops;
  }

  save(docId: string, baseSeq: number | null): Observable<Job> | null {
    const ops = this.ops();
    if (!ops.length) return null;
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'annotate_batch',
        params: { ops },
        base_version_seq: baseSeq,
      }),
    );
  }

  flatten(docId: string, baseSeq: number | null): Observable<Job> {
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'flatten',
        params: { what: 'annotations' },
        base_version_seq: baseSeq,
      }),
    );
  }

  /**
   * Keep the drafts after a save failed with `version_conflict`.
   *
   * phase-03 is explicit that v1 does not attempt a merge dialog: the document
   * reloads and the local drafts are replayed onto the fresh version. That is
   * safe precisely because drafts are independent objects with stable ids.
   */
  keepDraftsForReplay(): void {
    this._saved.set([]);
  }

  clear(): void {
    this._saved.set([]);
    this._drafts.set(new Map());
    this._removed.set(new Set());
    this._words.set(new Map());
    this._selectedId.set(null);
  }
}
