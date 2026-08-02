import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { TOOL_PAGES } from '../../core/tool-pages';
import { SiteFooter } from '../../shared/site-footer';

/**
 * 404 (phase-10 §10.5).
 *
 * The previous behaviour was a silent redirect to the landing page, which is
 * the worst of both: the person does not learn that the address was wrong, and
 * a crawler is told every mistyped URL is a duplicate of the home page. This
 * says what happened, and offers the tools — which is what somebody who
 * followed a dead link to a PDF tool actually wants.
 */
@Component({
  selector: 'app-not-found',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SiteFooter],
  template: `
    <div class="flex min-h-screen flex-col bg-slate-50">
      <main class="mx-auto w-full max-w-2xl flex-1 px-6 py-20 text-center">
        <p class="text-3xl">🧘‍♀️</p>
        <h1 class="mt-4 text-2xl font-bold text-slate-800" data-test="not-found">
          That page is not here
        </h1>
        <p class="mt-2 text-slate-500">
          The address may be mistyped, or the page may have moved. Nothing you
          uploaded is affected.
        </p>
        <p class="mt-6">
          <a routerLink="/" class="text-indigo-600 underline" data-test="not-found-home">
            Back to ZenPDF
          </a>
        </p>

        <h2 class="mt-10 text-sm font-semibold text-slate-600">Popular tools</h2>
        <ul class="mt-3 flex flex-wrap justify-center gap-2 text-sm">
          @for (tool of popular; track tool.slug) {
            <li>
              <a [routerLink]="'/' + tool.slug"
                 class="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-600 underline">
                {{ tool.h1 }}
              </a>
            </li>
          }
        </ul>
      </main>
      <app-site-footer />
    </div>
  `,
})
export class NotFound {
  private title = inject(Title);
  private meta = inject(Meta);

  protected readonly popular = TOOL_PAGES.slice(0, 6);

  constructor() {
    this.title.setTitle('Page not found | ZenPDF');
    // Never index a 404. Without this, every dead link becomes a thin page
    // competing with the real ones.
    this.meta.updateTag({ name: 'robots', content: 'noindex' });
  }
}
