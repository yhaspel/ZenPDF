import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { safeNext } from '../../core/safe-next';

@Component({
  selector: 'app-login',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <form (ngSubmit)="submit()" class="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm" data-test="login-form">
        <h1 class="mb-6 text-2xl font-bold text-slate-800">Welcome back</h1>
        @if (error()) {
          <p class="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600" data-test="login-error">{{ error() }}</p>
        }
        <label for="login-email" class="mb-1 block text-sm font-medium text-slate-600">Email</label>
        <input id="login-email" name="email" type="email" required [(ngModel)]="email"
               class="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2" data-test="email" />
        <label for="login-password" class="mb-1 block text-sm font-medium text-slate-600">Password</label>
        <input id="login-password" name="password" type="password" required [(ngModel)]="password"
               class="mb-6 w-full rounded-lg border border-slate-300 px-3 py-2" data-test="password" />
        <button type="submit" [disabled]="loading()"
                class="w-full rounded-lg bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                data-test="submit">
          {{ loading() ? 'Signing in…' : 'Sign in' }}
        </button>
        <p class="mt-4 text-center text-sm text-slate-500">
          No account? <a routerLink="/auth/register" [queryParams]="registerLinkParams()" class="text-indigo-600 underline" data-test="to-register">Create one</a>
        </p>
      </form>
    </div>
  `,
})
export class Login {
  protected email = '';
  protected password = '';
  protected error = signal('');
  protected loading = signal(false);

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
