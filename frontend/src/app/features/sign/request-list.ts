import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { SignRequestModel } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { EmptyState } from '../../shared/empty-state';

/** `/app/sign` — what I have sent out and where each one has got to (§7, 8B). */
@Component({
  selector: 'app-request-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, EmptyState],
  template: `
    <div class="mx-auto w-full max-w-3xl px-8 py-6" data-test="request-list">
      <a routerLink="/app/dashboard" class="text-sm">←
        Documents</a>
      <h1 class="mt-2 !text-[28px]">Sent for signature</h1>

      @if (loaded() && !requests().length) {
        <app-empty-state
          class="mt-6 block"
          title="Nothing sent yet."
          subtitle="Open a document and choose “Send for signature”."
          data-test="no-requests" />
      }

      <ul class="mt-4 flex flex-col gap-2">
        @for (request of requests(); track request.id) {
          <li class="card p-3" data-test="request-row">
            <a [routerLink]="['/app/sign', request.id]"
               class="flex flex-wrap items-center gap-2 !no-underline">
              <span class="text-ink font-medium">{{ request.title }}</span>
              <span class="faint text-xs">{{ request.envelope_code }}</span>
              <span class="badge ms-auto"
                    [class.badge-success]="request.status === 'completed'"
                    [class.badge-danger]="request.status === 'declined'"
                    [class.badge-warning]="request.status === 'expired'">
                {{ request.status }}
              </span>
            </a>
            <!-- Per-recipient chips, so "where has it got to" is answered
                 without opening anything (8B). -->
            <div class="mt-2 flex flex-wrap gap-1">
              @for (person of request.recipients; track person.id) {
                <span class="badge" data-test="recipient-chip">
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
