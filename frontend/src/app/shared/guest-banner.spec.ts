import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GuestFacade } from '../abstraction/guest.facade';
import { GuestBanner } from './guest-banner';

@Component({ imports: [GuestBanner], template: '<app-guest-banner />' })
class Host {}

const BASE = {
  principal: 'guest', limits: {}, features: { ads_enabled: false },
  guest_ttl_hours: 24, turnstile_site_key: '', ads: { enabled: false },
  consent_required: false,
  retention: { guest_hours: 24, trash_days: 30, export_hours: 24 },
};

/**
 * Guest affordances (architecture §21.4, §21.5): expiry must be legible but
 * calm, the signup is a plain link, and none of it shows to somebody who is
 * signed in or has not started a session at all.
 */
describe('GuestBanner', () => {
  let fixture: ComponentFixture<Host>;
  let http: HttpTestingController;
  let guests: GuestFacade;

  function el(test: string): HTMLElement | null {
    return fixture.nativeElement.querySelector(`[data-test=${test}]`);
  }

  /** The session the server reports, flushed into the facade. */
  function serveGuest(seconds_remaining: number | undefined): void {
    guests.loadConfig();
    http.expectOne((r) => r.url.includes('/config/')).flush({
      ...BASE,
      guest: seconds_remaining === undefined ? {} : { id: 'g1', seconds_remaining, expires_at: '2026-01-01T00:00:00Z' },
    });
    fixture.detectChanges();
  }

  function mount(): void {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    guests = TestBed.inject(GuestFacade);
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  }

  beforeEach(() => localStorage.clear());

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('shows nothing to a visitor with no session', () => {
    mount();
    expect(el('guest-banner')).toBeNull();
    expect(el('guest-expired-notice')).toBeNull();
    expect(el('account-required-prompt')).toBeNull();
  });

  it('shows nothing to a guest whose session the server has not described yet', () => {
    localStorage.setItem('zen_guest', 'tok');
    mount();
    expect(guests.principal()).toBe('guest');
    expect(el('guest-banner')).toBeNull();
    serveGuest(undefined);
    expect(el('guest-banner')).toBeNull();
  });

  it('tells a guest how long their files have, with a signup link, not a button', () => {
    localStorage.setItem('zen_guest', 'tok');
    mount();
    serveGuest(2 * 3600 + 600);
    const banner = el('guest-banner')!;
    expect(banner).not.toBeNull();
    expect(el('guest-time-left')?.textContent).toBe('2 hours left');
    const cta = el('guest-banner-cta') as HTMLAnchorElement;
    expect(cta.tagName).toBe('A');
    expect(cta.getAttribute('href')).toBe('/auth/register');
    expect(cta.textContent?.trim()).toBe('Create a free account to keep these files');
  });

  it.each([
    [3600, '1 hour left'],
    [7199, '1 hour left'],
    [59 * 60, '59 minutes left'],
    [60, '1 minute left'],
    [5, '1 minute left'],
  ])('labels %i seconds as "%s"', (seconds, label) => {
    localStorage.setItem('zen_guest', 'tok');
    mount();
    serveGuest(seconds);
    expect(el('guest-time-left')?.textContent).toBe(label);
  });

  it('shows no guest banner to a signed-in user', () => {
    localStorage.setItem('zen_access', 'jwt');
    localStorage.setItem('zen_guest', 'tok');
    mount();
    expect(guests.principal()).toBe('user');
    serveGuest(3600);
    expect(el('guest-banner')).toBeNull();
  });

  it('says so when a session ended with work open, until dismissed', () => {
    mount();
    guests.noteSessionExpired();
    fixture.detectChanges();
    const notice = el('guest-expired-notice')!;
    expect(notice.textContent).toContain('Your guest session ended and those files were deleted.');

    notice.querySelector('button')!.click();
    fixture.detectChanges();
    expect(el('guest-expired-notice')).toBeNull();
    expect(guests.expiredNotice()).toBe(false);
  });

  it('turns an account-only refusal into a signup prompt, until dismissed', () => {
    mount();
    guests.onAccountRequired('Folders need a free account.');
    fixture.detectChanges();
    const prompt = el('account-required-prompt')!;
    expect(prompt.textContent).toContain('Folders need a free account.');
    expect(el('account-required-cta')?.getAttribute('href')).toBe('/auth/register');

    prompt.querySelector('button')!.click();
    fixture.detectChanges();
    expect(el('account-required-prompt')).toBeNull();
  });

  it('never leaves a guest without words when the server sends an empty reason', () => {
    mount();
    guests.onAccountRequired('');
    fixture.detectChanges();
    expect(el('account-required-prompt')?.textContent).toContain('Create a free account to use this feature.');
  });

  it('drops the banner once the guest token is discarded after a claim', () => {
    localStorage.setItem('zen_guest', 'tok');
    mount();
    serveGuest(3600);
    expect(el('guest-banner')).not.toBeNull();

    guests.discardAfterClaim();
    fixture.detectChanges();
    expect(el('guest-banner')).toBeNull();
  });
});
