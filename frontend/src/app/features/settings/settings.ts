import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { HttpClient } from '@angular/common/http';
import { signal } from '@angular/core';

import { AuthFacade } from '../../abstraction/auth.facade';
import { DocumentsFacade } from '../../abstraction/documents.facade';
import { environment } from '../../../environments/environment';
import { ConfigService } from '../../core/services/config.service';
import { ConsentService } from '../../core/services/consent.service';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="mx-auto max-w-2xl p-6">
      <h1 class="mb-6 text-2xl font-bold text-slate-800">Settings</h1>
      <div class="rounded-xl bg-white p-6 shadow-sm">
        <h2 class="mb-4 font-semibold text-slate-700">Profile</h2>
        <label class="mb-1 block text-sm text-slate-500">Email</label>
        <input [value]="auth.user()?.email" disabled
               class="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-500" />
        <label class="mb-1 block text-sm text-slate-500">Display name</label>
        <div class="flex gap-2">
          <input [(ngModel)]="displayName" class="flex-1 rounded-lg border border-slate-300 px-3 py-2" data-test="display-name" />
          <button (click)="save()" class="rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700" data-test="save-profile">
            Save
          </button>
        </div>
      </div>

      <!-- Email verification (§9B): it gates sending for signature and
           nothing else, and the panel says exactly that rather than implying
           the account is limited. -->
      @if (auth.user(); as user) {
        @if (!user.email_verified) {
          <div class="mt-6 rounded-xl border border-amber-300 bg-amber-50 p-4"
               data-test="verify-banner">
            <p class="text-sm text-amber-800">
              Confirm your email address to send documents to other people for
              signature. Everything else works already.
            </p>
            <button class="mt-2 rounded-lg border border-amber-400 px-3 py-1 text-sm text-amber-900"
                    [disabled]="sendingVerification()" (click)="resendVerification()"
                    data-test="resend-verification">
              {{ sentVerification() ? 'Sent — check your inbox' : 'Send me the link' }}
            </button>
          </div>
        }
      }

      <div class="mt-6 rounded-xl bg-white p-6 shadow-sm">
        <h2 class="mb-4 font-semibold text-slate-700" data-test="usage-heading">Storage and usage</h2>
        @if (docs.usage(); as u) {
          <div class="mb-2 h-3 w-full overflow-hidden rounded-full bg-slate-100">
            <div class="h-full bg-indigo-500" [style.width.%]="docs.storagePercent()"></div>
          </div>
          <p class="text-sm text-slate-500">
            {{ (u.storage.used_bytes / 1048576).toFixed(1) }} MB of
            {{ (u.storage.quota_bytes / 1048576).toFixed(0) }} MB used
          </p>

          <!-- What you have used this month, against what you are allowed
               (§9B). A limit nobody can see is a limit that arrives as a
               surprise 429. -->
          <table class="mt-4 w-full text-left text-sm" data-test="usage-table">
            <tbody class="text-slate-600">
              <tr class="border-b border-slate-100">
                <td class="py-1">Signature requests this month</td>
                <td class="text-right" data-test="usage-sign">
                  {{ u.counters.sign_requests }} / {{ u.limits.sign_requests_per_month }}
                </td>
              </tr>
              <tr class="border-b border-slate-100">
                <td class="py-1">Pages OCR'd this month</td>
                <td class="text-right" data-test="usage-ocr">
                  {{ u.counters.ocr_pages }} / {{ u.limits.ocr_pages_per_month }}
                </td>
              </tr>
              <tr class="border-b border-slate-100">
                <td class="py-1">Heavy operations this hour</td>
                <td class="text-right" data-test="usage-metered">
                  {{ u.counters.metered_ops_this_hour }} / {{ u.limits.metered_ops_per_hour }}
                </td>
              </tr>
              <tr>
                <td class="py-1">Conversions this month</td>
                <td class="text-right">{{ u.counters.conversions }}</td>
              </tr>
            </tbody>
          </table>
        }
      </div>

      <!-- Somebody who said yes (or no) to ads can change their mind. A
           consent you cannot withdraw is not consent (§9A). -->
      @if (adsEnabled()) {
        <div class="mt-6 rounded-xl bg-white p-6 shadow-sm" data-test="consent-settings">
          <h2 class="mb-2 font-semibold text-slate-700">Advertising</h2>
          <p class="text-sm text-slate-500">
            Ads keep ZenPDF free. Your current choice:
            <strong data-test="consent-choice">
              {{ consent.choice() === 'granted' ? 'personalised ads allowed'
                 : consent.choice() === 'denied' ? 'personalised ads declined'
                 : 'not decided yet' }}</strong>.
          </p>
          <div class="mt-3 flex gap-2">
            <button class="rounded-lg border border-slate-300 px-3 py-1 text-sm"
                    (click)="consent.set('denied')" data-test="settings-consent-deny">
              Decline
            </button>
            <button class="rounded-lg border border-slate-300 px-3 py-1 text-sm"
                    (click)="consent.set('granted')" data-test="settings-consent-allow">
              Allow
            </button>
          </div>
        </div>
      }
    </div>
  `,
})
export class Settings {
  protected auth = inject(AuthFacade);
  protected docs = inject(DocumentsFacade);
  protected consent = inject(ConsentService);
  private config = inject(ConfigService);
  private http = inject(HttpClient);
  private toast = inject(ToastService);
  protected displayName = '';
  protected sendingVerification = signal(false);
  protected sentVerification = signal(false);

  protected readonly adsEnabled = () => this.config.ads().enabled;

  constructor() {
    this.displayName = this.auth.user()?.display_name ?? '';
    this.docs.refreshUsage();
  }

  resendVerification(): void {
    this.sendingVerification.set(true);
    this.http.post(`${environment.apiUrl}/users/verify/send/`, {}).subscribe({
      next: () => {
        this.sendingVerification.set(false);
        this.sentVerification.set(true);
        this.toast.success('Check your inbox for the link');
      },
      error: () => {
        this.sendingVerification.set(false);
        this.toast.error('Could not send that just now');
      },
    });
  }

  save(): void {
    this.auth.updateProfile({ display_name: this.displayName }).subscribe({
      next: () => this.toast.success('Profile updated'),
      error: () => this.toast.error('Could not update profile'),
    });
  }
}
