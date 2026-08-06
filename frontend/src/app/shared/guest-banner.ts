import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { GuestFacade } from '../abstraction/guest.facade';

/**
 * Guest session affordances (01-architecture.md §21.4, §21.5).
 *
 * Expiry must be legible — guests must never lose work silently — but the tone
 * is calm, not alarming: auto-deletion is a feature to advertise, not a
 * limitation to hide. The signup CTA sits here rather than in an interstitial,
 * as a plain link, not a button (design contract §3 banners).
 */
@Component({
  selector: 'app-guest-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (guests.expiredNotice()) {
      <div class="banner banner-warning" data-test="guest-expired-notice">
        <span class="grow">
          Your guest session ended and those files were deleted. Anything you do now starts
          a fresh session.
        </span>
        <button type="button" class="linklike underline" (click)="guests.dismissExpiredNotice()">
          Dismiss
        </button>
      </div>
    }

    @if (guests.accountRequired(); as message) {
      <div class="banner banner-info" data-test="account-required-prompt">
        <span class="grow">{{ message }}</span>
        <span class="flex items-center gap-3">
          <a routerLink="/auth/register" class="font-medium" data-test="account-required-cta">
            Create a free account
          </a>
          <button type="button" class="linklike underline" (click)="guests.dismissAccountRequired()">
            Dismiss
          </button>
        </span>
      </div>
    }

    @if (guests.principal() === 'guest' && guests.secondsRemaining() !== null) {
      <div class="banner" data-test="guest-banner">
        <span class="grow">
          You are working without an account — files are deleted automatically
          (<span data-test="guest-time-left">{{ guests.timeRemainingLabel() }}</span
          >).
        </span>
        <a routerLink="/auth/register" data-test="guest-banner-cta">
          Create a free account to keep these files
        </a>
      </div>
    }
  `,
})
export class GuestBanner {
  protected guests = inject(GuestFacade);
}
