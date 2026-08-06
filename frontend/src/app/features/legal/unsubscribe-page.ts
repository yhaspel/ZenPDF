import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { environment } from '../../../environments/environment';

/**
 * `/unsubscribe/:token` (§9B).
 *
 * One click, no login, no "are you sure", no survey. The token in the mail is
 * the authority; asking somebody to sign in to stop receiving mail is how you
 * get reported as spam instead.
 */
@Component({
  selector: 'app-unsubscribe-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <main class="flex min-h-dvh items-center justify-center p-6"
          data-test="unsubscribe-page">
      <div class="card pad-6 w-full max-w-sm">
        @switch (state()) {
          @case ('done') {
            <h1 class="!text-lg" data-test="unsubscribe-done">
              You will not hear from us again
            </h1>
            <p class="muted mt-2 text-sm">
              {{ email() }} has been removed from our mail. Documents already sent
              to you still work — this only stops the emails.
            </p>
          }
          @case ('error') {
            <h1 class="!text-lg">That link did not work</h1>
            <p class="muted mt-2 text-sm">
              It may have been altered on the way. Forward the message to the
              address in its footer and we will remove you by hand.
            </p>
          }
          @default {
            <div class="breath">
              <div class="breath-dot" aria-hidden="true"></div>
              <p>One moment…</p>
            </div>
          }
        }
        <p class="mt-6 text-[12.5px]">
          <a routerLink="/">ZenPDF</a>
        </p>
      </div>
    </main>
  `,
})
export class UnsubscribePage {
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);

  protected state = signal<'working' | 'done' | 'error'>('working');
  protected email = signal('');

  constructor() {
    const token = this.route.snapshot.paramMap.get('token') ?? '';
    this.http.post<{ unsubscribed: boolean; email: string }>(
      `${environment.apiUrl}/mail/unsubscribe/`, { token },
    ).subscribe({
      next: (body) => {
        this.email.set(body.email);
        this.state.set('done');
      },
      error: () => this.state.set('error'),
    });
  }
}
