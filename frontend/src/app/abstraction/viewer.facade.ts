import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { apiError } from '../core/api-error';
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
  const { code, message, status, retryAfter } = apiError(error);
  // Truthy, not `!== undefined`: an envelope carrying an empty message has
  // explained nothing, and the status-shaped sentences below are better than
  // a blank screen.
  if (message) {
    return {
      code: code ?? '',
      message,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
    };
  }
  if (status === 404) {
    return { code: 'not_found', message: 'That document could not be found.' };
  }
  if (status === 0) {
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
    const current = () => generation === undefined || generation === this.generation;
    this.docsSvc.versions(id).subscribe({
      next: (page) => {
        if (!current()) return;
        this._versions.set(page.results);
        this._versionCount.set(page.count);
      },
      // `loadOutline` below has always had this and this method never did — the
      // omission cost two things. A rejected observable with no `error` reaches
      // the global handler, so opening a document that 404s printed an
      // `HttpErrorResponse` to the console for a failure the screen was already
      // explaining properly. And on the failure that is *not* the document's —
      // this request alone failing while the document loads — the panel kept
      // the **previous** document's versions, offering "Revert to this" against
      // version ids belonging to a file the person is no longer looking at.
      //
      // Both signals are cleared, not just the list: the panel says "Showing
      // the N most recent of M" whenever `versionCount` exceeds what it holds,
      // so clearing one of the two would replace a stale list with the sentence
      // "Showing the 0 most recent of 5".
      error: () => {
        if (!current()) return;
        this._versions.set([]);
        this._versionCount.set(0);
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
      // Handled, and deliberately a no-op: the window already on screen is
      // still correct, so keeping it is right and clearing it would throw away
      // history the person can still use. What this must not do is *nothing* —
      // an unhandled rejection here would reach the global error handler, and
      // "Show older versions" failing is not a crash. The button stays, so the
      // next press retries.
      error: () => undefined,
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

  /**
   * Take the new version from the job that just produced it, then reload.
   *
   * `reload()` alone is a race, and it was measured: 2 of 6 runs of `phase-3`
   * and `phase-4` red on `main`, in isolation, on a settled stack. A save
   * succeeds, `trackReload` shows the toast and calls `reload()`, and the
   * refetch is *asynchronous* — so for as long as that GET is in flight
   * `currentSeq()` is still the old number, and anything dispatched in that
   * window carries a stale `base_version_seq`. The worker refuses it with
   * `version_conflict`: "The document changed since you loaded it." Across a
   * full suite run **every** failed job was that, and not only in the editor —
   * `page_numbers` and `set_metadata` too. In the product it self-heals into a
   * "Document changed — refreshed" toast, so it is a recoverable annoyance for
   * anyone who acts quickly after saving, and a reliable flake for a test
   * script that always does.
   *
   * The job already carries the answer. The result of every version-producing
   * operation reports the `seq` it created, so `currentSeq()` can be right the
   * instant the save returns instead of one round trip later. The reload still
   * happens — the version list, the outline and the page count come from it —
   * but nothing has to *wait* for it to know which version it is on.
   *
   * A result without a `seq` falls back to a plain reload rather than guessing:
   * an operation that produced no version (or a shape this does not recognise)
   * must not be allowed to invent one, because a `currentSeq` that is wrong in
   * the *other* direction is the same defect with the blame reversed.
   */
  adopt(job: Job): void {
    const d = this._doc();
    const seq = Number(job?.result?.['seq']);
    if (!d?.current_version || !Number.isFinite(seq)) {
      this.reload();
      return;
    }
    const pageCount = Number(job.result?.['page_count']);
    this._doc.set({
      ...d,
      current_version: { ...d.current_version, seq },
      ...(Number.isFinite(pageCount) ? { page_count: pageCount } : {}),
    });
    this.reload();
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
