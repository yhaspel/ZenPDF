import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { GuestFacade } from '../../abstraction/guest.facade';

/**
 * An `accountGuard` rejection lands here with a `reason`, rendered as human
 * copy — never a bare wall (§7, §21.3).
 */
const REASONS: Record<string, string> = {
  library: 'Create a free account to keep your files in a library that does not expire.',
  settings: 'Create a free account to manage your profile and settings.',
  sign: 'Create a free account to send documents for signature.',
  account: 'Create a free account to use this feature.',
};

@Component({
  selector: 'app-register',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <form (ngSubmit)="submit()" class="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm" data-test="register-form">
        <h1 class="mb-2 text-2xl font-bold text-slate-800">Create your account</h1>

        @if (reasonCopy(); as copy) {
          <p class="mb-4 rounded-lg bg-indigo-50 px-3 py-2 text-sm text-indigo-900" data-test="register-reason">
            {{ copy }}
          </p>
        }
        @if (guests.principal() === 'guest') {
          <p class="mb-4 text-sm text-slate-500" data-test="register-claim-note">
            The files you have already worked on will move into your new account.
          </p>
        }

        @if (error()) {
          <p class="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600" data-test="register-error">{{ error() }}</p>
        }
        <label class="mb-1 block text-sm font-medium text-slate-600">Name</label>
        <input name="name" type="text" [(ngModel)]="displayName"
               class="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2" data-test="name" />
        <label class="mb-1 block text-sm font-medium text-slate-600">Email</label>
        <input name="email" type="email" required [(ngModel)]="email"
               class="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2" data-test="email" />
        <label class="mb-1 block text-sm font-medium text-slate-600">Password</label>
        <input name="password" type="password" required [(ngModel)]="password"
               class="mb-6 w-full rounded-lg border border-slate-300 px-3 py-2" data-test="password" />
        <button type="submit" [disabled]="loading()"
                class="w-full rounded-lg bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                data-test="submit">
          {{ loading() ? 'Creating…' : 'Create account' }}
        </button>
        <p class="mt-4 text-center text-sm text-slate-500">
          Already have an account? <a routerLink="/auth/login" class="text-indigo-600" data-test="to-login">Log in</a>
        </p>
      </form>
    </div>
  `,
})
export class Register {
  protected displayName = '';
  protected email = '';
  protected password = '';
  protected error = signal('');
  protected loading = signal(false);

  private auth = inject(AuthFacade);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  protected guests = inject(GuestFacade);

  protected readonly reasonCopy = computed(() => {
    const reason = this.route.snapshot.queryParamMap.get('reason');
    return reason ? (REASONS[reason] ?? REASONS['account']) : '';
  });

  submit(): void {
    if (!this.email || !this.password) return;
    this.loading.set(true);
    this.error.set('');
    this.auth.register({ email: this.email, password: this.password, display_name: this.displayName }).subscribe({
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

  private next(): string {
    return this.route.snapshot.queryParamMap.get('next') || '/app/dashboard';
  }
}
