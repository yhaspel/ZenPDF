import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { SignRequestModel } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';

/** `/app/sign` — what I have sent out and where each one has got to (§7, 8B). */
@Component({
  selector: 'app-request-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="mx-auto w-full max-w-3xl p-6" data-test="request-list">
      <a routerLink="/app/dashboard" class="text-sm text-slate-400 hover:text-slate-600">←
        Documents</a>
      <h1 class="mt-2 text-xl font-semibold text-slate-800">Sent for signature</h1>

      @if (loaded() && !requests().length) {
        <p class="mt-4 rounded border border-slate-200 bg-white p-4 text-sm text-slate-500"
           data-test="no-requests">
          Nothing sent yet. Open a document and choose “Send for signature”.
        </p>
      }

      <ul class="mt-4 flex flex-col gap-2">
        @for (request of requests(); track request.id) {
          <li class="rounded border border-slate-200 bg-white p-3" data-test="request-row">
            <a [routerLink]="['/app/sign', request.id]" class="flex flex-wrap items-center gap-2">
              <span class="font-medium text-slate-800">{{ request.title }}</span>
              <span class="text-xs text-slate-400">{{ request.envelope_code }}</span>
              <span class="ml-auto rounded-full px-2 py-0.5 text-xs"
                    [class.bg-emerald-50]="request.status === 'completed'"
                    [class.text-emerald-700]="request.status === 'completed'"
                    [class.bg-rose-50]="request.status === 'declined'"
                    [class.text-rose-700]="request.status === 'declined'"
                    [class.bg-slate-100]="request.status !== 'completed' && request.status !== 'declined'"
                    [class.text-slate-600]="request.status !== 'completed' && request.status !== 'declined'">
                {{ request.status }}
              </span>
            </a>
            <!-- Per-recipient chips, so "where has it got to" is answered
                 without opening anything (8B). -->
            <div class="mt-2 flex flex-wrap gap-1">
              @for (person of request.recipients; track person.id) {
                <span class="rounded-full bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500"
                      data-test="recipient-chip">
                  {{ person.name || person.email }} · {{ person.status }}
                </span>
              }
            </div>
          </li>
        }
      </ul>
    </div>
  `,
})
export class RequestList {
  private esign = inject(EsignService);

  protected requests = signal<SignRequestModel[]>([]);
  protected loaded = signal(false);

  constructor() {
    this.esign.listRequests().subscribe({
      next: (page) => {
        this.requests.set(page.results ?? []);
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
  }
}
