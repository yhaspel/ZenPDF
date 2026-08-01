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

import { GuestFacade } from '../../abstraction/guest.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { UploadFacade } from '../../abstraction/upload.facade';
import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { ToolPageDef } from '../../core/tool-pages';
import { saveBlob } from '../../shared/save-blob';
import { UploadDropzone } from '../../shared/upload-dropzone';

type Phase = 'idle' | 'uploading' | 'running' | 'done' | 'error';

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
  imports: [UploadDropzone, RouterLink],
  templateUrl: './tool-page.html',
})
export class ToolPage {
  readonly tool = input.required<ToolPageDef>();

  private docsSvc = inject(DocumentsService);
  private uploads = inject(UploadFacade);
  private jobs = inject(JobsFacade);
  private router = inject(Router);
  private title = inject(Title);
  private meta = inject(Meta);
  private doc = inject(DOCUMENT);
  protected guests = inject(GuestFacade);

  protected phase = signal<Phase>('idle');
  protected error = signal('');
  protected results = signal<DocumentModel[]>([]);
  protected picked = signal<File[]>([]);

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
      next: () => this.uploadAll(),
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

  private dispatch(docs: DocumentModel[]): void {
    this.phase.set('running');
    const tool = this.tool();
    const primary = docs[0];

    if (tool.kind === 'organize') {
      // Organizing is inherently interactive — hand straight to the workspace.
      this.router.navigate(['/app/doc', primary.id]);
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
    this.error.set('');
    this.phase.set('idle');
  }

  sizeMb(bytes: number): string {
    return (bytes / 1048576).toFixed(1);
  }
}
