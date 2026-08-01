import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { GuestFacade } from '../abstraction/guest.facade';

/**
 * Guest session affordances (01-architecture.md §21.4, §21.5).
 *
 * Expiry must be legible — guests must never lose work silently — but the tone
 * is calm, not alarming: auto-deletion is a feature to advertise, not a
 * limitation to hide. The signup CTA sits here rather than in an interstitial.
 */
@Component({
  selector: 'app-guest-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (guests.expiredNotice()) {
      <div
        class="flex items-center justify-between gap-4 border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900"
        data-test="guest-expired-notice"
      >
        <span>
          Your guest session ended and those files were deleted. Anything you do now starts
          a fresh session.
        </span>
        <button type="button" class="text-amber-700 underline" (click)="guests.dismissExpiredNotice()">
          Dismiss
        </button>
      </div>
    }

    @if (guests.accountRequired(); as message) {
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b border-indigo-200 bg-indigo-50 px-6 py-2 text-sm text-indigo-900"
        data-test="account-required-prompt"
      >
        <span>{{ message }}</span>
        <span class="flex items-center gap-3">
          <a routerLink="/auth/register" class="font-medium underline" data-test="account-required-cta">
            Create a free account
          </a>
          <button type="button" class="text-indigo-700 underline" (click)="guests.dismissAccountRequired()">
            Dismiss
          </button>
        </span>
      </div>
    }

    @if (guests.principal() === 'guest' && guests.secondsRemaining() !== null) {
      <div
        class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-100 px-6 py-2 text-sm text-slate-600"
        data-test="guest-banner"
      >
        <span>
          You are working without an account — files are deleted automatically
          (<span data-test="guest-time-left">{{ guests.timeRemainingLabel() }}</span
          >).
        </span>
        <a
          routerLink="/auth/register"
          class="font-medium text-indigo-600 hover:text-indigo-700"
          data-test="guest-banner-cta"
        >
          Create a free account to keep these files
        </a>
      </div>
    }
  `,
})
export class GuestBanner {
  protected guests = inject(GuestFacade);
}
