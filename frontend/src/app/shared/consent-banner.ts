import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ConsentService } from '../core/services/consent.service';

/**
 * The consent banner (§9A).
 *
 * Deliberately plain, and deliberately symmetrical: two buttons of equal
 * weight, no pre-ticked boxes, no "manage 847 partners" maze, and no dark
 * pattern that makes refusing take four clicks. The symmetry is design intent
 * and stays (design contract §3 banners). It appears only where consent is
 * actually required, and only until a choice is made.
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
      <div class="border-border bg-surface-raised shadow-3 fixed inset-x-0 bottom-0 z-30 border-t p-4"
           role="dialog" aria-label="Cookies and advertising"
           data-test="consent-banner">
        <div class="mx-auto flex max-w-4xl flex-col gap-3 sm:flex-row sm:items-center">
          <p class="text-ink-muted flex-1 text-sm">
            We show ads to keep ZenPDF free. With your permission they can be
            personalised, which pays better; without it you still get the whole
            product and ads you see will not be based on you.
            <a routerLink="/legal/privacy" data-test="consent-privacy">
              What we collect
            </a>.
          </p>
          <div class="flex shrink-0 gap-2">
            <button class="btn btn-secondary" (click)="consent.set('denied')" data-test="consent-deny">
              No thanks
            </button>
            <button class="btn btn-secondary" (click)="consent.set('granted')" data-test="consent-accept">
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
