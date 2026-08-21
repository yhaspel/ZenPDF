import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import {
  Job,
  PageImage,
  PageLink,
  PageTextBlocks,
  ReplaceReport,
  TextBlock,
  TextStyle,
} from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { HistoryStack } from '../shared/history';
import { JobsFacade } from './jobs.facade';

/** A block the user has rewritten but not yet committed. */
export interface BlockEdit {
  block_id: number;
  page: number;
  block_bbox: TextBlock['bbox'];
  original: string;
  new_text: string;
  style: TextStyle;
}

/**
 * Content-editing session state (phase-04).
 *
 * Mirrors the annotation facade's shape deliberately: a per-page read-model
 * cache, a pending-edit store, and one job per commit. Multiple block edits go
 * out as a single `edit_text` op — the phase is explicit that an editing
 * session is one version, not one per keystroke.
 */
@Injectable({ providedIn: 'root' })
export class EditFacade {
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);

  private _blocks = signal<Map<number, PageTextBlocks>>(new Map());
  private _images = signal<Map<number, PageImage[]>>(new Map());
  private _links = signal<Map<number, PageLink[]>>(new Map());
  /**
   * Staged edits, keyed `"{page}:{block_id}"`.
   *
   * `block_id` is PyMuPDF's *per-page* block number and restarts at 0 on every
   * page, so keying on it alone made editing block 0 of page 2 overwrite the
   * edit staged for block 0 of page 1 — and prefill the editor with the other
   * page's text.
   */
  private _edits = signal<Map<string, BlockEdit>>(new Map());
  private _report = signal<ReplaceReport | null>(null);
  private _excluded = signal<Set<string>>(new Set());
  private _loading = signal(false);
  private docId: string | null = null;

  /**
   * Undo over the *staged* block edits, and nothing else (phase-12 D2).
   *
   * Every other operation in Edit mode — whiteout, add image, watermark, page
   * numbers — is dispatched to the server and appends a version, and those are
   * the workspace bar's Undo to take back. Binding ⌘Z to a server round-trip
   * that appends a version would make a keystroke destructive, so this history
   * covers exactly what is still local, and the button says so.
   */
  private history = new HistoryStack<Map<string, BlockEdit>>();

  readonly canUndo = this.history.canUndo;
  readonly canRedo = this.history.canRedo;
  readonly loading = this._loading.asReadonly();
  readonly report = this._report.asReadonly();
  readonly excluded = this._excluded.asReadonly();

  readonly pendingEdits = computed(() => [...this._edits().values()]);
  readonly dirty = computed(() => this._edits().size > 0);

  blocksFor(page: number): TextBlock[] {
    return this._blocks().get(page)?.blocks ?? [];
  }

  imagesFor(page: number): PageImage[] {
    return this._images().get(page) ?? [];
  }

  linksFor(page: number): PageLink[] {
    return this._links().get(page) ?? [];
  }

  /** Page aspect (height / width) from the read model, so the editor overlay
   *  can position itself in exactly the box the overlay renders. */
  aspectFor(page: number): number {
    const model = this._blocks().get(page);
    if (!model || !model.width) return 842 / 595;
    return model.height / model.width;
  }

  /** True once we know the page is a scan — the editor refuses to open on it. */
  isScanned(page: number): boolean {
    return this._blocks().get(page)?.is_scanned_page ?? false;
  }

  loaded(page: number): boolean {
    return this._blocks().has(page);
  }

  private static key(page: number, blockId: number): string {
    return `${page}:${blockId}`;
  }

  editFor(page: number, blockId: number): BlockEdit | undefined {
    return this._edits().get(EditFacade.key(page, blockId));
  }

  // ------------------------------------------------------------------ //
  // Loading
  // ------------------------------------------------------------------ //
  load(docId: string, page: number, version?: number | null): void {
    if (this.docId !== docId) {
      this.reset();
      this.docId = docId;
    }
    if (this._blocks().has(page)) return;
    this._loading.set(true);
    this.docsSvc.textBlocks(docId, page, version).subscribe({
      next: (model) => {
        this._blocks.update((map) => new Map(map).set(page, model));
        this._loading.set(false);
      },
      error: () => this._loading.set(false),
    });
    this.docsSvc.pageImages(docId, page, version).subscribe({
      next: (res) => this._images.update((map) => new Map(map).set(page, res.images)),
      error: () => { /* an unreadable page leaves the cache empty, not broken */ },
    });
    this.docsSvc.pageLinks(docId, page, version).subscribe({
      next: (res) => this._links.update((map) => new Map(map).set(page, res.links)),
      error: () => { /* an unreadable page leaves the cache empty, not broken */ },
    });
  }

  /** A new version invalidates every cached page. */
  reset(): void {
    this.history.clear();
    this._reportQuery = null;
    this._blocks.set(new Map());
    this._images.set(new Map());
    this._links.set(new Map());
    this._edits.set(new Map());
    this._report.set(null);
    this._excluded.set(new Set());
  }

  // ------------------------------------------------------------------ //
  // Text editing
  // ------------------------------------------------------------------ //
  stageEdit(block: TextBlock, page: number, newText: string, style: TextStyle): void {
    const key = EditFacade.key(page, block.block_id);
    this.history.remember(new Map(this._edits()));
    if (newText === block.text) {
      // Reverting to the original is not an edit; keeping it would send a
      // no-op through the redact-and-reinsert path and re-render the block for
      // nothing.
      this._edits.update((map) => {
        const next = new Map(map);
        next.delete(key);
        return next;
      });
      return;
    }
    this._edits.update((map) =>
      new Map(map).set(key, {
        block_id: block.block_id,
        page,
        block_bbox: block.bbox,
        original: block.text,
        new_text: newText,
        style,
      }),
    );
  }

  discardEdit(page: number, blockId: number): void {
    this.history.remember(new Map(this._edits()));
    this._edits.update((map) => {
      const next = new Map(map);
      next.delete(EditFacade.key(page, blockId));
      return next;
    });
  }

  undo(): void {
    const previous = this.history.undo(new Map(this._edits()));
    if (previous) this._edits.set(previous);
  }

  redo(): void {
    const next = this.history.redo(new Map(this._edits()));
    if (next) this._edits.set(next);
  }

  /** Commit every staged block as ONE `edit_text` job. */
  commitEdits(docId: string, baseSeq: number | null): Observable<Job> | null {
    const edits = this.pendingEdits();
    if (!edits.length) return null;
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'edit_text',
        params: {
          edits: edits.map((e) => ({
            page: e.page,
            block_bbox: e.block_bbox,
            new_text: e.new_text,
            style: e.style,
          })),
        },
        base_version_seq: baseSeq,
      }),
    );
  }

  // ------------------------------------------------------------------ //
  // Find & replace — two steps, per phase-04
  // ------------------------------------------------------------------ //
  preview(docId: string, baseSeq: number | null, find: string,
          matchCase: boolean): Observable<Job> {
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'find_replace',
        params: { find, match_case: matchCase, dry_run: true },
        base_version_seq: baseSeq,
      }),
    );
  }

  setReport(report: ReplaceReport | null): void {
    this._report.set(report);
    this._excluded.set(new Set());
  }

  /**
   * The query a held report was produced for.
   *
   * Match ids are positional (`p{page}:{ordinal}`), so applying a report's ids
   * with different search parameters resolves them against a *different* set of
   * hits — the user unticks "cat" and gets "cat" replaced anyway. The component
   * drops the report whenever the query changes; this is what it compares.
   */
  reportQuery(): { find: string; matchCase: boolean } | null {
    return this._reportQuery;
  }

  private _reportQuery: { find: string; matchCase: boolean } | null = null;

  rememberQuery(find: string, matchCase: boolean): void {
    this._reportQuery = { find, matchCase };
  }

  toggleMatch(id: string): void {
    this._excluded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The ids still checked in the review list. */
  keptIds(): string[] {
    const excluded = this._excluded();
    return (this._report()?.matches ?? [])
      .map((m) => m.id)
      .filter((id) => !excluded.has(id));
  }

  execute(docId: string, baseSeq: number | null, find: string, replace: string,
          matchCase: boolean): Observable<Job> {
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'find_replace',
        params: { find, replace, match_case: matchCase, only: this.keptIds() },
        base_version_seq: baseSeq,
      }),
    );
  }

  /** Every other Phase-4 op is fire-one-job-and-track. */
  run(docId: string, baseSeq: number | null, type: string, params: unknown): Observable<Job> {
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, { type, params, base_version_seq: baseSeq }),
    );
  }
}
