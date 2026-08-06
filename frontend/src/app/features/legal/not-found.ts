import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { TOOL_PAGES } from '../../core/tool-pages';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';

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
  imports: [RouterLink, Brand, SiteFooter, ThemeToggle],
  template: `
    <div class="page-shell">
      <header class="hdr">
        <a routerLink="/" class="brand" aria-label="ZenPDF"><app-brand /></a>
        <nav>
          <app-theme-toggle />
        </nav>
      </header>

      <main class="wrap-narrow w-full pb-16 pt-20 text-center">
        <!-- The folded sheet (§1): the screen's one sheet, no illustration. -->
        <div class="sheet mx-auto max-w-[26rem] px-8 py-10">
          <h1 class="!text-[22px]" data-test="not-found">
            That page is not here
          </h1>
          <p class="muted mt-2.5 text-sm">
            The address may be mistyped, or the page may have moved. Nothing you
            uploaded is affected.
          </p>
          <p class="mt-6">
            <a routerLink="/" data-test="not-found-home">
              Back to ZenPDF
            </a>
          </p>
        </div>

        <h2 class="kicker mt-12">Popular tools</h2>
        <ul class="mt-4 flex flex-wrap justify-center gap-2.5 text-[13.5px]">
          @for (tool of popular; track tool.slug) {
            <li>
              <a [routerLink]="'/' + tool.slug"
                 class="border-border bg-surface-raised text-ink-muted inline-block rounded-full border px-3.5 py-1.5">
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
