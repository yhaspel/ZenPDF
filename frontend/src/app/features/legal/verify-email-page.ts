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
    <main class="flex min-h-dvh items-center justify-center p-6"
          data-test="verify-email-page">
      <div class="card pad-6 w-full max-w-sm">
        @switch (state()) {
          @case ('done') {
            <!-- The hanko marks the completion (§1): the address is proven. -->
            <div class="flex items-center gap-3">
              <span class="stamp">Done</span>
              <h1 class="!text-lg" data-test="verified">
                Address confirmed
              </h1>
            </div>
            <p class="muted mt-3 text-sm">
              {{ email() }} is verified. You can now send documents to other
              people for signature.
            </p>
            <a routerLink="/app/dashboard" class="btn btn-secondary mt-5">
              Back to your documents
            </a>
          }
          @case ('error') {
            <h1 class="!text-lg" data-test="verify-failed">
              That link has expired
            </h1>
            <p class="muted mt-2 text-sm">
              Verification links last a couple of days. Sign in and ask for a new
              one from your settings.
            </p>
          }
          @default {
            <div class="breath">
              <div class="breath-dot" aria-hidden="true"></div>
              <p>One moment…</p>
            </div>
          }
        }
      </div>
    </main>
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
