import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';

import { AuthFacade } from '../../abstraction/auth.facade';
import { DocumentsFacade } from '../../abstraction/documents.facade';
import { Job, Paginated, Usage, User } from '../../core/models/models';
import { ConfigService } from '../../core/services/config.service';
import { ConsentService } from '../../core/services/consent.service';
import { JobsService } from '../../core/services/jobs.service';
import { VerificationService } from '../../core/services/verification.service';
import { ToastService } from '../../shared/toast.service';
import { Settings } from './settings';

@Component({ template: '' })
class Blank {}

/**
 * The settings page (§9B, §10.1).
 *
 * Five pieces of product promise live on this one screen and each is cheap to
 * break silently: the profile save must send the display name the person
 * typed; the verification banner must appear only for an unverified address
 * and say what it gates; the usage counters must read the facade's numbers,
 * not a stale snapshot; the export must be *fetched* (an `<a href>` carries no
 * JWT and lands on a 401); and account deletion — the product's only
 * irreversible action — must ask for the password first and tell the truth
 * about what was kept. The consent card is the withdrawal that §9A requires.
 */
describe('Settings', () => {
  let fixture: ComponentFixture<Settings>;
  let http: HttpTestingController;
  let user: ReturnType<typeof signal<User | null>>;
  let usage: ReturnType<typeof signal<Usage | null>>;
  let adsEnabled: boolean;
  let updateProfile: ReturnType<typeof vi.fn>;
  let logout: ReturnType<typeof vi.fn>;
  let refreshUsage: ReturnType<typeof vi.fn>;
  let listJobs: ReturnType<typeof vi.fn>;
  let resend: ReturnType<typeof vi.fn>;
  let sending: ReturnType<typeof signal<boolean>>;
  let sent: ReturnType<typeof signal<boolean>>;

  const USER: User = {
    id: 'u1',
    email: 'sam@example.com',
    display_name: 'Sam',
    email_verified: true,
    accepted_tos_at: null,
    storage_bytes_used: 0,
    date_joined: '2026-08-01T00:00:00Z',
  };

  const USAGE: Usage = {
    period: '2026-10',
    principal: 'user',
    tier: 'free',
    storage: { used_bytes: 1_572_864, quota_bytes: 104_857_600 },
    counters: { sign_requests: 2, ocr_pages: 17, conversions: 4, heavy_ops: 1, metered_ops_this_hour: 3 },
    limits: {
      sign_requests_per_month: 10,
      ocr_pages_per_month: 200,
      metered_ops_per_hour: 20,
    } as Usage['limits'],
  };

  function job(partial: Partial<Job>): Job {
    return {
      id: 'j1', type: 'merge', document: null, status: 'succeeded', progress: 100,
      params: {}, base_version_seq: null, error_code: '', error_message: '',
      error_details: {}, result: null, created_at: '2026-10-01T10:00:00Z',
      started_at: null, finished_at: null,
      ...partial,
    } as Job;
  }

  function page(results: Job[]): Paginated<Job> {
    return { count: results.length, next: null, previous: null, results };
  }

  function render(opts: { user?: User; jobs?: Job[]; ads?: boolean } = {}): HTMLElement {
    user = signal<User | null>(opts.user ?? USER);
    usage = signal<Usage | null>(USAGE);
    adsEnabled = opts.ads ?? false;
    updateProfile = vi.fn((body: Partial<User>) => of({ ...USER, ...body }));
    logout = vi.fn();
    refreshUsage = vi.fn();
    listJobs = vi.fn(() => of(page(opts.jobs ?? [])));
    resend = vi.fn();
    sending = signal(false);
    sent = signal(false);
    localStorage.removeItem('zen_ad_consent');

    TestBed.configureTestingModule({
      imports: [Settings],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: AuthFacade, useValue: { user, updateProfile, logout } },
        {
          provide: DocumentsFacade,
          useValue: { usage, storagePercent: signal(2), refreshUsage },
        },
        { provide: ConfigService, useValue: { ads: () => ({ enabled: adsEnabled }), consentRequired: () => true } },
        { provide: JobsService, useValue: { list: listJobs } },
        { provide: VerificationService, useValue: { sending, sent, resend } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(Settings);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const q = <T extends HTMLElement>(sel: string) =>
    fixture.nativeElement.querySelector(sel) as T | null;
  const toasts = () => TestBed.inject(ToastService).toasts();

  function type(sel: string, value: string): void {
    const input = q<HTMLInputElement>(sel)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  afterEach(() => {
    http.verify();
    localStorage.removeItem('zen_ad_consent');
    TestBed.resetTestingModule();
  });

  describe('profile', () => {
    it('shows the address read-only and the current display name', async () => {
      render();
      await fixture.whenStable();
      fixture.detectChanges();
      const email = q<HTMLInputElement>('#settings-email')!;
      expect(email.value).toBe('sam@example.com');
      expect(email.disabled).toBe(true);
      expect(q<HTMLInputElement>('[data-test="display-name"]')!.value).toBe('Sam');
    });

    it('saves exactly the display name that was typed and confirms it', () => {
      render();
      type('[data-test="display-name"]', 'Samantha');
      q('[data-test="save-profile"]')!.click();
      expect(updateProfile).toHaveBeenCalledWith({ display_name: 'Samantha' });
      expect(toasts().map((t) => [t.type, t.message])).toEqual([['success', 'Profile updated']]);
    });

    it('says so when the save is refused', () => {
      render();
      updateProfile.mockReturnValue(throwError(() => new Error('nope')));
      q('[data-test="save-profile"]')!.click();
      expect(toasts().map((t) => [t.type, t.message])).toEqual([['error', 'Could not update profile']]);
    });
  });

  describe('email verification', () => {
    it('shows nothing to a verified address', () => {
      render();
      expect(q('[data-test="verify-banner"]')).toBeNull();
    });

    it('offers an unverified address the link, saying only sending is gated', () => {
      render({ user: { ...USER, email_verified: false } });
      const banner = q('[data-test="verify-banner"]')!;
      expect(banner.textContent).toContain('send documents to other people for signature');
      expect(banner.textContent).toContain('Everything else works already');
      q('[data-test="resend-verification"]')!.click();
      expect(resend).toHaveBeenCalledTimes(1);
    });

    it('reports the send and disables the button while it is in flight', () => {
      render({ user: { ...USER, email_verified: false } });
      sending.set(true);
      fixture.detectChanges();
      expect(q<HTMLButtonElement>('[data-test="resend-verification"]')!.disabled).toBe(true);
      sending.set(false);
      sent.set(true);
      fixture.detectChanges();
      expect(q('[data-test="resend-verification"]')!.textContent).toContain('Sent — check your inbox');
    });
  });

  describe('storage and usage', () => {
    it('asks for fresh usage on arrival', () => {
      render();
      expect(refreshUsage).toHaveBeenCalledTimes(1);
    });

    it('renders used of quota in megabytes, and each counter against its limit', () => {
      const el = render();
      expect(el.textContent).toContain('1.5 MB of 100 MB used');
      expect(q('[data-test="usage-sign"]')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('2 / 10');
      expect(q('[data-test="usage-ocr"]')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('17 / 200');
      expect(q('[data-test="usage-metered"]')!.textContent!.replace(/\s+/g, ' ').trim()).toBe('3 / 20');
    });

    it('follows the facade when the numbers change', () => {
      render();
      usage.set({ ...USAGE, counters: { ...USAGE.counters, sign_requests: 9 } });
      fixture.detectChanges();
      expect(q('[data-test="usage-sign"]')!.textContent).toContain('9 / 10');
    });

    it('draws no table before usage has arrived', () => {
      render();
      usage.set(null);
      fixture.detectChanges();
      expect(q('[data-test="usage-table"]')).toBeNull();
    });
  });

  describe('recent jobs', () => {
    it('lists the most recent jobs, capped at twenty, or says there are none', () => {
      render();
      expect(q('[data-test="job-history-empty"]')).not.toBeNull();
      TestBed.resetTestingModule();

      const many = Array.from({ length: 25 }, (_, i) => job({ id: `j${i}`, type: i % 2 ? 'ocr' : 'merge' }));
      render({ jobs: many });
      expect(q('[data-test="job-history-empty"]')).toBeNull();
      expect(fixture.nativeElement.querySelectorAll('[data-test="job-row"]').length).toBe(20);
      expect(q('[data-test="job-row"]')!.textContent).toContain('merge');
    });

    it('asks the server for the chosen status when a filter is picked', () => {
      render();
      expect(listJobs).toHaveBeenLastCalledWith(undefined);
      q('[data-test="job-filter-failed"]')!.click();
      expect(listJobs).toHaveBeenLastCalledWith('failed');
      fixture.detectChanges();
      expect(q('[data-test="job-filter-failed"]')!.classList).toContain('seg-active');
      q('[data-test="job-filter-all"]')!.click();
      expect(listJobs).toHaveBeenLastCalledWith(undefined);
    });

    it('shows an empty history rather than a broken one when the list fails', () => {
      render({ jobs: [job({})] });
      expect(q('[data-test="job-row"]')).not.toBeNull();
      listJobs.mockReturnValue(throwError(() => new Error('503')));
      q('[data-test="job-filter-running"]')!.click();
      fixture.detectChanges();
      expect(q('[data-test="job-history-empty"]')).not.toBeNull();
    });
  });

  describe('advertising consent', () => {
    it('is absent when ads are off — nothing to withdraw', () => {
      render({ ads: false });
      expect(q('[data-test="consent-settings"]')).toBeNull();
    });

    it('shows the current choice and persists a change of mind', () => {
      render({ ads: true });
      expect(q('[data-test="consent-choice"]')!.textContent).toContain('not decided yet');

      q('[data-test="settings-consent-allow"]')!.click();
      fixture.detectChanges();
      expect(q('[data-test="consent-choice"]')!.textContent).toContain('personalised ads allowed');
      expect(localStorage.getItem('zen_ad_consent')).toBe('granted');
      expect(TestBed.inject(ConsentService).choice()).toBe('granted');

      q('[data-test="settings-consent-deny"]')!.click();
      fixture.detectChanges();
      expect(q('[data-test="consent-choice"]')!.textContent).toContain('personalised ads declined');
      expect(localStorage.getItem('zen_ad_consent')).toBe('denied');
    });
  });

  describe('export', () => {
    let realCreate: typeof URL.createObjectURL;
    let realRevoke: typeof URL.revokeObjectURL;
    let clicks: string[];

    beforeEach(() => {
      realCreate = URL.createObjectURL;
      realRevoke = URL.revokeObjectURL;
      URL.createObjectURL = () => 'blob:export';
      URL.revokeObjectURL = () => undefined;
      clicks = [];
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(this.download);
      });
    });

    afterEach(() => {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
      vi.restoreAllMocks();
    });

    it('fetches the archive with the client (so the JWT travels) and saves it dated', () => {
      render();
      q('[data-test="export-data"]')!.click();
      fixture.detectChanges();
      expect(q<HTMLButtonElement>('[data-test="export-data"]')!.disabled).toBe(true);
      expect(q('[data-test="export-data"]')!.textContent).toContain('Preparing');

      const req = http.expectOne({ method: 'GET', url: '/api/users/me/export/' });
      expect(req.request.responseType).toBe('blob');
      req.flush(new Blob(['zip'], { type: 'application/zip' }));
      fixture.detectChanges();

      expect(clicks).toEqual([`zenpdf-export-${new Date().toISOString().slice(0, 10)}.zip`]);
      expect(q<HTMLButtonElement>('[data-test="export-data"]')!.disabled).toBe(false);
    });

    it('releases the button and says so when the export fails', () => {
      render();
      q('[data-test="export-data"]')!.click();
      http.expectOne('/api/users/me/export/').flush(null, { status: 500, statusText: 'Error' });
      fixture.detectChanges();
      expect(clicks).toEqual([]);
      expect(q<HTMLButtonElement>('[data-test="export-data"]')!.disabled).toBe(false);
      expect(toasts().map((t) => t.type)).toEqual(['error']);
    });
  });

  describe('account deletion', () => {
    it('sends nothing until the confirmation step has a password', () => {
      render();
      expect(q('[data-test="delete-confirm"]')).toBeNull();
      q('[data-test="delete-account"]')!.click();
      fixture.detectChanges();

      const panel = q('[data-test="delete-confirm"]')!;
      expect(panel.textContent).toContain('cannot be undone');
      expect(panel.textContent).toContain('already signed are kept');
      expect(q<HTMLButtonElement>('[data-test="delete-confirm-yes"]')!.disabled).toBe(true);
      q<HTMLButtonElement>('[data-test="delete-confirm-yes"]')!.click();
      http.expectNone('/api/users/me/delete/');

      type('[data-test="delete-password"]', 'hunter2');
      expect(q<HTMLButtonElement>('[data-test="delete-confirm-yes"]')!.disabled).toBe(false);
      http.expectNone('/api/users/me/delete/');
    });

    it('deletes with the password, ends the session and reports what was removed and kept', () => {
      render();
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      q('[data-test="delete-account"]')!.click();
      fixture.detectChanges();
      type('[data-test="delete-password"]', 'hunter2');
      q('[data-test="delete-confirm-yes"]')!.click();

      const req = http.expectOne({ method: 'DELETE', url: '/api/users/me/delete/' });
      expect(req.request.body).toEqual({ password: 'hunter2' });
      req.flush({ documents: 3, sign_requests_retained: 1 });
      fixture.detectChanges();

      expect(logout).toHaveBeenCalledTimes(1);
      expect(toasts().length).toBe(1);
      expect(toasts()[0].type).toBe('success');
      expect(toasts()[0].message).toContain('3 document(s) removed');
      expect(toasts()[0].message).toContain('1 signed envelope(s) were kept');
      expect(navigate).toHaveBeenCalledWith('/');
    });

    it('does not mention kept envelopes when there were none', () => {
      render();
      vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
      q('[data-test="delete-account"]')!.click();
      fixture.detectChanges();
      type('[data-test="delete-password"]', 'hunter2');
      q('[data-test="delete-confirm-yes"]')!.click();
      http.expectOne('/api/users/me/delete/').flush({ documents: 0, sign_requests_retained: 0 });
      expect(toasts()[0].message).toBe('Account deleted. 0 document(s) removed.');
    });

    it("shows the server's refusal next to the password and keeps the session", () => {
      render();
      q('[data-test="delete-account"]')!.click();
      fixture.detectChanges();
      type('[data-test="delete-password"]', 'wrong');
      q('[data-test="delete-confirm-yes"]')!.click();
      http.expectOne('/api/users/me/delete/').flush(
        { error: { code: 'invalid_password', message: 'That password is not right.' } },
        { status: 400, statusText: 'Bad Request' },
      );
      fixture.detectChanges();

      expect(q('[data-test="delete-error"]')!.textContent).toContain('That password is not right.');
      expect(q('[data-test="delete-password"]')!.getAttribute('aria-invalid')).toBe('true');
      expect(logout).not.toHaveBeenCalled();
      expect(q<HTMLButtonElement>('[data-test="delete-confirm-yes"]')!.disabled).toBe(false);
    });

    it('falls back to a plain sentence when the refusal carries no message', () => {
      render();
      q('[data-test="delete-account"]')!.click();
      fixture.detectChanges();
      type('[data-test="delete-password"]', 'x');
      q('[data-test="delete-confirm-yes"]')!.click();
      http.expectOne('/api/users/me/delete/').flush(null, { status: 503, statusText: 'Unavailable' });
      fixture.detectChanges();
      expect(q('[data-test="delete-error"]')!.textContent).toContain('That did not work. Try again.');
    });

    it('can be cancelled, leaving the account alone', () => {
      render();
      q('[data-test="delete-account"]')!.click();
      fixture.detectChanges();
      const cancel = [...fixture.nativeElement.querySelectorAll('[data-test="delete-confirm"] button')]
        .find((b: HTMLButtonElement) => b.textContent!.trim() === 'Cancel') as HTMLButtonElement;
      cancel.click();
      fixture.detectChanges();
      expect(q('[data-test="delete-confirm"]')).toBeNull();
      http.expectNone('/api/users/me/delete/');
    });
  });

  it('declares no ad slot of its own', () => {
    const el = render({ ads: true });
    expect(el.querySelector('app-ad-slot')).toBeNull();
  });
});
