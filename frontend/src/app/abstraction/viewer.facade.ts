import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { DocumentModel, DocumentVersion, Job, OutlineItem } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';

/** What the workspace says when the document will not load. */
export interface ViewerError {
  /** The §6 machine code, where the server sent one. */
  code: string;
  message: string;
  /**
   * Seconds the server asked us to wait, for the one failure here that is not
   * a failure: a throttle. Without it the screen offered a "Try again" button
   * whose only possible outcome, pressed immediately, was the same message.
   */
  retryAfter?: number;
}

/**
 * A §6 error envelope, or a sentence for the cases that never reach the API.
 *
 * The server's own message is preferred wherever there is one — it is written
 * for a person and it knows things this layer does not (which quota, whose
 * session). The fallbacks are for `status === 0`, which is offline or a
 * cancelled request and has no body at all.
 */
function describe(error: unknown): ViewerError {
  const response = error as HttpErrorResponse;
  const envelope = response?.error?.error;
  if (envelope?.message) {
    const wait = Number(envelope.details?.retry_after_seconds);
    return {
      code: String(envelope.code ?? ''),
      message: String(envelope.message),
      ...(Number.isFinite(wait) && wait > 0 ? { retryAfter: Math.ceil(wait) } : {}),
    };
  }
  if (response?.status === 404) {
    return { code: 'not_found', message: 'That document could not be found.' };
  }
  if (response?.status === 0) {
    return {
      code: 'offline',
      message: 'We could not reach ZenPDF. Check your connection and try again.',
    };
  }
  return {
    code: 'engine_error',
    message: 'Something went wrong opening that document.',
  };
}

@Injectable({ providedIn: 'root' })
export class ViewerFacade {
  private docsSvc = inject(DocumentsService);

  private _doc = signal<DocumentModel | null>(null);
  private _versions = signal<DocumentVersion[]>([]);
  private _versionCount = signal(0);
  private _outline = signal<OutlineItem[]>([]);
  private _loading = signal(false);
  private _error = signal<ViewerError | null>(null);

  readonly doc = this._doc.asReadonly();
  /** True while the document itself is in flight — the template shows a state. */
  readonly loading = this._loading.asReadonly();
  /**
   * Why there is no document.
   *
   * `load()` had no error handler at all, so a stale link, a document
   * belonging to somebody else, a 500 or a dropped connection left `doc()`
   * null and the template gating on it with no `@else` — a white screen with
   * nothing on it and no way back.
   */
  readonly error = this._error.asReadonly();
  readonly versions = this._versions.asReadonly();
  /** How many exist, so the panel can say when it is showing a window. */
  readonly versionCount = this._versionCount.asReadonly();
  readonly outline = this._outline.asReadonly();
  readonly pageCount = computed(() => this._doc()?.page_count ?? 0);
  readonly currentSeq = computed(() => this._doc()?.current_version?.seq ?? null);

  /**
   * Which `load()` is current.
   *
   * Split and extract navigate straight from one document to another, so two
   * loads can be in flight at once — and now that a failure *clears* state,
   * a slow 500 for the document you just left would wipe the one you are
   * looking at. Every callback checks it still owns the request.
   */
  private generation = 0;

  load(id: string): void {
    const mine = ++this.generation;
    this._loading.set(true);
    this._error.set(null);
    this.docsSvc.get(id).subscribe({
      next: (d) => {
        if (mine !== this.generation) return;
        this._doc.set(d);
        this._loading.set(false);
      },
      error: (err) => {
        if (mine !== this.generation) return;
        // The document is cleared as well as the error set: leaving the
        // previous one on screen under a failed reload would show the user a
        // document they are no longer looking at.
        this._doc.set(null);
        this._versions.set([]);
        this._versionCount.set(0);
        this._outline.set([]);
        this._error.set(describe(err));
        this._loading.set(false);
      },
    });
    this.loadVersions(id, mine);
    this.loadOutline(id, mine);
  }

  loadVersions(id: string, generation?: number): void {
    // One page. The panel is a scrolling list of the most recent work, and a
    // document with a long history used to send all of it — 1.4 MB at 5 000
    // versions — on every open and after every operation.
    this.docsSvc.versions(id).subscribe({
      next: (page) => {
        if (generation !== undefined && generation !== this.generation) return;
        this._versions.set(page.results);
        this._versionCount.set(page.count);
      },
    });
  }

  /**
   * Append the next page of history.
   *
   * Not optional polish: revert is driven off `versions()`, so without this the
   * first page is the only history the UI can reach — and "you can revert to
   * any of them" is the promise the tool pages make and the reason the history
   * is not pruned in the first place. A window the user cannot open is a cap
   * with extra steps.
   */
  loadMoreVersions(): void {
    const d = this._doc();
    if (!d) return;
    this.docsSvc.versions(d.id, 50, this._versions().length).subscribe({
      next: (page) => {
        this._versions.update((v) => [...v, ...page.results]);
        this._versionCount.set(page.count);
      },
    });
  }

  loadOutline(id: string, generation?: number): void {
    const current = () => generation === undefined || generation === this.generation;
    this.docsSvc.outline(id).subscribe({
      next: (o) => { if (current()) this._outline.set(o.outline); },
      error: () => { if (current()) this._outline.set([]); },
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
