import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../core/services/config.service';
import { ConsentService } from '../core/services/consent.service';
import { ConsentBanner } from './consent-banner';

@Component({ imports: [ConsentBanner], template: '<app-consent-banner />' })
class Host {}

const CONFIG = {
  principal: 'guest', limits: {}, guest: {}, features: { ads_enabled: true },
  guest_ttl_hours: 24, turnstile_site_key: '',
  ads: { enabled: true, provider: 'adsense', client_id: 'ca-pub-123', slots: {} },
  consent_required: true,
  retention: { guest_hours: 24, trash_days: 30, export_hours: 24 },
};

/**
 * The consent banner (§9A): shown only where a question is required and
 * only until it is answered; two buttons of equal weight; a choice that
 * survives a reload so the question is never asked twice.
 */
describe('ConsentBanner', () => {
  let fixture: ComponentFixture<Host>;
  let http: HttpTestingController;

  function configure(): void {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
  }

  function loadConfig(body: Record<string, unknown> = CONFIG): void {
    TestBed.inject(ConfigService).config().subscribe();
    http.expectOne((r) => r.url.includes('/config/')).flush(body);
  }

  function mount(): void {
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  }

  function banner(): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-test=consent-banner]');
  }

  beforeEach(() => {
    localStorage.clear();
    configure();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('asks when ads are on, consent is required and nothing has been decided', () => {
    loadConfig();
    mount();
    const el = banner()!;
    expect(el).not.toBeNull();
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-label')).toBe('Cookies and advertising');
    expect(el.querySelector('[data-test=consent-privacy]')?.getAttribute('href')).toBe('/legal/privacy');
  });

  it('offers refusing and allowing with the same weight, refuse first', () => {
    loadConfig();
    mount();
    const buttons = [...banner()!.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('data-test'))).toEqual(['consent-deny', 'consent-accept']);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['No thanks', 'Allow']);
    expect(buttons.map((b) => b.className)).toEqual(['btn btn-secondary', 'btn btn-secondary']);
  });

  it('stays silent before the config has arrived — nothing is asked on a guess', () => {
    mount();
    expect(banner()).toBeNull();
  });

  it('stays silent where consent is not required', () => {
    loadConfig({ ...CONFIG, consent_required: false });
    mount();
    expect(banner()).toBeNull();
  });

  it('stays silent when ads are off, whatever the region', () => {
    loadConfig({ ...CONFIG, ads: { enabled: false } });
    mount();
    expect(banner()).toBeNull();
  });

  it.each([
    ['consent-accept', 'granted'],
    ['consent-deny', 'denied'],
  ] as const)('records the choice behind %s as %s and goes away', (button, choice) => {
    loadConfig();
    mount();
    banner()!.querySelector<HTMLButtonElement>(`[data-test=${button}]`)!.click();
    fixture.detectChanges();

    expect(TestBed.inject(ConsentService).choice()).toBe(choice);
    expect(localStorage.getItem('zen_ad_consent')).toBe(choice);
    expect(banner()).toBeNull();
  });

  it('does not ask again on the next visit once a choice is stored', () => {
    localStorage.setItem('zen_ad_consent', 'denied');
    loadConfig();
    mount();
    expect(banner()).toBeNull();
  });

  it('asks again when the choice is reset from the settings screen', () => {
    loadConfig();
    mount();
    banner()!.querySelector<HTMLButtonElement>('[data-test=consent-accept]')!.click();
    fixture.detectChanges();
    expect(banner()).toBeNull();

    TestBed.inject(ConsentService).reset();
    fixture.detectChanges();
    expect(banner()).not.toBeNull();
  });
});
