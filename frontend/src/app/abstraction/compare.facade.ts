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

  /**
   * The summary as one honest sentence.
   *
   * "**4** of 2 page(s) differ" was on screen whenever the other document was
   * the longer one (2026-08-21 report, smaller observations). The two numbers
   * are not the same denominator: `changed_pages` counts the positions
   * compared — the **union** of both documents, because "page 3 was added" is
   * exactly the change a reader is looking for — while `a_pages` is only this
   * document's length. Where the pages do not line up the sentence now says so
   * in as many words, and names both lengths so the larger count has somewhere
   * to have come from.
   *
   * The unpaired pages are counted off `report.pages` rather than from
   * `|a_pages − b_pages|`, because the alignment offset can leave a page
   * unmatched on *each* side while the two documents are the same length: at
   * offset 1 over two 3-page files, B's first page and A's last have no
   * counterpart. `null` while there is no report, and while the two are
   * identical — that sentence is its own.
   */
  readonly summaryLine = computed<string | null>(() => {
    const report = this._report();
    if (!report || report.summary.identical) return null;
    const { a_pages, b_pages, changed_pages, text_changes } = report.summary;
    const onlyA = report.pages.filter((page) => page.b_page === null).length;
    const onlyB = report.pages.filter((page) => page.a_page === null).length;
    const changes = `${text_changes} text ${plural(text_changes, 'change')}`;

    // The noun counts the set, the verb counts the subject: "1 of 3 pages
    // differs", "4 pages differ".
    const differ = plural(changed_pages, 'differs', 'differ');

    if (!onlyA && !onlyB) {
      return `${changed_pages} of ${a_pages} ${plural(a_pages, 'page')} ${differ} · ${changes}`;
    }
    const unpaired = [
      onlyA ? `${onlyA} only ${plural(onlyA, 'exists', 'exist')} in this document` : '',
      onlyB ? `${onlyB} only ${plural(onlyB, 'exists', 'exist')} in the other document` : '',
    ].filter(Boolean).join(', ');
    return `Compared ${a_pages} ${plural(a_pages, 'page')} against ${b_pages} — `
      + `${changed_pages} ${plural(changed_pages, 'page')} ${differ} (${unpaired}) · ${changes}`;
  });

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

/** `plural(1, 'page')` → "page"; `plural(2, 'page')` → "pages". */
function plural(count: number, one: string, many = `${one}s`): string {
  return count === 1 ? one : many;
}

function describe(kind: string, a: string, b: string): string {
  const trim = (text: string) => (text.length > 60 ? `${text.slice(0, 60)}…` : text);
  if (kind === 'insert') return `Added: “${trim(b)}”`;
  if (kind === 'delete') return `Removed: “${trim(a)}”`;
  return `Changed: “${trim(a)}” → “${trim(b)}”`;
}
