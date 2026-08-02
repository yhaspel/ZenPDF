import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ConsentService } from '../core/services/consent.service';

/**
 * The consent banner (§9A).
 *
 * Deliberately plain, and deliberately symmetrical: two buttons of equal
 * weight, no pre-ticked boxes, no "manage 847 partners" maze, and no dark
 * pattern that makes refusing take four clicks. It appears only where consent
 * is actually required, and only until a choice is made.
 *
 * Google's certified CMP replaces this for TCF regions at launch — it is the
 * owner-executed half. What it will not change is the rule underneath: nothing
 * loads before somebody has answered.
 */
@Component({
  selector: 'app-consent-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (consent.mustAsk()) {
      <div class="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white p-4 shadow-lg"
           role="dialog" aria-label="Cookies and advertising"
           data-test="consent-banner">
        <div class="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center">
          <p class="flex-1 text-sm text-slate-600">
            We show ads to keep ZenPDF free. With your permission they can be
            personalised, which pays better; without it you still get the whole
            product and ads you see will not be based on you.
            <a routerLink="/legal/privacy" class="underline" data-test="consent-privacy">
              What we collect
            </a>.
          </p>
          <div class="flex shrink-0 gap-2">
            <button class="rounded-lg border border-slate-300 px-4 py-2 text-sm"
                    (click)="consent.set('denied')" data-test="consent-deny">
              No thanks
            </button>
            <button class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white"
                    (click)="consent.set('granted')" data-test="consent-accept">
              Allow
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConsentBanner {
  protected consent = inject(ConsentService);
}
