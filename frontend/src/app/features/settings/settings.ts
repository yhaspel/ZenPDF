import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { environment } from '../../../environments/environment';

import { AuthFacade } from '../../abstraction/auth.facade';
import { DocumentsFacade } from '../../abstraction/documents.facade';
import { Job } from '../../core/models/models';
import { ConfigService } from '../../core/services/config.service';
import { JobsService } from '../../core/services/jobs.service';
import { ConsentService } from '../../core/services/consent.service';
import { VerificationService } from '../../core/services/verification.service';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe],
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

        <!-- What actually ran (§9B). The counters above say how much of the
             month is gone; this says *what* spent it, which is the question
             somebody asks when the number surprises them. -->
        <h3 class="mt-6 text-sm font-semibold text-slate-700">Recent jobs</h3>
        <div class="mt-2 flex gap-1 text-xs">
          @for (option of jobFilters; track option.value) {
            <button class="rounded-full border px-2 py-0.5"
                    [class.border-indigo-400]="jobFilter() === option.value"
                    [class.text-indigo-700]="jobFilter() === option.value"
                    [class.border-slate-200]="jobFilter() !== option.value"
                    [class.text-slate-500]="jobFilter() !== option.value"
                    (click)="setJobFilter(option.value)"
                    [attr.data-test]="'job-filter-' + (option.value || 'all')">
              {{ option.label }}
            </button>
          }
        </div>
        @if (jobs().length) {
          <table class="mt-2 w-full text-left text-sm" data-test="job-history">
            <tbody class="text-slate-600">
              @for (job of jobs(); track job.id) {
                <tr class="border-b border-slate-100" data-test="job-row">
                  <td class="py-1">{{ job.type }}</td>
                  <td class="py-1 text-slate-400">{{ job.status }}</td>
                  <td class="py-1 text-right text-slate-400">
                    {{ job.created_at | date: 'd MMM, HH:mm' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="mt-2 text-sm text-slate-400" data-test="job-history-empty">
            Nothing yet.
          </p>
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

      <!-- The two things the privacy policy promises, reachable rather than
           promised (§10.1). Deletion is the only irreversible action in the
           product, so it asks for the password and says what survives. -->
      <div class="mt-6 rounded-xl bg-white p-6 shadow-sm" data-test="privacy-settings">
        <h2 class="mb-2 font-semibold text-slate-700">Your data</h2>
        <p class="text-sm text-slate-500">
          Take a copy of everything we hold, or close the account for good.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <a class="rounded-lg border border-slate-300 px-3 py-1 text-sm"
             [href]="exportUrl()" data-test="export-data">
            Download my data
          </a>
          <button class="rounded-lg border border-rose-300 px-3 py-1 text-sm text-rose-700"
                  (click)="deleting.set(true)" data-test="delete-account">
            Delete my account
          </button>
        </div>

        @if (deleting()) {
          <div class="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4"
               data-test="delete-confirm">
            <p class="text-sm text-rose-900">
              This deletes your documents and cannot be undone. Signature
              envelopes other people have already signed are kept as their
              record of the agreement — the privacy policy explains why.
            </p>
            <input type="password" name="confirm-password"
                   [(ngModel)]="deletePassword" placeholder="Your password"
                   class="mt-3 w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2"
                   data-test="delete-password" />
            @if (deleteError(); as message) {
              <p class="mt-2 text-sm text-rose-700" data-test="delete-error">{{ message }}</p>
            }
            <div class="mt-3 flex gap-2">
              <button class="rounded-lg bg-rose-600 px-3 py-1 text-sm text-white disabled:opacity-50"
                      [disabled]="!deletePassword || busyDeleting()"
                      (click)="confirmDelete()" data-test="delete-confirm-yes">
                Delete everything
              </button>
              <button class="rounded-lg px-3 py-1 text-sm text-slate-500"
                      (click)="deleting.set(false)">Cancel</button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
})
export class Settings {
  protected auth = inject(AuthFacade);
  protected docs = inject(DocumentsFacade);
  protected consent = inject(ConsentService);
  private config = inject(ConfigService);
  private toast = inject(ToastService);
  private http = inject(HttpClient);
  private router = inject(Router);
  protected displayName = '';

  protected readonly adsEnabled = () => this.config.ads().enabled;
  protected verification = inject(VerificationService);
  private jobsSvc = inject(JobsService);
  protected jobs = signal<Job[]>([]);
  protected jobFilter = signal('');
  protected readonly jobFilters = [
    { value: '', label: 'All' },
    { value: 'succeeded', label: 'Succeeded' },
    { value: 'failed', label: 'Failed' },
    { value: 'running', label: 'Running' },
  ];
  protected sendingVerification = this.verification.sending;
  protected sentVerification = this.verification.sent;

  constructor() {
    this.displayName = this.auth.user()?.display_name ?? '';
    this.docs.refreshUsage();
    this.loadJobs();
  }

  protected deleting = signal(false);
  protected busyDeleting = signal(false);
  protected deleteError = signal('');
  protected deletePassword = '';

  /** A plain link, not a fetch: the browser already knows how to save a file,
   *  and the export can be tens of megabytes. */
  protected exportUrl(): string {
    return `${environment.apiUrl}/users/me/export/`;
  }

  protected confirmDelete(): void {
    this.busyDeleting.set(true);
    this.deleteError.set('');
    this.http
      .request('delete', `${environment.apiUrl}/users/me/delete/`, {
        body: { password: this.deletePassword },
      })
      .subscribe({
        next: () => {
          this.busyDeleting.set(false);
          this.auth.logout();
          this.router.navigateByUrl('/');
        },
        error: (err) => {
          this.busyDeleting.set(false);
          this.deleteError.set(
            err?.error?.error?.message || 'That did not work. Try again.',
          );
        },
      });
  }

  protected setJobFilter(value: string): void {
    this.jobFilter.set(value);
    this.loadJobs();
  }

  private loadJobs(): void {
    this.jobsSvc.list(this.jobFilter() || undefined).subscribe({
      next: (page) => this.jobs.set(page.results.slice(0, 20)),
      error: () => this.jobs.set([]),
    });
  }

  resendVerification(): void {
    this.verification.resend();
  }

  save(): void {
    this.auth.updateProfile({ display_name: this.displayName }).subscribe({
      next: () => this.toast.success('Profile updated'),
      error: () => this.toast.error('Could not update profile'),
    });
  }
}
