import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { ConvertFacade } from '../../abstraction/convert.facade';
import { ExportFormat, Job } from '../../core/models/models';
import { ConfirmService } from '../../shared/confirm.service';
import { saveBlob } from '../../shared/save-blob';
import { ToastService } from '../../shared/toast.service';

/** The packs the worker image ships (phase-06). */
export const OCR_LANGUAGES: { code: string; label: string }[] = [
  { code: 'eng', label: 'English' },
  { code: 'heb', label: 'Hebrew' },
  { code: 'deu', label: 'German' },
  { code: 'fra', label: 'French' },
  { code: 'spa', label: 'Spanish' },
];

/**
 * Convert mode (phase-06): OCR in, six formats out, repair.
 *
 * One panel rather than three dialogs, because they are the same decision from
 * the user's side — "turn this document into something else" — and because all
 * three are metered (§16), so seeing them together is seeing the budget.
 */
@Component({
  selector: 'app-convert',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './convert.html',
})
export class Convert {
  readonly docId = input.required<string>();
  readonly currentSeq = input<number | null>(null);
  /** True when the document has no text layer — the OCR panel leads with it. */
  readonly isScanned = input(false);

  readonly saved = output<Job>();
  readonly conflict = output<void>();

  protected convert = inject(ConvertFacade);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);
  private destroyRef = inject(DestroyRef);

  protected readonly languages = OCR_LANGUAGES;
  protected readonly formats = this.convert.exportFormats;

  protected chosenLanguages = signal<string[]>(['eng']);
  protected deskew = signal(false);
  protected rotatePages = signal(false);
  protected clean = signal(false);
  protected force = signal(false);

  protected imageDpi = signal(150);
  protected imageFormat = signal<'png' | 'jpg'>('png');
  protected pendingFormat = signal<ExportFormat | null>(null);

  protected readonly busy = computed(() => this.convert.busy());

  constructor() {
    // The facade is a root singleton, so without this the panel kept offering
    // "Download report.txt" after the user moved to another document — and
    // after a failed second export, the *previous* one stayed on offer.
    let lastDoc = '';
    effect(() => {
      const id = this.docId();
      if (id === lastDoc) return;
      lastDoc = id;
      this.convert.reset();
      this.pendingFormat.set(null);
    });
  }

  protected toggleLanguage(code: string): void {
    this.chosenLanguages.update((chosen) =>
      chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code],
    );
  }

  protected isChosen(code: string): boolean {
    return this.chosenLanguages().includes(code);
  }

  protected runOcr(): void {
    const languages = this.chosenLanguages();
    if (!languages.length) {
      this.toast.info('Choose at least one language');
      return;
    }
    this.convert.ocr(this.docId(), this.currentSeq(), {
      languages,
      deskew: this.deskew(),
      rotate_pages: this.rotatePages(),
      clean: this.clean(),
      force: this.force(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => this.onJob(job, 'Text recognised — it is now selectable and editable'),
      error: () => this.fail(),
    });
  }

  protected runExport(format: ExportFormat): void {
    this.pendingFormat.set(format);
    this.convert.exportAs(this.docId(), this.currentSeq(), format, {
      dpi: this.imageDpi(),
      imageFormat: this.imageFormat(),
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (job) => {
        if (job.status === 'succeeded') {
          this.toast.success('Ready to download');
        } else if (job.status === 'failed') {
          this.pendingFormat.set(null);
          this.failure(job);
        }
      },
      error: () => {
        this.pendingFormat.set(null);
        this.fail();
      },
    });
  }

  protected downloadExport(): void {
    const job = this.convert.lastExport();
    if (!job) return;
    this.convert.download(job).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (blob) => saveBlob(blob, this.convert.exportName() || 'export'),
      error: () => this.toast.error(
        'That download has expired. Run the export again.',
      ),
    });
  }

  protected async runRepair(): Promise<void> {
    if (!(await this.confirm.ask(
      'Rebuild this document’s internal structure? The pages and text are '
      + 'untouched; a new version is created either way.', 'Repair',
    ))) return;
    this.convert.repair(this.docId(), this.currentSeq())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (job) => this.onJob(job, 'Document repaired'),
      error: () => this.fail(),
    });
  }

  private onJob(job: Job, label: string): void {
    if (job.status === 'succeeded') {
      this.toast.success(label);
      this.saved.emit(job);
    } else if (job.status === 'failed') {
      this.failure(job);
    }
  }

  private failure(job: Job): void {
    if (job.error_code === 'version_conflict') {
      this.toast.info('Document changed — refreshed');
      this.conflict.emit();
      return;
    }
    if (job.error_code === 'already_ocred') {
      this.toast.error(job.error_message || 'This document already has text.');
      this.force.set(true);
      return;
    }
    this.toast.error(job.error_message || 'That did not work');
  }

  private fail(): void {
    this.toast.error('That did not work');
  }
}
