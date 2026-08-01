import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { TOOL_PAGES } from '../../core/tool-pages';

/**
 * The landing page is a directory of working tools, not a signup wall (§21.1).
 *
 * An authenticated visitor is no longer bounced to the dashboard: the tools are
 * the product for both principals, and the library is one click away in the nav.
 */
@Component({
  selector: 'app-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="min-h-screen bg-gradient-to-b from-indigo-50 to-white">
      <header class="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <span class="flex items-center gap-2 font-bold text-slate-800">🧘‍♀️ ZenPDF</span>
        <nav class="flex items-center gap-4 text-sm">
          @if (auth.isAuthenticated()) {
            <a routerLink="/app/dashboard" class="text-slate-600" data-test="cta-library">My files</a>
          } @else {
            <a routerLink="/auth/login" class="text-slate-600" data-test="cta-login">Log in</a>
            <a routerLink="/auth/register"
               class="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white hover:bg-indigo-700"
               data-test="cta-register">Create free account</a>
          }
        </nav>
      </header>

      <main class="mx-auto max-w-5xl px-6 pb-20 pt-8 text-center">
        <h1 class="text-4xl font-bold text-slate-800">Every PDF tool, no account needed</h1>
        <p class="mx-auto mt-3 max-w-xl text-slate-500">
          Organize, merge, split, compress and rotate PDFs in your browser. Free, no watermark,
          and files are deleted automatically within 24 hours.
        </p>

        <ul class="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-test="tool-grid">
          @for (tool of tools; track tool.slug) {
            <li>
              <a
                [routerLink]="'/' + tool.slug"
                class="block rounded-2xl bg-white p-5 text-left shadow-sm transition hover:shadow-md"
                [attr.data-test]="'tool-link-' + tool.slug"
              >
                <span class="font-medium text-slate-800">{{ tool.h1 }}</span>
                <span class="mt-1 block text-sm text-slate-500">{{ tool.cta }}</span>
              </a>
            </li>
          }
        </ul>
      </main>
    </div>
  `,
})
export class Landing {
  protected auth = inject(AuthFacade);
  protected readonly tools = TOOL_PAGES;
}
