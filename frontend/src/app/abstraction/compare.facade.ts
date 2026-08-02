import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, finalize, map } from 'rxjs';

import { CompareReport, Job, Rect } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { JobsFacade } from './jobs.facade';

/** One row of the change list: a change plus where it sits. */
export interface ChangeRow {
  id: string;
  pageIndex: number;
  aPage: number | null;
  bPage: number | null;
  kind: 'insert' | 'delete' | 'replace' | 'visual';
  summary: string;
  aRect: Rect | null;
  bRect: Rect | null;
}

/**
 * Compare session state (phase-06).
 *
 * The report is the whole answer, so the facade's job is to flatten it into a
 * clickable list and to remember which row is selected — the two viewers scroll
 * from that, which is what "synced" means here.
 */
@Injectable({ providedIn: 'root' })
export class CompareFacade {
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);

  private _report = signal<CompareReport | null>(null);
  private _selected = signal<string | null>(null);
  private _otherId = signal<string | null>(null);
  private _offset = signal(0);
  private _running = signal(false);

  readonly report = this._report.asReadonly();
  readonly selectedId = this._selected.asReadonly();
  readonly otherId = this._otherId.asReadonly();
  readonly offset = this._offset.asReadonly();
  readonly running = this._running.asReadonly();

  readonly summary = computed(() => this._report()?.summary ?? null);

  /** Every change, in page order, as one flat list the UI can walk. */
  readonly changes = computed<ChangeRow[]>(() => {
    const report = this._report();
    if (!report) return [];
    const rows: ChangeRow[] = [];
    report.pages.forEach((page, pageIndex) => {
      page.text_changes.forEach((change, i) => {
        rows.push({
          id: `t${pageIndex}:${i}`,
          pageIndex,
          aPage: page.a_page,
          bPage: page.b_page,
          kind: change.kind,
          summary: describe(change.kind, change.a_text, change.b_text),
          aRect: change.a_rect,
          bRect: change.b_rect,
        });
      });
      page.visual_regions.forEach((rect, i) => {
        rows.push({
          id: `v${pageIndex}:${i}`,
          pageIndex,
          aPage: page.a_page,
          bPage: page.b_page,
          kind: 'visual',
          summary: 'Something on the page looks different here',
          aRect: rect,
          bRect: rect,
        });
      });
    });
    return rows;
  });

  readonly selected = computed<ChangeRow | null>(
    () => this.changes().find((row) => row.id === this._selected()) ?? null,
  );

  /** Highlights for one side of one page — what the overlay draws. */
  rectsFor(side: 'a' | 'b', page: number): { id: string; rect: Rect }[] {
    return this.changes()
      .filter((row) => (side === 'a' ? row.aPage : row.bPage) === page)
      .map((row) => ({ id: row.id, rect: (side === 'a' ? row.aRect : row.bRect)! }))
      .filter((entry) => !!entry.rect);
  }

  select(id: string | null): void {
    this._selected.set(id);
  }

  setOther(id: string | null): void {
    this._otherId.set(id);
    this._report.set(null);
    this._selected.set(null);
  }

  setOffset(offset: number): void {
    this._offset.set(offset);
  }

  reset(): void {
    this._report.set(null);
    this._selected.set(null);
    this._otherId.set(null);
    this._offset.set(0);
  }

  run(docId: string, baseSeq: number | null): Observable<Job> | null {
    const other = this._otherId();
    if (!other) return null;
    this._running.set(true);
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'compare',
        params: { other_document_id: other, offset: this._offset() },
        base_version_seq: baseSeq,
      }),
    ).pipe(map((job) => {
      if (job.status === 'succeeded') {
        this._report.set((job.result?.['report'] as CompareReport) ?? null);
        this._selected.set(null);
      }
      if (job.status !== 'queued' && job.status !== 'running') this._running.set(false);
      return job;
    }), finalize(() => this._running.set(false)));
  }
}

function describe(kind: string, a: string, b: string): string {
  const trim = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);
  if (kind === 'insert') return `Added: “${trim(b)}”`;
  if (kind === 'delete') return `Removed: “${trim(a)}”`;
  return `Changed: “${trim(a)}” → “${trim(b)}”`;
}
