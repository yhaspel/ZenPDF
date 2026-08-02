import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { ConvertFacade } from '../../abstraction/convert.facade';
import { DocumentsFacade } from '../../abstraction/documents.facade';
import { FoldersFacade } from '../../abstraction/folders.facade';
import { JobsFacade } from '../../abstraction/jobs.facade';
import { UploadFacade, UploadItem } from '../../abstraction/upload.facade';
import { DocumentModel, Job } from '../../core/models/models';
import { DocumentsService } from '../../core/services/documents.service';
import { JobsService } from '../../core/services/jobs.service';
import { ConfirmService } from '../../shared/confirm.service';
import { EmptyState } from '../../shared/empty-state';
import { PdfThumbnail } from '../../shared/pdf-thumbnail';
import { saveBlob } from '../../shared/save-blob';
import { Spinner } from '../../shared/spinner';
import { ToastService } from '../../shared/toast.service';
import { UploadDropzone } from '../../shared/upload-dropzone';

/** Everything the conversion routes accept, for the dropzone's picker. */
const IMPORTABLE = 'application/pdf,.pdf,.doc,.docx,.odt,.rtf,.txt,.xls,.xlsx,'
  + '.ods,.csv,.ppt,.pptx,.odp,image/*,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.gif,'
  + '.webp,.html,.htm';

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, UploadDropzone, PdfThumbnail, EmptyState, Spinner],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  protected docs = inject(DocumentsFacade);
  protected folders = inject(FoldersFacade);
  protected upload = inject(UploadFacade);
  /** Surfaces what signing up just rescued — the payoff must not be silent. */
  protected auth = inject(AuthFacade);
  private jobs = inject(JobsFacade);
  protected convert = inject(ConvertFacade);
  private jobsSvc = inject(JobsService);
  private docsSvc = inject(DocumentsService);
  private router = inject(Router);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  protected menuId = signal<string | null>(null);
  protected editingId = signal<string | null>(null);
  protected editingTitle = signal('');
  protected selected = signal<string[]>([]);
  protected newFolder = signal('');
  /** Files and addresses currently being converted into PDFs. */
  protected importing = signal<string[]>([]);
  protected importUrl = signal('');
  protected readonly importable = IMPORTABLE;

  constructor() {
    this.docs.load();
    this.folders.load();
  }

  onSearch(): void {
    this.docs.load();
  }

  setFolder(id: string | null): void {
    this.docs.folder.set(id);
    this.docs.load();
  }

  toggleStarFilter(): void {
    this.docs.starred.set(!this.docs.starred());
    this.docs.load();
  }

  toggleTrash(): void {
    this.docs.trashed.set(!this.docs.trashed());
    this.selected.set([]);
    this.docs.load();
  }

  createFolder(): void {
    const name = this.newFolder().trim();
    if (name) {
      this.folders.create(name);
      this.newFolder.set('');
    }
  }

  /**
   * The dropzone takes anything we can turn into a PDF (phase-06: "import UX is
   * unified with upload"). PDFs are ingested; a Word file, a photograph or an
   * HTML page is parked and converted, which is the same gesture for the user
   * and two entirely different paths underneath.
   */
  onFilesPicked(files: File[]): void {
    const pdfs = files.filter((f) => isPdf(f));
    const others = files.filter((f) => !isPdf(f));
    if (pdfs.length) {
      this.upload.uploadFiles(pdfs, this.docs.folder(), () => {
        this.docs.load();
        this.toast.success('Uploaded');
      });
    }
    // Images dropped together become one document, a page each; anything else
    // is converted on its own, because a Word file and a spreadsheet have
    // nothing to combine.
    const images = others.filter((f) => f.type.startsWith('image/'));
    const rest = others.filter((f) => !f.type.startsWith('image/'));
    if (images.length > 1) {
      const label = `${images.length} images`;
      this.importing.update((names) => [...names, label]);
      this.convert.importImages(images).subscribe({
        next: (job) => this.onImported(job, label),
        error: (err) => this.failImport(label, err?.error?.error?.message),
      });
    } else {
      rest.push(...images);
    }
    for (const file of rest) {
      this.importing.update((names) => [...names, file.name]);
      this.convert.importFile(file).subscribe({
        next: (job) => this.onImported(job, file.name),
        error: (err) => this.failImport(file.name, err?.error?.error?.message),
      });
    }
  }

  importFromUrl(): void {
    const url = this.importUrl().trim();
    if (!url) return;
    this.importing.update((names) => [...names, url]);
    this.convert.importUrl(url).subscribe({
      next: (job) => {
        this.onImported(job, url);
        if (job.status === 'succeeded') this.importUrl.set('');
      },
      error: (err) => this.failImport(url, err?.error?.error?.message),
    });
  }

  private onImported(job: Job, label: string): void {
    if (job.status === 'succeeded') {
      this.importing.update((names) => names.filter((n) => n !== label));
      this.docs.load();
      this.toast.success('Converted to PDF');
    } else if (job.status === 'failed') {
      this.failImport(label, job.error_message);
    }
  }

  private failImport(label: string, message?: string): void {
    this.importing.update((names) => names.filter((n) => n !== label));
    this.toast.error(message || `Could not convert ${label}`);
  }

  retryRepair(item: UploadItem): void {
    this.upload.retryWithRepair(item, this.docs.folder(), () => {
      this.docs.load();
      this.toast.success('Repaired & uploaded');
    });
  }

  open(doc: DocumentModel): void {
    this.router.navigate(['/app/doc', doc.id]);
  }

  toggleMenu(id: string): void {
    this.menuId.set(this.menuId() === id ? null : id);
  }

  startRename(doc: DocumentModel): void {
    this.editingId.set(doc.id);
    this.editingTitle.set(doc.title);
    this.menuId.set(null);
  }

  commitRename(): void {
    const id = this.editingId();
    const title = this.editingTitle().trim();
    if (id && title) {
      this.docs.rename(id, title);
    }
    this.editingId.set(null);
  }

  download(doc: DocumentModel): void {
    this.menuId.set(null);
    this.docsSvc.download(doc.id).subscribe({
      next: (blob) => saveBlob(blob, `${doc.title}.pdf`),
      error: () => this.toast.error('Download failed'),
    });
  }

  async trash(doc: DocumentModel): Promise<void> {
    this.menuId.set(null);
    if (await this.confirm.ask(`Move “${doc.title}” to trash?`, 'Trash')) {
      this.docs.trash(doc.id);
      this.toast.info('Moved to trash');
    }
  }

  restore(doc: DocumentModel): void {
    this.docs.restore(doc.id);
    this.toast.success('Restored');
  }

  async purge(doc: DocumentModel): Promise<void> {
    if (await this.confirm.ask(`Permanently delete “${doc.title}”? This cannot be undone.`, 'Delete forever')) {
      this.docs.purge(doc.id);
      this.toast.info('Deleted');
    }
  }

  toggleSelect(doc: DocumentModel): void {
    this.selected.update((ids) =>
      ids.includes(doc.id) ? ids.filter((i) => i !== doc.id) : [...ids, doc.id],
    );
  }

  isSelected(id: string): boolean {
    return this.selected().includes(id);
  }

  mergeSelected(): void {
    const ids = this.selected();
    if (ids.length < 2) return;
    this.jobs.dispatch(this.docsSvc.crossOperation({ type: 'merge', params: { document_ids: ids } })).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          const newId = (job.result?.['documents'] as string[])?.[0];
          this.toast.success('Documents merged');
          this.selected.set([]);
          this.docs.load();
          if (newId) this.router.navigate(['/app/doc', newId]);
        } else if (job.status === 'failed') {
          this.toast.error(job.error_message || 'Merge failed');
        }
      },
      error: () => this.toast.error('Merge failed'),
    });
  }

  runDemoJob(): void {
    this.jobsSvc.demo().subscribe({
      next: (job) => {
        this.jobs.track(job.id).subscribe({
          next: (j) => {
            if (j.status === 'succeeded') this.toast.success('Demo job complete ✓');
            if (j.status === 'failed') this.toast.error('Demo job failed');
          },
        });
      },
      error: () => this.toast.error('Could not start demo job'),
    });
  }

  sizeMb(bytes: number): string {
    return (bytes / 1048576).toFixed(1);
  }
}
