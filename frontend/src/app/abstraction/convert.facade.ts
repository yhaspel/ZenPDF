import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, finalize, forkJoin, map, switchMap } from 'rxjs';

import { ExportFormat, Job, OcrOptions, SourceAsset } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { JobsFacade } from './jobs.facade';

/** What the export grid offers, and the honest sentence under each tile. */
export const EXPORT_FORMATS: { format: ExportFormat; label: string; note: string }[] = [
  { format: 'docx', label: 'Word', note: 'Layout is approximated — a PDF has no paragraphs to recover.' },
  { format: 'images', label: 'Images', note: 'One PNG or JPEG per page, in a zip.' },
  { format: 'txt', label: 'Text', note: 'Plain text, one section per page.' },
  { format: 'md', label: 'Markdown', note: 'Headings and lists inferred from the layout.' },
  { format: 'html', label: 'HTML', note: 'Positioned HTML — faithful to the page, not to the web.' },
  { format: 'pdfa', label: 'PDF/A', note: 'Archival PDF/A-2b. Claims conformance; not independently validated.' },
];

/**
 * OCR, conversion and export (phase-06).
 *
 * All four of this phase's operations are `METERED_OPS` (§16), which is why
 * this facade tracks a single in-flight job rather than letting the UI fire
 * several: the limit is per hour, and a user who has just spent three of five
 * on double-clicks will not thank us.
 */
@Injectable({ providedIn: 'root' })
export class ConvertFacade {
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);

  private _busy = signal(false);
  private _lastExport = signal<Job | null>(null);

  readonly busy = this._busy.asReadonly();
  readonly lastExport = this._lastExport.asReadonly();
  readonly exportFormats = EXPORT_FORMATS;

  /** The finished export's filename, for the download button's label. */
  readonly exportName = computed(() => {
    const job = this._lastExport();
    const info = job?.result?.['export'] as { filename?: string } | undefined;
    return info?.filename ?? '';
  });

  reset(): void {
    this._lastExport.set(null);
  }

  ocr(docId: string, baseSeq: number | null, options: OcrOptions): Observable<Job> {
    this._busy.set(true);
    return this.finish(this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'ocr',
        params: {
          languages: options.languages,
          ...(options.deskew ? { deskew: true } : {}),
          ...(options.rotate_pages ? { rotate_pages: true } : {}),
          ...(options.clean ? { clean: true } : {}),
          ...(options.force ? { force: true } : {}),
        },
        base_version_seq: baseSeq,
      }),
    ));
  }

  exportAs(docId: string, baseSeq: number | null, format: ExportFormat,
           opts: { dpi?: number; imageFormat?: 'png' | 'jpg' } = {}): Observable<Job> {
    this._busy.set(true);
    return this.finish(this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'convert_to',
        params: {
          format,
          ...(format === 'images'
            ? { dpi: opts.dpi ?? 150, image_format: opts.imageFormat ?? 'png' }
            : {}),
        },
        base_version_seq: baseSeq,
      }),
    )).pipe(map((job) => {
      if (job.status === 'succeeded') this._lastExport.set(job);
      return job;
    }));
  }

  repair(docId: string, baseSeq: number | null): Observable<Job> {
    this._busy.set(true);
    return this.finish(this.jobs.dispatch(
      this.docsSvc.operation(docId, { type: 'repair', params: {}, base_version_seq: baseSeq }),
    ));
  }

  /** Upload a file, then convert it — one call, because the ref is useless alone. */
  importFile(file: File): Observable<Job> {
    this._busy.set(true);
    return this.finish(
      this.docsSvc.uploadSource(file).pipe(
        switchMap((asset: SourceAsset) => this.jobs.dispatch(
          this.docsSvc.crossOperation({
            type: 'convert_from',
            params: { upload_ref: asset.ref, filename: asset.filename },
          }),
        )),
      ),
    );
  }

  /**
   * Several images → **one** PDF, a page each, in the order given.
   *
   * The `/jpg-to-pdf` page promises exactly this ("add them all and each
   * becomes a page"). Running one conversion per file instead produced N
   * separate one-page documents, showed whichever finished first, and left the
   * rest orphaned — all of them metered.
   */
  importImages(files: File[]): Observable<Job> {
    this._busy.set(true);
    const uploads = files.map((file) => this.docsSvc.uploadSource(file));
    return this.finish(
      forkJoin(uploads).pipe(
        switchMap((assets: SourceAsset[]) => this.jobs.dispatch(
          this.docsSvc.crossOperation({
            type: 'convert_from',
            params: {
              upload_refs: assets.map((a) => a.ref),
              filename: assets[0]?.filename,
            },
          }),
        )),
      ),
    );
  }

  importUrl(url: string): Observable<Job> {
    this._busy.set(true);
    return this.finish(this.jobs.dispatch(
      this.docsSvc.crossOperation({ type: 'convert_from', params: { url } }),
    ));
  }

  download(job: Job): Observable<Blob> {
    return this.docsSvc.downloadExport(job.id);
  }

  /**
   * Clear `busy` however the stream ends.
   *
   * `map` only runs on the value channel, so an HTTP error left the flag stuck
   * on — and every one of these operations is metered (§16), so the *expected*
   * path to a stuck panel was a guest's sixth export returning 429. The facade
   * is `providedIn: 'root'`, so the stuck flag then survived navigation and the
   * only way out was a page reload.
   */
  private finish(job$: Observable<Job>): Observable<Job> {
    return job$.pipe(
      map((job) => {
        if (job.status !== 'queued' && job.status !== 'running') this._busy.set(false);
        return job;
      }),
      finalize(() => this._busy.set(false)),
    );
  }
}
