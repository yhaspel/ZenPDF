import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { GuestFacade } from '../../abstraction/guest.facade';
import { safeNext } from '../../core/safe-next';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';

/**
 * Why the account gate stopped you, in the words the register page shows.
 *
 * An `accountGuard` rejection lands here with a `reason`, rendered as human
 * copy — never a bare wall (§7, §21.3).
 *
 * Exported so a spec can walk the route table's `accountReason` values against
 * it: they were drifting apart silently, and a route naming a key that is not
 * here degrades to the generic sentence at the highest-intent moment we have.
 */
export const REASONS: Record<string, string> = {
  library: 'Create a free account to keep your files in a library that does not expire.',
  settings: 'Create a free account to manage your profile and settings.',
  sign: 'Create a free account to send documents for signature.',
  account: 'Create a free account to use this feature.',
};

@Component({
  selector: 'app-register',
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
        <!-- Brand panel (contract §4 auth): the anonymous-first promise, and
             the three real reasons an account exists — nothing invented. -->
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
          <form (ngSubmit)="submit()" class="card pad-6 w-full max-w-sm" data-test="register-form">
            <h1 class="!text-[26px]">Create your account</h1>

            @if (reasonCopy(); as copy) {
              <p
                class="bg-info-surface rounded-2 mt-3 px-3.5 py-2.5 text-[13.5px]"
                data-test="register-reason">
                {{ copy }}
              </p>
            }
            @if (guests.principal() === 'guest') {
              <p class="muted mt-2.5 text-[13.5px]" data-test="register-claim-note">
                The files you have already worked on will move into your new account.
              </p>
            }

            @if (error()) {
              <p
                class="bg-danger-surface text-danger rounded-2 mt-3 px-3.5 py-2.5 text-[13.5px]"
                data-test="register-error">
                {{ error() }}
              </p>
            }

            <div class="mt-6">
              <label for="register-name">Name</label>
              <input
                id="register-name"
                name="name"
                type="text"
                [(ngModel)]="displayName"
                class="input"
                data-test="name" />
            </div>
            <div class="mt-4">
              <label for="register-email">Email</label>
              <input
                id="register-email"
                name="email"
                type="email"
                required
                [(ngModel)]="email"
                class="input"
                data-test="email" />
            </div>
            <div class="mt-4">
              <label for="register-password">Password</label>
              <div class="input-wrap">
                <input
                  id="register-password"
                  name="password"
                  [type]="showPassword() ? 'text' : 'password'"
                  required
                  [(ngModel)]="password"
                  class="input"
                  aria-describedby="register-password-hint"
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
              <p class="field-hint" id="register-password-hint">
                At least 8 characters, and not all numbers. A sentence you will remember beats a symbol you will not.
              </p>
            </div>

            <label class="mt-6 !flex items-start gap-2.5">
              <input
                name="terms"
                type="checkbox"
                required
                [(ngModel)]="acceptTerms"
                class="mt-0.5"
                data-test="accept-terms" />
              <span class="text-ink-muted text-[13.5px] leading-[1.55] font-normal">
                I agree to the
                <a routerLink="/legal/terms" target="_blank" data-test="terms-link">Terms</a>
                and the
                <a routerLink="/legal/privacy" target="_blank" data-test="privacy-link"
                  >Privacy Policy</a
                >.
              </span>
            </label>

            <button
              type="submit"
              class="btn btn-primary btn-block mt-6"
              [disabled]="loading() || !acceptTerms"
              data-test="submit">
              {{ loading() ? 'Creating…' : 'Create account' }}
            </button>
            <p class="muted mt-4 text-center text-[13.5px]">
              Already have an account?
              <a routerLink="/auth/login" [queryParams]="loginLinkParams()" data-test="to-login"
                >Log in</a
              >
            </p>
          </form>
        </div>
      </main>

      <app-site-footer />
    </div>
  `,
})
export class Register {
  protected displayName = '';
  protected email = '';
  protected password = '';
  /** Unticked by default, and required: consent that was pre-ticked is not
   *  consent, and "they must have agreed, they have an account" is not
   *  something we would want to have to argue (§9A). */
  protected acceptTerms = false;
  protected error = signal('');
  protected loading = signal(false);
  /** The in-field eye toggle (contract §3 inputs, D6). */
  protected showPassword = signal(false);

  private auth = inject(AuthFacade);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  protected guests = inject(GuestFacade);

  protected readonly reasonCopy = computed(() => {
    const reason = this.route.snapshot.queryParamMap.get('reason');
    return reason ? (REASONS[reason] ?? REASONS['account']) : '';
  });

  submit(): void {
    if (!this.email || !this.password || !this.acceptTerms) return;
    this.loading.set(true);
    this.error.set('');
    this.auth
      .register({
        email: this.email,
        password: this.password,
        display_name: this.displayName,
        accept_terms: true,
      }).subscribe({
      next: () => {
        // auto-login after successful registration
        this.auth.login(this.email, this.password).subscribe({
          next: () => this.router.navigateByUrl(this.next()),
          error: () => this.router.navigate(['/auth/login']),
        });
      },
      error: (err) => {
        const details = err.error?.error?.details?.fields;
        const first = details ? Object.values(details)[0] : null;
        this.error.set((Array.isArray(first) ? first[0] : first) ?? err.error?.error?.message ?? 'Registration failed.');
        this.loading.set(false);
      },
    });
  }

  /**
   * Where to land after signing up — validated, never trusted (L11).
   *
   * The account gate puts the URL you were heading for in the query string,
   * and this used to be handed straight to `navigateByUrl`. `?next=//evil.example`
   * is another origin, and it would have been reached seconds after the person
   * typed a password into ours.
   */
  private next(): string {
    return safeNext(this.route.snapshot.queryParamMap.get('next'));
  }

  /**
   * `next` and `reason` follow the "Log in" link (L12).
   *
   * Somebody stopped on the way to signing, who turns out to already have an
   * account, was being dropped on the dashboard after login — one click away
   * from what they were doing, with nothing to say why.
   */
  protected readonly loginLinkParams = computed(() => {
    const params: Record<string, string> = {};
    const next = this.route.snapshot.queryParamMap.get('next');
    const reason = this.route.snapshot.queryParamMap.get('reason');
    if (next) params['next'] = safeNext(next);
    if (reason) params['reason'] = reason;
    return params;
  });
}
