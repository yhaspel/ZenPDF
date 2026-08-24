import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { environment } from '../../../environments/environment';

import { AuthFacade } from '../../abstraction/auth.facade';
import { DocumentsFacade } from '../../abstraction/documents.facade';
import { apiError } from '../../core/api-error';
import { Job } from '../../core/models/models';
import { ConfigService } from '../../core/services/config.service';
import { JobsService } from '../../core/services/jobs.service';
import { ConsentService } from '../../core/services/consent.service';
import { VerificationService } from '../../core/services/verification.service';
import { saveBlob } from '../../shared/save-blob';
import { SiteFooter } from '../../shared/site-footer';
import { ToastService } from '../../shared/toast.service';

@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, DatePipe, SiteFooter],
  template: `
    <div class="wrap-narrow flex w-full flex-1 flex-col gap-6 pt-8 pb-16">
      <h1 class="!text-[28px]">Settings</h1>

      <section class="card pad-5">
        <h2 class="mb-4 !text-[17px]">Profile</h2>
        <label for="settings-email">Email</label>
        <input id="settings-email" class="input" [value]="auth.user()?.email" disabled />
        <div class="mt-4">
          <label for="settings-name">Display name</label>
          <div class="flex gap-2.5">
            <input
              id="settings-name"
              name="display-name"
              [(ngModel)]="displayName"
              class="input flex-1"
              data-test="display-name" />
            <button type="button" (click)="save()" class="btn btn-secondary" data-test="save-profile">
              Save
            </button>
          </div>
        </div>
      </section>

      <!-- Email verification (§9B): it gates sending for signature and
           nothing else, and the panel says exactly that rather than implying
           the account is limited. -->
      @if (auth.user(); as user) {
        @if (!user.email_verified) {
          <section
            class="border-warning bg-warning-surface rounded-3 shadow-1 border p-6"
            data-test="verify-banner">
            <p class="text-sm">
              Confirm your email address to send documents to other people for
              signature. Everything else works already.
            </p>
            <button
              type="button"
              class="btn btn-secondary btn-sm mt-3"
              [disabled]="sendingVerification()"
              (click)="resendVerification()"
              data-test="resend-verification">
              {{ sentVerification() ? 'Sent — check your inbox' : 'Send me the link' }}
            </button>
          </section>
        }
      }

      <section class="card pad-5">
        <h2 class="mb-4 !text-[17px]" data-test="usage-heading">Storage and usage</h2>
        @if (docs.usage(); as u) {
          <div class="meter"><i [style.width.%]="docs.storagePercent()"></i></div>
          <p class="muted mt-2 text-[13.5px]">
            {{ (u.storage.used_bytes / 1048576).toFixed(1) }} MB of
            {{ (u.storage.quota_bytes / 1048576).toFixed(0) }} MB used
          </p>

          <!-- What you have used this month, against what you are allowed
               (§9B). A limit nobody can see is a limit that arrives as a
               surprise 429. -->
          <table class="tbl mt-4" data-test="usage-table">
            <tbody>
              <tr>
                <td>Signature requests this month</td>
                <td class="text-end" data-test="usage-sign">
                  {{ u.counters.sign_requests }} / {{ u.limits.sign_requests_per_month }}
                </td>
              </tr>
              <tr>
                <td>Pages OCR'd this month</td>
                <td class="text-end" data-test="usage-ocr">
                  {{ u.counters.ocr_pages }} / {{ u.limits.ocr_pages_per_month }}
                </td>
              </tr>
              <tr>
                <td>Heavy operations this hour</td>
                <td class="text-end" data-test="usage-metered">
                  {{ u.counters.metered_ops_this_hour }} / {{ u.limits.metered_ops_per_hour }}
                </td>
              </tr>
              <tr>
                <td>Conversions this month</td>
                <td class="text-end">{{ u.counters.conversions }}</td>
              </tr>
            </tbody>
          </table>
        }

        <!-- What actually ran (§9B). The counters above say how much of the
             month is gone; this says *what* spent it, which is the question
             somebody asks when the number surprises them. -->
        <h3 class="mt-6 !font-ui !text-sm !font-medium">Recent jobs</h3>
        <div class="seg mt-2.5">
          @for (option of jobFilters; track option.value) {
            <button
              type="button"
              [class.seg-active]="jobFilter() === option.value"
              (click)="setJobFilter(option.value)"
              [attr.data-test]="'job-filter-' + (option.value || 'all')">
              {{ option.label }}
            </button>
          }
        </div>
        @if (jobs().length) {
          <table class="tbl mt-2.5" data-test="job-history">
            <tbody>
              @for (job of jobs(); track job.id) {
                <tr data-test="job-row">
                  <td>{{ job.type }}</td>
                  <td>{{ job.status }}</td>
                  <td class="text-end">
                    {{ job.created_at | date: 'd MMM, HH:mm' }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <p class="faint mt-2.5 text-sm" data-test="job-history-empty">
            Nothing yet.
          </p>
        }
      </section>

      <!-- Somebody who said yes (or no) to ads can change their mind. A
           consent you cannot withdraw is not consent (§9A). Decline and Allow
           carry equal weight — the symmetry is deliberate (contract §3). -->
      @if (adsEnabled()) {
        <section class="card pad-5" data-test="consent-settings">
          <h2 class="mb-2 !text-[17px]">Advertising</h2>
          <p class="muted text-sm">
            Ads keep ZenPDF free. Your current choice:
            <strong class="text-ink-strong font-medium" data-test="consent-choice">
              {{ consent.choice() === 'granted' ? 'personalised ads allowed'
                 : consent.choice() === 'denied' ? 'personalised ads declined'
                 : 'not decided yet' }}</strong>.
          </p>
          <div class="mt-4 flex gap-2.5">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              (click)="consent.set('denied')"
              data-test="settings-consent-deny">
              Decline
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              (click)="consent.set('granted')"
              data-test="settings-consent-allow">
              Allow
            </button>
          </div>
        </section>
      }

      <!-- The two things the privacy policy promises, reachable rather than
           promised (§10.1). Deletion is the only irreversible action in the
           product, so it asks for the password and says what survives. -->
      <section class="card pad-5" data-test="privacy-settings">
        <h2 class="mb-2 !text-[17px]">Your data</h2>
        <p class="muted text-sm">
          Take a copy of everything we hold, or close the account for good.
        </p>
        <div class="mt-4 flex flex-wrap gap-2.5">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            [disabled]="exporting()"
            (click)="exportData()"
            data-test="export-data">
            {{ exporting() ? 'Preparing…' : 'Download my data' }}
          </button>
          <button
            type="button"
            class="btn btn-danger btn-sm"
            (click)="openDelete()"
            data-test="delete-account">
            Delete my account
          </button>
        </div>

        @if (deleting()) {
          <div
            class="bg-danger-surface rounded-2 mt-4 p-4"
            role="group"
            aria-label="Confirm account deletion"
            data-test="delete-confirm">
            <p class="text-sm">
              This deletes your documents and cannot be undone. Signature
              envelopes other people have already signed are kept as their
              record of the agreement — the privacy policy explains why.
            </p>
            <label for="delete-password" class="mt-3">
              Your password, to confirm
            </label>
            <input
              id="delete-password"
              type="password"
              name="confirm-password"
              #deletePasswordInput
              [(ngModel)]="deletePassword"
              placeholder="Your password"
              [attr.aria-invalid]="deleteError() ? 'true' : null"
              aria-describedby="delete-error"
              class="input max-w-xs"
              data-test="delete-password" />
            <!-- Assertive, and always present: a message that only appears
                 when it is needed is a message a screen reader never
                 announces, and this one is the difference between "wrong
                 password" and "nothing happened". -->
            <p id="delete-error" role="alert" class="field-error" data-test="delete-error">
              {{ deleteError() }}
            </p>
            <div class="mt-3 flex gap-2.5">
              <button
                type="button"
                class="btn btn-danger-filled btn-sm"
                [disabled]="!deletePassword || busyDeleting()"
                (click)="confirmDelete()"
                data-test="delete-confirm-yes">
                Delete everything
              </button>
              <button type="button" class="btn btn-ghost btn-sm" (click)="deleting.set(false)">
                Cancel
              </button>
            </div>
          </div>
        }
      </section>
    </div>
    <app-site-footer />
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
  private destroyRef = inject(DestroyRef);
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

  protected exporting = signal(false);

  /**
   * Fetched, not linked.
   *
   * The obvious `<a href>` sends no `Authorization` header — the JWT lives in
   * memory and travels on the interceptor — so the browser would navigate
   * straight into a 401 and the person would conclude their data is gone.
   */
  protected exportData(): void {
    this.exporting.set(true);
    this.http
      .get(`${environment.apiUrl}/users/me/export/`, { responseType: 'blob' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (blob) => {
          this.exporting.set(false);
          saveBlob(blob, `zenpdf-export-${new Date().toISOString().slice(0, 10)}.zip`);
        },
        error: () => {
          this.exporting.set(false);
          this.toast.error('Could not prepare that just now.');
        },
      });
  }

  private deletePasswordInput =
    viewChild<ElementRef<HTMLInputElement>>('deletePasswordInput');

  /** Opening the panel puts the cursor where the work is. Without this, a
   *  keyboard user tabs from the button through everything below it. */
  protected openDelete(): void {
    this.deleting.set(true);
    setTimeout(() => this.deletePasswordInput()?.nativeElement.focus());
  }

  protected confirmDelete(): void {
    this.busyDeleting.set(true);
    this.deleteError.set('');
    this.http
      .request('delete', `${environment.apiUrl}/users/me/delete/`, {
        body: { password: this.deletePassword },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (result) => {
          this.busyDeleting.set(false);
          this.auth.logout();
          // The API returns exactly the numbers that make a confirmation
          // honest. Ending the only irreversible action in the product on a
          // silent redirect looks like a glitch, not a deletion.
          const summary = result as {
            documents: number;
            sign_requests_retained: number;
          };
          const kept = summary.sign_requests_retained
            ? ` ${summary.sign_requests_retained} signed envelope(s) were kept as`
              + ' the other parties’ record.'
            : '';
          this.toast.success(
            `Account deleted. ${summary.documents} document(s) removed.${kept}`,
            12_000,
          );
          // The account is deleted and the toast says so for 12 s. Landing
          // somewhere else would not undo it, and nothing here reads the result.
          void this.router.navigateByUrl('/');
        },
        error: (err) => {
          this.busyDeleting.set(false);
          this.deleteError.set(
            apiError(err).message || 'That did not work. Try again.',
          );
        },
      });
  }

  protected setJobFilter(value: string): void {
    this.jobFilter.set(value);
    this.loadJobs();
  }

  private loadJobs(): void {
    this.jobsSvc.list(this.jobFilter() || undefined).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (page) => this.jobs.set(page.results.slice(0, 20)),
      error: () => this.jobs.set([]),
    });
  }

  resendVerification(): void {
    this.verification.resend();
  }

  save(): void {
    this.auth.updateProfile({ display_name: this.displayName })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: () => this.toast.success('Profile updated'),
      error: () => this.toast.error('Could not update profile'),
    });
  }
}
