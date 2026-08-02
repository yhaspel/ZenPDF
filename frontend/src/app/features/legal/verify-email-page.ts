import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { environment } from '../../../environments/environment';

/**
 * `/verify-email/:token` (§9B).
 *
 * Open to anyone holding the token, because the link arrives in a mail client
 * that may not be the browser that is signed in — and asking somebody to log
 * in before they can prove they own the address is a circle.
 */
@Component({
  selector: 'app-verify-email-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="mx-auto w-full max-w-lg p-8" data-test="verify-email-page">
      @switch (state()) {
        @case ('done') {
          <h1 class="text-xl font-semibold text-slate-800" data-test="verified">
            Address confirmed
          </h1>
          <p class="mt-2 text-sm text-slate-600">
            {{ email() }} is verified. You can now send documents to other
            people for signature.
          </p>
          <a routerLink="/app/dashboard"
             class="mt-4 inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white">
            Back to your documents
          </a>
        }
        @case ('error') {
          <h1 class="text-xl font-semibold text-slate-800" data-test="verify-failed">
            That link has expired
          </h1>
          <p class="mt-2 text-sm text-slate-600">
            Verification links last a couple of days. Sign in and ask for a new
            one from your settings.
          </p>
        }
        @default {
          <p class="text-sm text-slate-500">One moment…</p>
        }
      }
    </div>
  `,
})
export class VerifyEmailPage {
  private route = inject(ActivatedRoute);
  private http = inject(HttpClient);

  protected state = signal<'working' | 'done' | 'error'>('working');
  protected email = signal('');

  constructor() {
    const token = this.route.snapshot.paramMap.get('token') ?? '';
    this.http.post<{ verified: boolean; email: string }>(
      `${environment.apiUrl}/users/verify/`, { token },
    ).subscribe({
      next: (body) => {
        this.email.set(body.email);
        this.state.set('done');
      },
      error: () => this.state.set('error'),
    });
  }
}
