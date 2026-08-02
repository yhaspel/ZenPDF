import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { EsignFacade } from '../../abstraction/esign.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { Job, SavedSignature } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { OverlayDraft, OverlayItem } from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { ZenModal } from '../../shared/modal.directive';
import { SignaturePad } from '../../shared/signature-pad';
import { ToastService } from '../../shared/toast.service';

/**
 * "Sign myself" (phase-08 §8A).
 *
 * The acceptance criterion is a click count — *self-sign in under four clicks
 * from an open document* — so the panel opens with the signature dialog
 * already up when there is nothing to pick from. Draw, click the page, Apply:
 * three.
 */
@Component({
  selector: 'app-sign',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, PageOverlay, SignaturePad, ZenModal],
  templateUrl: './sign.html',
})
export class Sign {
  readonly docId = input.required<string>();
  readonly docTitle = input('');
  readonly pageCount = input(1);
  readonly currentSeq = input<number | null>(null);

  readonly saved = output<Job>();
  readonly conflict = output<void>();

  protected esign = inject(EsignFacade);
  protected guests = inject(GuestFacade);
  private esignSvc = inject(EsignService);
  private router = inject(Router);
  private toast = inject(ToastService);

  protected page = signal(0);
  protected zoom = signal(680);
  protected includeDate = signal(true);
  protected padOpen = signal(false);
  protected keepIt = signal(false);

  protected readonly isAccount = computed(() => this.guests.principal() === 'user');

  protected readonly overlayItems = computed<OverlayItem[]>(() =>
    this.esign.placements()
      .filter((p) => p.page === this.page())
      .map((p) => ({
        id: p.id,
        page: p.page,
        shape: 'rect' as const,
        rect: p.rect,
        stroke: '#4f46e5',
        fill: '#4f46e5',
        opacity: 0.12,
        width: 1,
        label: 'signature',
      })),
  );

  constructor() {
    effect(() => {
      this.docId();
      this.esign.reset();
      // Only for an account. A guest has no library, and *asking* raises the
      // app-wide `account_required` prompt — which would greet a visitor with
      // "create a free account" on a page whose own copy promises they do not
      // need one.
      if (this.guests.principal() === 'user') this.esign.loadSaved();
      // Nothing to pick from → the dialog *is* the first step, which is what
      // keeps the click count honest.
      this.padOpen.set(true);
    });
  }

  protected signatureUrl(row: SavedSignature): string {
    return this.esignSvc.signatureImageUrl(row.id);
  }

  protected choose(row: SavedSignature): void {
    this.esign.chooseSaved(row);
    this.padOpen.set(false);
  }

  protected onSignature(dataUrl: string): void {
    // Kept for reuse only when the user asked and has somewhere to keep it.
    if (this.keepIt() && this.isAccount()) {
      this.esign.save(dataUrl).subscribe({
        next: () => {
          this.padOpen.set(false);
          this.toast.success('Signature saved');
        },
        error: () => this.toast.error('Could not save that signature'),
      });
      return;
    }
    this.esign.useImage(dataUrl).subscribe({
      next: () => {
        this.padOpen.set(false);
        this.toast.info('Now click where it goes');
      },
      error: () => this.toast.error('Could not use that signature'),
    });
  }

  protected onPlaced(draft: OverlayDraft): void {
    if (!draft.rect) return;
    if (!this.esign.hasSignature()) {
      this.padOpen.set(true);
      return;
    }
    this.esign.place(draft.page, draft.rect);
  }

  protected onSelect(id: string | null): void {
    if (id) this.esign.unplace(id);
  }

  protected apply(): void {
    if (!this.esign.placements().length) {
      this.toast.info('Click the page where the signature goes');
      return;
    }
    this.esign.apply(this.docId(), this.currentSeq(), this.includeDate())
      .subscribe({
        next: (job) => {
          if (job.status === 'succeeded') {
            this.esign.clear();
            this.toast.success('Signed');
            this.saved.emit(job);
          } else if (job.status === 'failed') {
            this.fail(job);
          }
        },
        error: () => this.toast.error('That did not work'),
      });
  }

  protected sendForSignature(): void {
    this.router.navigate(['/app/sign/new', this.docId()]);
  }

  private fail(job: Job): void {
    if (job.error_code === 'version_conflict') {
      this.toast.info('Document changed — refreshed');
      this.conflict.emit();
      return;
    }
    if (job.error_code === 'account_required') {
      this.toast.info(job.error_message || 'That needs a free account');
      return;
    }
    this.toast.error(job.error_message || 'That did not work');
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount() - 1, p + 1));
  }
}
