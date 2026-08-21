import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, finalize, map } from 'rxjs';

import {
  Job,
  PdfPermissions,
  RedactMatch,
  RedactPattern,
  RedactReport,
  Rect,
} from '../core/models/models';
import { DocumentPasswords } from '../core/services/document-passwords';
import { DocumentsService } from '../core/services/documents.service';
import { HistoryStack } from '../shared/history';
import { JobsFacade } from './jobs.facade';

/** An area the user has drawn but not yet applied. */
export interface RedactArea {
  id: string;
  page: number;
  rect: Rect;
}

/**
 * Protect, redact and sanitize (phase-07).
 *
 * Holds the **session password** for an encrypted document — in memory only,
 * never in storage. That is the whole point of it: without somewhere to keep
 * it, every operation on a protected document would prompt again, which is how
 * people end up choosing not to protect documents.
 */
@Injectable({ providedIn: 'root' })
export class SecurityFacade {
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);
  /** Memory only, and shared with `DocumentsService` so that *every* operation
   *  on an unlocked document carries it — not only the ones from this facade. */
  private passwords = inject(DocumentPasswords);

  private _areas = signal<RedactArea[]>([]);
  private _report = signal<RedactReport | null>(null);
  private _excluded = signal<Set<string>>(new Set());
  private _busy = signal(false);

  /** Undo over the areas marked for redaction, so a mis-drawn box or a
   *  mis-aimed Delete is one keystroke away from coming back. */
  private history = new HistoryStack<RedactArea[]>();

  readonly canUndo = this.history.canUndo;
  readonly canRedo = this.history.canRedo;
  readonly areas = this._areas.asReadonly();
  readonly report = this._report.asReadonly();
  readonly excluded = this._excluded.asReadonly();
  readonly busy = this._busy.asReadonly();

  readonly matches = computed<RedactMatch[]>(() => this._report()?.matches ?? []);
  readonly keptIds = computed(() => {
    const excluded = this._excluded();
    return this.matches().map((m) => m.id).filter((id) => !excluded.has(id));
  });
  readonly hasWork = computed(() => this._areas().length > 0 || this.keptIds().length > 0);

  // ------------------------------------------------------------------ //
  // Session password
  // ------------------------------------------------------------------ //
  /** Which documents are unlocked — a signal, so the viewer can react to it. */
  readonly unlockedIds = this.passwords.unlocked;

  remember(docId: string, password: string): void {
    this.passwords.remember(docId, password);
  }

  forget(docId: string): void {
    this.passwords.forget(docId);
  }

  passwordFor(docId: string): string {
    return this.passwords.passwordFor(docId);
  }

  isUnlocked(docId: string): boolean {
    return this.passwords.isUnlocked(docId);
  }

  // ------------------------------------------------------------------ //
  // Protect
  // ------------------------------------------------------------------ //
  protect(docId: string, baseSeq: number | null, options: {
    ownerPassword: string; userPassword?: string; permissions?: PdfPermissions;
  }): Observable<Job> {
    return this.run(docId, baseSeq, 'encrypt', {
      owner_password: options.ownerPassword,
      ...(options.userPassword ? { user_password: options.userPassword } : {}),
      ...(options.permissions ? { permissions: options.permissions } : {}),
    });
  }

  unlock(docId: string, baseSeq: number | null, password: string): Observable<Job> {
    return this.run(docId, baseSeq, 'decrypt', { password });
  }

  changePermissions(docId: string, baseSeq: number | null, ownerPassword: string,
                    permissions: PdfPermissions): Observable<Job> {
    return this.run(docId, baseSeq, 'set_permissions', {
      owner_password: ownerPassword, permissions,
    });
  }

  sanitize(docId: string, baseSeq: number | null,
           items: Record<string, boolean>): Observable<Job> {
    return this.run(docId, baseSeq, 'sanitize',
                    Object.fromEntries(Object.entries(items).filter(([, on]) => on)));
  }

  // ------------------------------------------------------------------ //
  // Redact
  // ------------------------------------------------------------------ //
  /** Monotonic, so an id is never reused after a removal — reusing one made
   *  deleting the newest area delete an older one with it. */
  private nextAreaId = 0;

  addArea(page: number, rect: Rect): void {
    this.history.remember([...this._areas()]);
    this._areas.update((areas) => [
      ...areas, { id: `a${this.nextAreaId++}`, page, rect },
    ]);
  }

  removeArea(id: string): void {
    this.history.remember([...this._areas()]);
    this._areas.update((areas) => areas.filter((a) => a.id !== id));
  }

  /** Move an already-marked area — what makes dragging and nudging one work.
   *  Without it the overlay would draw resize handles wired to nothing. */
  moveArea(id: string, rect: Rect): void {
    this.history.remember([...this._areas()]);
    this._areas.update((areas) => areas.map((a) => (a.id === id ? { ...a, rect } : a)));
  }

  undoAreas(): void {
    const previous = this.history.undo([...this._areas()]);
    if (previous) this._areas.set(previous);
  }

  redoAreas(): void {
    const next = this.history.redo([...this._areas()]);
    if (next) this._areas.set(next);
  }

  clear(): void {
    this.history.clear();
    this._areas.set([]);
    this.clearReview();
  }

  /** The review list only describes the search that produced it. Changing what
   *  is being searched for invalidates it — and applying against a stale one
   *  sends ids that now identify *different* matches. */
  clearReview(): void {
    this._report.set(null);
    this._excluded.set(new Set());
  }

  toggleMatch(id: string): void {
    this._excluded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Step one of two: what *would* go. Nothing is changed. */
  preview(docId: string, baseSeq: number | null, patterns: RedactPattern[],
          searchText: string, matchCase: boolean): Observable<Job> {
    return this.run(docId, baseSeq, 'redact', {
      ...(patterns.length ? { patterns } : {}),
      ...(searchText ? { search_text: searchText } : {}),
      match_case: matchCase,
      dry_run: true,
    }).pipe(map((job) => {
      if (job.status === 'succeeded') {
        this._report.set((job.result?.['report'] as RedactReport) ?? null);
        this._excluded.set(new Set());
      }
      return job;
    }));
  }

  /** Step two: remove it. `cleanCopy` defaults on — see the UI copy. */
  apply(docId: string, baseSeq: number | null, options: {
    patterns: RedactPattern[]; searchText: string; matchCase: boolean;
    cleanCopy: boolean; label?: string;
  }): Observable<Job> {
    const areas = this._areas().map((a) => ({ page: a.page, rect: a.rect }));
    const hasPatterns = options.patterns.length > 0 || !!options.searchText;
    // An empty `only` means "the user unticked every match", which the engine
    // now distinguishes from "no review list at all" — so it is sent as an
    // empty array rather than omitted.
    return this.run(docId, baseSeq, 'redact', {
      ...(areas.length ? { areas } : {}),
      ...(options.patterns.length ? { patterns: options.patterns } : {}),
      ...(options.searchText ? { search_text: options.searchText } : {}),
      match_case: options.matchCase,
      // Sent whenever a review list exists — including when it is empty, which
      // is the user saying "none of these". Omitted when there is nothing to
      // filter, so an area-only redaction is not turned into a no-op.
      ...(hasPatterns && this._report() ? { only: this.keptIds() } : {}),
      ...(options.label ? { fill: { color: '#000000', label: options.label } } : {}),
      fork_clean_copy: options.cleanCopy,
    });
  }

  private run(docId: string, baseSeq: number | null, type: string,
              params: Record<string, unknown>): Observable<Job> {
    this._busy.set(true);
    // The session password is attached by `DocumentsService`, for every
    // operation from anywhere — see `DocumentPasswords`.
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, { type, params, base_version_seq: baseSeq }),
    ).pipe(
      map((job) => {
        if (job.status !== 'queued' && job.status !== 'running') this._busy.set(false);
        return job;
      }),
      finalize(() => this._busy.set(false)),
    );
  }
}
