import { Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { Job } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { JobsFacade } from './jobs.facade';

@Injectable({ providedIn: 'root' })
export class PagesFacade {
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);

  readonly selection = signal<Set<number>>(new Set());
  private anchor = 0;

  isSelected(page: number): boolean {
    return this.selection().has(page);
  }

  toggle(page: number, additive: boolean): void {
    const next = new Set(additive ? this.selection() : []);
    if (additive && next.has(page)) {
      next.delete(page);
    } else {
      next.add(page);
    }
    this.anchor = page;
    this.selection.set(next);
  }

  selectRange(to: number): void {
    const [lo, hi] = this.anchor <= to ? [this.anchor, to] : [to, this.anchor];
    const next = new Set<number>();
    for (let i = lo; i <= hi; i += 1) next.add(i);
    this.selection.set(next);
  }

  clear(): void {
    this.selection.set(new Set());
  }

  selectedSorted(): number[] {
    return [...this.selection()].sort((a, b) => a - b);
  }

  dispatch(
    docId: string,
    type: string,
    params: unknown,
    baseSeq: number | null,
  ): Observable<Job> {
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, { type, params, base_version_seq: baseSeq }),
    );
  }
}
