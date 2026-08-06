import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { safeNext } from '../../core/safe-next';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, Brand, SiteFooter, ThemeToggle],
  template: `
    <div class="page-shell">
      <!-- Slim auth header: the brand is the way home (contract §3 headers, D6). -->
      <header class="hdr">
        <a routerLink="/" class="brand" aria-label="ZenPDF"><app-brand /></a>
        <nav><app-theme-toggle /></nav>
      </header>

      <main class="flex">
        <!-- Same brand panel as the register page — the auth frame is one frame
             (contract §4 auth: "same frame, shorter form"). -->
        <aside
          class="border-border bg-surface hidden w-[44%] flex-none items-center justify-center border-e p-16 lg:flex">
          <div class="max-w-[360px]">
            <app-brand [size]="56" [wordmark]="false" />
            <h2 class="mt-6 !text-[26px]">Everything already works without an account.</h2>
            <p class="muted mt-3">An account is for keeping things:</p>
            <ul class="text-ink-muted mt-4 flex list-none flex-col gap-3.5 p-0">
              <li class="flex items-start gap-3">
                <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6.5Z" />
                </svg>
                <span class="text-[14.5px]"
                  >A library of your files that does not expire, with folders and search</span
                >
              </li>
              <li class="flex items-start gap-3">
                <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M3.5 16.5c2.4-5 4.3-7.3 5.3-6.4s-1.9 6.2-.5 6.7 3.3-3.3 4.3-2.8.6 2.4 1.6 2.4 2-1.4 5.3-1.4" />
                  <path d="M4 20.5h16" />
                </svg>
                <span class="text-[14.5px]">Sending documents to other people for signature</span>
              </li>
              <li class="flex items-start gap-3">
                <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path
                    d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" />
                </svg>
                <span class="text-[14.5px]">Saved signatures, higher limits and your own settings</span>
              </li>
            </ul>
            <p class="mt-8 text-sm"><a routerLink="/">← Back to the tools</a></p>
          </div>
        </aside>

        <div class="flex flex-1 items-center justify-center p-8">
          <form (ngSubmit)="submit()" class="card pad-6 w-full max-w-sm" data-test="login-form">
            <h1 class="!text-[26px]">Welcome back</h1>

            @if (error()) {
              <p
                class="bg-danger-surface text-danger rounded-2 mt-3 px-3.5 py-2.5 text-[13.5px]"
                data-test="login-error">
                {{ error() }}
              </p>
            }

            <div class="mt-6">
              <label for="login-email">Email</label>
              <input
                id="login-email"
                name="email"
                type="email"
                required
                [(ngModel)]="email"
                class="input"
                data-test="email" />
            </div>
            <div class="mt-4">
              <label for="login-password">Password</label>
              <div class="input-wrap">
                <input
                  id="login-password"
                  name="password"
                  [type]="showPassword() ? 'text' : 'password'"
                  required
                  [(ngModel)]="password"
                  class="input"
                  data-test="password" />
                <button
                  type="button"
                  class="input-eye"
                  [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'"
                  (click)="showPassword.set(!showPassword())">
                  @if (showPassword()) {
                    <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                      <circle cx="12" cy="12" r="3" />
                      <path d="m4 4 16 16" />
                    </svg>
                  } @else {
                    <svg class="ti" viewBox="0 0 24 24" aria-hidden="true">
                      <path
                        d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  }
                </button>
              </div>
            </div>

            <button
              type="submit"
              class="btn btn-primary btn-block mt-6"
              [disabled]="loading()"
              data-test="submit">
              {{ loading() ? 'Signing in…' : 'Sign in' }}
            </button>
            <p class="muted mt-4 text-center text-[13.5px]">
              No account?
              <a
                routerLink="/auth/register"
                [queryParams]="registerLinkParams()"
                data-test="to-register"
                >Create one</a
              >
            </p>
          </form>
        </div>
      </main>

      <app-site-footer />
    </div>
  `,
})
export class Login {
  protected email = '';
  protected password = '';
  protected error = signal('');
  protected loading = signal(false);
  /** The in-field eye toggle (contract §3 inputs, D6). */
  protected showPassword = signal(false);

  private auth = inject(AuthFacade);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  /** `next` and `reason` keep travelling if the person bounces back (L12). */
  protected readonly registerLinkParams = computed(() => {
    const params: Record<string, string> = {};
    const next = this.route.snapshot.queryParamMap.get('next');
    const reason = this.route.snapshot.queryParamMap.get('reason');
    if (next) params['next'] = safeNext(next);
    if (reason) params['reason'] = reason;
    return params;
  });

  submit(): void {
    if (!this.email || !this.password) return;
    this.loading.set(true);
    this.error.set('');
    this.auth.login(this.email, this.password).subscribe({
      // Read `next` the way Register does (L12): somebody sent here by the
      // account gate was landing on the dashboard, one click away from what
      // they had been doing and with nothing to say why. Validated, never
      // trusted — see `safeNext`.
      next: () => this.router.navigateByUrl(safeNext(this.route.snapshot.queryParamMap.get('next'))),
      error: (err) => {
        this.error.set(err.error?.error?.message ?? 'Invalid email or password.');
        this.loading.set(false);
      },
    });
  }
}
