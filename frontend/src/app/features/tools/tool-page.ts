import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { Router, RouterLink } from '@angular/router';

import { ConvertFacade } from '../../abstraction/convert.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { UploadFacade } from '../../abstraction/upload.facade';
import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ToolPageDef } from '../../core/tool-pages';
import { saveBlob } from '../../shared/save-blob';
import { AdSlot } from '../../shared/ad-slot';
import { SiteFooter } from '../../shared/site-footer';
import { UploadDropzone } from '../../shared/upload-dropzone';

type Phase = 'idle' | 'uploading' | 'running' | 'done' | 'error';

/** Tools whose input is not a PDF, so it is parked and converted (phase-06). */
const IMPORT_KINDS = new Set(['word-to-pdf', 'jpg-to-pdf', 'html-to-pdf']);

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
  imports: [AdSlot, UploadDropzone, RouterLink, SiteFooter],
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

  protected phase = signal<Phase>('idle');
  protected error = signal('');
  protected results = signal<DocumentModel[]>([]);
  protected picked = signal<File[]>([]);
  /** Set when the tool produced a downloadable file rather than a document. */
  protected exportJob = signal<Job | null>(null);

  protected readonly ready = computed(() => this.picked().length >= this.tool().minFiles);
  protected readonly busy = computed(() =>
    ['uploading', 'running'].includes(this.phase()),
  );

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
    const canonical = `${this.origin()}/${tool.slug}`;
    this.meta.updateTag({ property: 'og:url', content: canonical });
    this.setCanonical(canonical);
    this.setJsonLd(tool, canonical);
  }

  private origin(): string {
    const loc = this.doc.location;
    return loc ? `${loc.protocol}//${loc.host}` : '';
  }

  private setCanonical(href: string): void {
    let link = this.doc.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.doc.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.doc.head.appendChild(link);
    }
    link.setAttribute('href', href);
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
  }

  removeFile(index: number): void {
    this.picked.update((files) => files.filter((_, i) => i !== index));
  }

  run(): void {
    if (!this.ready() || this.busy()) return;
    this.phase.set('uploading');
    this.error.set('');
    this.results.set([]);

    // Mint the guest session *before* uploading in parallel. Minting is
    // per-request, so two concurrent tokenless uploads would create two
    // sessions — and a merge across them would then see only one file (§21.2).
    this.guests.ensureSession().subscribe({
      next: () => (IMPORT_KINDS.has(this.tool().kind) ? this.importAll() : this.uploadAll()),
      error: (err) => this.fail(err),
    });
  }

  private uploadAll(): void {
    const uploaded: DocumentModel[] = [];
    const files = this.picked();
    let remaining = files.length;

    for (const file of files) {
      this.docsSvc.upload(file).subscribe({
        next: (event) => {
          const body = (event as { body?: DocumentModel }).body;
          if (body?.id) {
            uploaded.push(body);
            if (--remaining === 0) this.dispatch(uploaded);
          }
        },
        error: (err) => this.fail(err),
      });
    }
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
    job$.subscribe({
      next: (job) => {
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
      organize: {},
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

    const single: Record<string, { type: string; params: unknown }> = {
      split: { type: 'split', params: { mode: 'every_n', every_n: 1 } },
      compress: { type: 'compress', params: { preset: 'balanced' } },
      rotate: { type: 'rotate_pages', params: { pages: this.allPages(primary), degrees: 90 } },
      'delete-pages': { type: 'delete_pages', params: { pages: [0] } },
      'extract-pages': {
        type: 'extract_pages',
        params: { pages: [0], as_new_document: true },
      },
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

  private allPages(doc: DocumentModel): number[] {
    return Array.from({ length: Math.max(1, doc.page_count) }, (_, i) => i);
  }

  private track(create$: ReturnType<DocumentsService['operation']>, fallback?: DocumentModel) {
    this.jobs.dispatch(create$).subscribe({
      next: (job: Job) => {
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
    for (const id of target) {
      this.docsSvc.get(id).subscribe({
        next: (d) => {
          docs.push(d);
          if (--remaining === 0) {
            this.results.set(docs);
            this.phase.set('done');
          }
        },
        error: (err) => this.fail(err),
      });
    }
  }

  private trackExport(doc: DocumentModel, format: string, extra: object): void {
    this.jobs.dispatch(
      this.docsSvc.operation(doc.id, {
        type: 'convert_to',
        params: { format, ...extra },
        base_version_seq: doc.current_version?.seq ?? null,
      }),
    ).subscribe({
      next: (job) => {
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
    if (kind === 'word-to-pdf') return 'Drop a document here or click to browse';
    if (kind === 'jpg-to-pdf') return 'Drop images here or click to browse';
    if (kind === 'html-to-pdf') return 'Drop an HTML file here or click to browse';
    return 'Drop PDFs here or click to browse';
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
    this.convert.download(job).subscribe({
      next: (blob) => saveBlob(blob, info?.filename ?? 'converted'),
      error: () => this.error.set('That download has expired. Convert it again.'),
    });
  }

  private fail(err: { error?: { error?: { message?: string } } }): void {
    this.phase.set('error');
    this.error.set(err?.error?.error?.message ?? 'Something went wrong. Try again.');
  }

  download(doc: DocumentModel): void {
    this.docsSvc.download(doc.id).subscribe({
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
  }

  sizeMb(bytes: number): string {
    return (bytes / 1048576).toFixed(1);
  }
}
