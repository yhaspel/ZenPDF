import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import {
  AuditEventModel,
  SIGN_STATUS_LABELS,
  SignRequestModel,
  SignRequestStatus,
} from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { saveBlob } from '../../shared/save-blob';
import { ToastService } from '../../shared/toast.service';

/**
 * What happened to a request I sent (phase-08 §8B owner side).
 *
 * The audit tab is the point of this screen: it prints the chain and says
 * whether it verifies, because "we logged it" and "the log is intact" are
 * different claims and only the second one is worth anything.
 */
@Component({
  selector: 'app-request-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './request-detail.html',
})
export class RequestDetail {
  /** `canceled_by_abuse` is not a phrase to show somebody about their own
   *  contract. */
  protected statusLabel(status: SignRequestStatus): string {
    return SIGN_STATUS_LABELS[status] ?? status;
  }

  private route = inject(ActivatedRoute);
  private esign = inject(EsignService);
  private toast = inject(ToastService);

  protected request = signal<SignRequestModel | null>(null);
  protected events = signal<AuditEventModel[]>([]);
  protected chain = signal<{ intact: boolean; count: number; head?: string } | null>(null);
  protected tab = signal<'status' | 'audit'>('status');
  protected busy = signal(false);

  constructor() {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    this.load(id);
  }

  private load(id: string): void {
    this.esign.getRequest(id).subscribe({
      next: (row) => this.request.set(row),
      error: () => this.toast.error('That request could not be opened.'),
    });
    this.esign.audit(id).subscribe({
      next: (body) => {
        this.events.set(body.events);
        this.chain.set(body.chain);
      },
      error: () => this.events.set([]),
    });
  }

  protected remind(): void {
    const request = this.request();
    if (!request) return;
    this.busy.set(true);
    this.esign.remind(request.id).subscribe({
      next: (body) => {
        this.busy.set(false);
        if (body.reminded.length) {
          this.toast.success(`Nudged ${body.reminded.join(', ')}`);
        } else {
          this.toast.info('Everyone waiting was emailed within the last day.');
        }
      },
      error: () => {
        this.busy.set(false);
        this.toast.error('Could not send that reminder.');
      },
    });
  }

  protected cancel(): void {
    const request = this.request();
    if (!request) return;
    this.busy.set(true);
    this.esign.cancelRequest(request.id).subscribe({
      next: (row) => {
        this.request.set(row);
        this.busy.set(false);
        this.toast.info('Canceled. The links no longer work.');
      },
      error: () => {
        this.busy.set(false);
        this.toast.error('Could not cancel that.');
      },
    });
  }

  protected download(what: 'final' | 'certificate'): void {
    const request = this.request();
    if (!request) return;
    this.esign.download(request.id, what).subscribe({
      next: (blob) => saveBlob(blob, what === 'final'
        ? `${request.title}.pdf`
        : `Certificate ${request.envelope_code}.pdf`),
      error: () => this.toast.error('That file is not ready yet.'),
    });
  }

  protected detail(event: AuditEventModel): string {
    return Object.entries(event.metadata || {})
      .map(([key, value]) => `${key}=${value}`)
      .join(', ');
  }
}
