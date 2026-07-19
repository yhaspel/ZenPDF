import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';

@Component({
  selector: 'app-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="flex min-h-screen flex-col items-center justify-center gap-8 bg-gradient-to-b from-indigo-50 to-white px-6 text-center">
      <div class="text-6xl">🧘‍♀️📄</div>
      <div>
        <h1 class="text-4xl font-bold text-slate-800">ZenPDF</h1>
        <p class="mt-3 max-w-md text-slate-500">
          A calm, all-in-one workspace to organize, edit, convert, secure and sign your PDFs —
          free and in your browser.
        </p>
      </div>
      <div class="flex gap-4">
        <a routerLink="/auth/register"
           class="rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white hover:bg-indigo-700"
           data-test="cta-register">Get started free</a>
        <a routerLink="/auth/login"
           class="rounded-lg border border-slate-300 px-6 py-3 font-medium text-slate-700 hover:bg-slate-50"
           data-test="cta-login">Log in</a>
      </div>
    </div>
  `,
})
export class Landing {
  constructor() {
    const auth = inject(AuthFacade);
    const router = inject(Router);
    if (auth.isAuthenticated()) {
      router.navigate(['/app/dashboard']);
    }
  }
}
