import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';

import { ConvertFacade } from '../../abstraction/convert.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { UploadFacade } from '../../abstraction/upload.facade';
import { apiError } from '../../core/api-error';
import { DocumentModel, Job } from '../../core/models/models';
import { formatPages, parsePageSpec, toIndices, uniquePages } from '../../core/page-spec';
import { DocumentsService } from '../../core/services/documents.service';
import { SITE_URL, setCanonical } from '../../core/site';
import { ToolPageDef } from '../../core/tool-pages';
import { saveBlob } from '../../shared/save-blob';
import { AdSlot } from '../../shared/ad-slot';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';
import { UploadDropzone } from '../../shared/upload-dropzone';

type Phase = 'idle' | 'uploading' | 'running' | 'done' | 'error';

/** Tools whose input is not a PDF, so it is parked and converted (phase-06). */
const IMPORT_KINDS = new Set(['word-to-pdf', 'jpg-to-pdf', 'html-to-pdf']);

/**
 * Tools that act on a *chosen* set of pages, so the page field is part of the
 * widget (§4, options row). Both shipped acting on page 1 and nothing else,
 * which made each of them a one-page tool wearing a plural name.
 */
const PAGE_SELECT_KINDS = new Set(['extract-pages', 'delete-pages']);

/**
 * A public, server-rendered tool page that **is** the tool (§21.6).
 *
 * Dropzone above the fold, no login prompt anywhere in the path, result
 * downloadable in place with an "open in workspace" continuation. Organic
 * search is the acquisition channel an ad-funded product depends on, so each
 * page carries its own title/meta/H1 and FAQ + SoftwareApplication JSON-LD.
 */
@Component({
  selector: 'app-tool-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdSlot, UploadDropzone, RouterLink, SiteFooter, Brand, ThemeToggle],
  templateUrl: './tool-page.html',
})
export class ToolPage {
  readonly tool = input.required<ToolPageDef>();

  private docsSvc = inject(DocumentsService);
  private uploads = inject(UploadFacade);
  private jobs = inject(JobsFacade);
  private convert = inject(ConvertFacade);
  private router = inject(Router);
  private title = inject(Title);
  private meta = inject(Meta);
  private doc = inject(DOCUMENT);
  protected guests = inject(GuestFacade);
  private destroyRef = inject(DestroyRef);

  protected phase = signal<Phase>('idle');
  protected error = signal('');
  protected results = signal<DocumentModel[]>([]);
  protected picked = signal<File[]>([]);
  /** Set when the tool produced a downloadable file rather than a document. */
  protected exportJob = signal<Job | null>(null);

  /** 0–100 when the polled job reports progress; null when it has none yet. */
  protected runningProgress = signal<number | null>(null);

  /** What the visitor typed into the page field: "1, 3, 5-8". */
  protected pageSpec = signal('');
  /** Extract only: one file holding the selection, or one file per page. */
  protected extractMode = signal<'together' | 'separate'>('together');
  /**
   * The uploaded document's page count, known only once it is uploaded — so a
   * selection is checked against the real document at run time, and the hint
   * can name the count on the next attempt.
   */
  protected pageCount = signal<number | null>(null);
  /**
   * The document the picked file already became. A refused selection — page 9
   * of a 7-page file — is corrected and run again, and without this the same
   * file was uploaded a second time: the visitor's bandwidth twice, and two
   * copies against a guest's storage quota, for one attempt.
   */
  private uploaded = signal<{ file: File; doc: DocumentModel } | null>(null);

  protected readonly needsPages = computed(() => PAGE_SELECT_KINDS.has(this.tool().kind));
  protected readonly pageSelection = computed(() => parsePageSpec(this.pageSpec()));
  /** The parse error, shown only once there is something to be wrong about. */
  protected readonly pageError = computed(() => this.pageSelection().error);

  protected readonly ready = computed(() => {
    if (this.picked().length < this.tool().minFiles) return false;
    if (!this.needsPages()) return true;
    const selection = this.pageSelection();
    return !selection.error && selection.pages.length > 0;
  });
  protected readonly busy = computed(() =>
    ['uploading', 'running'].includes(this.phase()),
  );

  /** The breath's counting copy (design contract §3): a calm progressive verb,
   *  with the job's own progress when the poll reports one. */
  protected readonly workingCopy = computed(() => {
    if (this.phase() === 'uploading') {
      const n = this.picked().length;
      return n > 1 ? `Uploading ${n} files…` : 'Uploading…';
    }
    const verbs: Partial<Record<string, string>> = {
      merge: 'Merging',
      split: 'Splitting',
      compress: 'Compressing',
      rotate: 'Rotating',
      'delete-pages': 'Removing pages',
      'extract-pages': 'Extracting pages',
      organize: 'Reordering',
      watermark: 'Adding the watermark',
      'page-numbers': 'Numbering pages',
      ocr: 'Reading the scan',
      'pdf-to-word': 'Converting',
      'word-to-pdf': 'Converting',
      'jpg-to-pdf': 'Converting',
      'pdf-to-jpg': 'Converting',
      'html-to-pdf': 'Converting',
      repair: 'Repairing',
      protect: 'Protecting',
      unlock: 'Unlocking',
    };
    const verb = verbs[this.tool().kind] ?? 'Working on it';
    const progress = this.runningProgress();
    return progress && progress > 0 && progress < 100
      ? `${verb}… ${Math.round(progress)}%`
      : `${verb}…`;
  });

  /** The hanko marks completions only (§1): MERGED for the merge, DONE else. */
  protected readonly stampWord = computed(() =>
    this.tool().kind === 'merge' ? 'Merged' : 'Done',
  );

  /** One calm sentence beside the stamp (§4 tool page). */
  protected readonly summary = computed(() => {
    if (this.tool().kind === 'merge') {
      const n = this.picked().length;
      return n === 2 ? 'Two files became one.' : `${n} files became one.`;
    }
    if (this.exportJob()) return 'Converted and ready to download.';
    const n = this.results().length;
    if (this.needsPages()) {
      // Say which pages, because the whole point of the change is that the
      // visitor chose them: "Done." is what the tool said when it took page 1.
      const chosen = uniquePages(this.pageSelection().pages);
      const noun = chosen.length === 1 ? 'Page' : 'Pages';
      const list = formatPages(chosen);
      if (this.tool().kind === 'delete-pages') return `${noun} ${list} removed.`;
      return n > 1 ? `${noun} ${list} — ${n} separate files.` : `${noun} ${list} extracted.`;
    }
    return n > 1 ? `${n} files are ready.` : 'Done.';
  });

  /** The page field's label — the verb differs, the field does not. */
  protected readonly pageFieldLabel = computed(() =>
    this.tool().kind === 'delete-pages' ? 'Pages to delete' : 'Pages to extract',
  );

  /** Its hint, which names the real page count once a document has been read. */
  protected readonly pageFieldHint = computed(() => {
    const total = this.pageCount();
    const how = 'Page numbers and ranges, in any order — 1, 3, 5-8.';
    if (!total) return how;
    return `${how} This PDF has ${total} ${total === 1 ? 'page' : 'pages'}.`;
  });

  constructor() {
    // Runs on the server too, so the crawler sees the real title/meta.
    queueMicrotask(() => this.applySeo());
  }

  private applySeo(): void {
    const tool = this.tool();
    this.title.setTitle(tool.title);
    this.meta.updateTag({ name: 'description', content: tool.metaDescription });
    this.meta.updateTag({ property: 'og:title', content: tool.title });
    this.meta.updateTag({ property: 'og:description', content: tool.metaDescription });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    // `SITE_URL`, never `document.location`: these pages are prerendered, where
    // that is Angular's synthetic `http://ng-localhost` — which is what every
    // canonical in the served HTML used to say.
    const canonical = `${SITE_URL}/${tool.slug}`;
    setCanonical(this.doc, this.meta, canonical);
    this.setJsonLd(tool, canonical);
  }

  private setJsonLd(tool: ToolPageDef, canonical: string): void {
    const payload = [
      {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: tool.h1,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Any',
        url: canonical,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: tool.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ];
    const id = 'zen-tool-jsonld';
    this.doc.getElementById(id)?.remove();
    const script = this.doc.createElement('script');
    script.id = id;
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(payload);
    this.doc.head.appendChild(script);
  }

  // --- the tool itself ---
  onFilesPicked(files: File[]): void {
    const tool = this.tool();
    this.picked.set(tool.multiple ? [...this.picked(), ...files] : files.slice(0, 1));
    this.error.set('');
    this.phase.set('idle');
    // Both belonged to the file that was here before it.
    this.pageCount.set(null);
    this.uploaded.set(null);
  }

  onPageSpec(event: Event): void {
    this.pageSpec.set((event.target as HTMLInputElement).value);
    if (this.phase() === 'error') {
      this.phase.set('idle');
      this.error.set('');
    }
  }

  removeFile(index: number): void {
    this.picked.update((files) => files.filter((_, i) => i !== index));
  }

  run(): void {
    if (!this.ready() || this.busy()) return;
    this.phase.set('uploading');
    this.error.set('');
    this.results.set([]);
    this.runningProgress.set(null);

    // Mint the guest session *before* uploading in parallel. Minting is
    // per-request, so two concurrent tokenless uploads would create two
    // sessions — and a merge across them would then see only one file (§21.2).
    this.guests.ensureSession().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => (IMPORT_KINDS.has(this.tool().kind) ? this.importAll() : this.uploadAll()),
      error: (err) => this.fail(err),
    });
  }

  private uploadAll(): void {
    const files = this.picked();
    /**
     * A slot per file, filled at the file's own index.
     *
     * The uploads run concurrently and `push` recorded whichever *finished*
     * first, so `document_ids` went to the server in network order — and
     * `tasks.py` merges strictly positionally. Add a 20 MB chapter and then a
     * 200 KB cover and the cover merged second, non-deterministically, against
     * the promise this very page makes: "Page order follows the order you add
     * the files." `/compare` shared the race, where it can invert the diff.
     */
    const uploaded: (DocumentModel | null)[] = files.map(() => null);
    let remaining = files.length;

    // Re-running the same single file after a refused selection: it is already
    // on the server, unchanged, and this session still owns it.
    const already = this.uploaded();
    if (already && this.needsPages() && files.length === 1 && files[0] === already.file) {
      this.dispatch([already.doc]);
      return;
    }

    files.forEach((file, index) => {
      this.docsSvc.upload(file).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (event) => {
          const body = (event as { body?: DocumentModel }).body;
          if (body?.id) {
            uploaded[index] = body;
            if (this.needsPages() && files.length === 1) this.uploaded.set({ file, doc: body });
            if (--remaining === 0) this.dispatch(uploaded.filter((d): d is DocumentModel => !!d));
          }
        },
        error: (err) => this.fail(err),
      });
    });
  }

  /**
   * Import tools (`word-to-pdf`, `jpg-to-pdf`, `html-to-pdf`) never touch the
   * document upload endpoint: the file is not a PDF, so ingest would reject it.
   * It is parked as a conversion source and turned into a document by
   * `convert_from` (phase-06).
   */
  private importAll(): void {
    const files = this.picked();
    this.phase.set('running');
    // Several images are ONE document, a page each — which is what
    // `/jpg-to-pdf` promises. One conversion per file gave N one-page
    // documents, showed whichever finished first, and orphaned the rest.
    const job$ = files.length > 1
      ? this.convert.importImages(files)
      : this.convert.importFile(files[0]);
    job$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => {
        if (typeof job.progress === 'number') this.runningProgress.set(job.progress);
        if (job.status === 'succeeded') {
          this.onSuccess(job);
        } else if (job.status === 'failed') {
          this.phase.set('error');
          this.error.set(job.error_message || 'That file could not be converted.');
        }
      },
      error: (err) => this.fail(err),
    });
  }

  private dispatch(docs: DocumentModel[]): void {
    this.phase.set('running');
    const tool = this.tool();
    const primary = docs[0];

    // Compare needs two documents and a place to show the result; the answer is
    // a report, not a file, so the workspace is the only sensible destination.
    if (tool.kind === 'compare') {
      this.router.navigate(['/app/doc', primary.id], {
        queryParams: { mode: 'compare', other: docs[1]?.id },
      });
      return;
    }

    // Export tools produce a downloadable artefact rather than a new document.
    const exports: Partial<Record<typeof tool.kind, { format: string; extra?: object }>> = {
      'pdf-to-word': { format: 'docx' },
      'pdf-to-jpg': { format: 'images', extra: { image_format: 'jpg', dpi: 150 } },
    };
    const wanted = exports[tool.kind];
    if (wanted) {
      this.trackExport(primary, wanted.format, wanted.extra ?? {});
      return;
    }

    // Inherently interactive tools: there is no "one click and download"
    // version of arranging pages, marking a document up or rewriting its text.
    // Hand straight to the workspace, opened on the right mode — still with no
    // login anywhere in the path.
    const interactive: Partial<Record<typeof tool.kind, Record<string, string>>> = {
      // Every other entry here names the mode its tool exists for. `organize`
      // was the one that did not, so "Organize pages" — the tool whose whole
      // subject is the page grid — dropped the visitor into the reading view
      // with the grid one unexplained click away.
      organize: { mode: 'organize' },
      annotate: { mode: 'annotate' },
      edit: { mode: 'edit' },
      'fill-form': { mode: 'forms' },
      // Phase 7. None of these can run unattended: two need a password the
      // user has not given yet, and redaction must show what it found before
      // it removes anything.
      protect: { mode: 'protect' },
      unlock: { mode: 'protect' },
      redact: { mode: 'protect', tab: 'redact' },
      // Phase 8: self-sign is the no-account path this page advertises.
      sign: { mode: 'sign' },
    };
    if (tool.kind in interactive) {
      this.router.navigate(['/app/doc', primary.id], {
        queryParams: interactive[tool.kind],
      });
      return;
    }
    if (tool.kind === 'merge') {
      this.track(
        this.docsSvc.crossOperation({
          type: 'merge',
          params: { document_ids: docs.map((d) => d.id) },
        }),
      );
      return;
    }

    // The page tools run on what the visitor typed above the button. Their
    // pages are checked against the document here rather than earlier, because
    // this is the first moment its real page count is known.
    if (this.needsPages()) {
      this.dispatchPages(tool.kind, primary);
      return;
    }

    const single: Record<string, { type: string; params: unknown }> = {
      split: { type: 'split', params: { mode: 'every_n', every_n: 1 } },
      compress: { type: 'compress', params: { preset: 'balanced' } },
      rotate: { type: 'rotate_pages', params: { pages: this.allPages(primary), degrees: 90 } },
      // Phase 4's two one-shot tools run with sensible defaults here and offer
      // the workspace for anything finer.
      watermark: { type: 'watermark', params: { text: 'DRAFT', under: true, opacity: 0.25 } },
      'page-numbers': { type: 'page_numbers', params: { position: 'bottom-center', format: '{page}' } },
      // Phase 6's two one-shot document tools. OCR defaults to English here and
      // offers the full language list in the workspace.
      ocr: { type: 'ocr', params: { languages: ['eng'] } },
      repair: { type: 'repair', params: {} },
    };
    const op = single[tool.kind];
    this.track(
      this.docsSvc.operation(primary.id, {
        ...op,
        base_version_seq: primary.current_version?.seq ?? null,
      }),
      primary,
    );
  }

  /**
   * Extract and delete, on the pages the visitor chose (1-based on screen,
   * 0-based over the wire — §8). A selection that reaches past the end of the
   * document is refused here with the count in the sentence: the engine's own
   * "page 11 out of range (0..6)" is true and useless.
   */
  private dispatchPages(kind: string, doc: DocumentModel): void {
    const total = doc.page_count;
    this.pageCount.set(total || null);
    const pages = this.pageSelection().pages;
    const beyond = total ? pages.filter((page) => page > total) : [];
    if (beyond.length) {
      this.phase.set('error');
      this.error.set(
        `This PDF has ${total} ${total === 1 ? 'page' : 'pages'}, so there is no page ` +
          `${beyond[0]}. Change the selection and run it again.`,
      );
      return;
    }
    const base = doc.current_version?.seq ?? null;

    if (kind === 'delete-pages') {
      // Deleting is a set, not a sequence: asking twice for page 3 deletes one
      // page, and the order it was typed in cannot matter.
      const unique = uniquePages(pages).sort((a, b) => a - b);
      if (total && unique.length >= total) {
        this.phase.set('error');
        this.error.set('That would delete every page, and a PDF has to keep at least one.');
        return;
      }
      this.track(
        this.docsSvc.operation(doc.id, {
          type: 'delete_pages',
          params: { pages: toIndices(unique) },
          base_version_seq: base,
        }),
        doc,
      );
      return;
    }

    // Extract keeps the order it was given — "9, 2, 40" is a running order, not
    // a set — and `separate` decides whether that is one file or one per page.
    this.track(
      this.docsSvc.operation(doc.id, {
        type: 'extract_pages',
        params: {
          pages: toIndices(pages),
          as_new_document: true,
          separate: this.extractMode() === 'separate',
        },
        base_version_seq: base,
      }),
    );
  }

  private allPages(doc: DocumentModel): number[] {
    return Array.from({ length: Math.max(1, doc.page_count) }, (_, i) => i);
  }

  private track(create$: ReturnType<DocumentsService['operation']>, fallback?: DocumentModel) {
    this.jobs.dispatch(create$)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (job: Job) => {
        if (typeof job.progress === 'number') this.runningProgress.set(job.progress);
        if (job.status === 'succeeded') {
          this.onSuccess(job, fallback);
        } else if (job.status === 'failed') {
          this.phase.set('error');
          this.error.set(job.error_message || 'That did not work. Try again.');
        }
      },
      error: (err) => this.fail(err),
    });
  }

  private onSuccess(job: Job, fallback?: DocumentModel): void {
    const ids = (job.result?.['documents'] as string[]) ?? [];
    const target = ids.length ? ids : fallback ? [fallback.id] : [];
    if (!target.length) {
      this.phase.set('error');
      this.error.set('The operation finished but produced nothing to download.');
      return;
    }
    let remaining = target.length;
    const docs: DocumentModel[] = [];
    target.forEach((id, i) => {
      this.docsSvc.get(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (d) => {
          // Slot, not push: the fetches race, and for "a separate PDF for each
          // page" the rows must read in page order, not network order. Split's
          // parts had the same race.
          docs[i] = d;
          if (--remaining === 0) {
            this.results.set(docs);
            this.phase.set('done');
          }
        },
        error: (err) => this.fail(err),
      });
    });
  }

  private trackExport(doc: DocumentModel, format: string, extra: object): void {
    this.jobs.dispatch(
      this.docsSvc.operation(doc.id, {
        type: 'convert_to',
        params: { format, ...extra },
        base_version_seq: doc.current_version?.seq ?? null,
      }),
    ).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => {
        if (typeof job.progress === 'number') this.runningProgress.set(job.progress);
        if (job.status === 'succeeded') {
          this.exportJob.set(job);
          this.results.set([doc]);
          this.phase.set('done');
        } else if (job.status === 'failed') {
          this.phase.set('error');
          this.error.set(job.error_message || 'That conversion did not work.');
        }
      },
      error: (err) => this.fail(err),
    });
  }

  /** What each import tool's dropzone offers — see `UploadDropzone.accept`. */
  acceptFor(kind: string): string {
    if (kind === 'word-to-pdf') {
      return '.doc,.docx,.odt,.rtf,.txt,.xls,.xlsx,.ods,.csv,.ppt,.pptx,.odp';
    }
    if (kind === 'jpg-to-pdf') return 'image/*,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.gif,.webp';
    if (kind === 'html-to-pdf') return '.html,.htm,text/html';
    return 'application/pdf,.pdf';
  }

  promptFor(kind: string): string {
    if (kind === 'word-to-pdf') return 'Drop a document here, or click to browse';
    if (kind === 'jpg-to-pdf') return 'Drop images here, or click to browse';
    if (kind === 'html-to-pdf') return 'Drop an HTML file here, or click to browse';
    return 'Drop PDFs here, or click to browse';
  }

  hintFor(kind: string): string {
    if (kind === 'word-to-pdf') return 'Word, Excel, PowerPoint, OpenDocument, RTF or text';
    if (kind === 'jpg-to-pdf') return 'JPG, PNG, TIFF, BMP, GIF or WebP — several become one PDF';
    if (kind === 'html-to-pdf') return 'An .html or .htm file';
    return 'Only PDF files are accepted';
  }

  /** The converted file's name, for the download button. */
  convertedName(): string {
    const info = this.exportJob()?.result?.['export'] as { filename?: string } | undefined;
    return info?.filename ?? 'converted file';
  }

  /** The converted file, when the tool produced one instead of a document. */
  downloadConverted(): void {
    const job = this.exportJob();
    if (!job) return;
    const info = job.result?.['export'] as { filename?: string } | undefined;
    this.convert.download(job).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => saveBlob(blob, info?.filename ?? 'converted'),
      error: () => this.error.set('That download has expired. Convert it again.'),
    });
  }

  private fail(err: unknown): void {
    this.phase.set('error');
    this.error.set(apiError(err).message ?? 'Something went wrong. Try again.');
    // The cached upload may be the reason — a guest session that expired takes
    // its documents with it, and a cached id then 404s on every retry. Dropped,
    // the next run starts clean with a fresh upload instead of failing forever.
    this.uploaded.set(null);
  }

  download(doc: DocumentModel): void {
    this.docsSvc.download(doc.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => saveBlob(blob, `${doc.title}.pdf`),
      error: () => this.error.set('Download failed.'),
    });
  }

  openInWorkspace(doc: DocumentModel): void {
    this.router.navigate(['/app/doc', doc.id]);
  }

  reset(): void {
    this.picked.set([]);
    this.results.set([]);
    this.exportJob.set(null);
    this.error.set('');
    this.phase.set('idle');
    // The selection stays — "do another one" is usually the same pages out of
    // the next file — but the page count and the uploaded copy belonged to the
    // file just finished.
    this.pageCount.set(null);
    this.uploaded.set(null);
  }

  /**
   * A file's size, in the unit that tells you something about it.
   *
   * Everything was rendered in megabytes to one decimal, so a 40 KB signature
   * page, a 900 KB contract and an empty file all read "0.0 MB" — the size
   * line said nothing at all for most of what people actually upload here.
   */
  fileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return `${Math.max(bytes, 0)} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    const mb = bytes / 1048576;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
}
