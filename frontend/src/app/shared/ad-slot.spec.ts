import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { ConfigService } from '../core/services/config.service';
import { ConsentService } from '../core/services/consent.service';
import { AdSlot, resetProviderScript } from './ad-slot';

@Component({
  imports: [AdSlot],
  template: '<app-ad-slot name="landing" [height]="250" />',
})
class Host {}

const ADS_ON = {
  principal: 'guest', limits: {}, guest: {}, features: { ads_enabled: true },
  guest_ttl_hours: 24, turnstile_site_key: '',
  ads: {
    enabled: true, provider: 'adsense', client_id: 'ca-pub-123',
    slots: { landing: '333' },
  },
  consent_required: true,
  retention: { guest_hours: 24, trash_days: 30, export_hours: 24 },
};

/**
 * The ad layer's promises, asserted rather than described (§9A): nothing loads
 * without consent, nothing loads when the flag is off, the box is reserved
 * before the ad arrives, and the script is requested exactly once.
 */
describe('AdSlot', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    resetProviderScript();
    document.head.querySelectorAll('script[src*="adsbygoogle"]')
      .forEach((node) => node.remove());
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => localStorage.clear());

  function loadConfig(body: Record<string, unknown> = ADS_ON): void {
    TestBed.inject(ConfigService).config().subscribe();
    http.expectOne((r) => r.url.includes('/config/')).flush(body);
  }

  function scriptCount(): number {
    return document.head.querySelectorAll('script[src*="adsbygoogle"]').length;
  }

  it('renders nothing and loads nothing when ads are disabled', () => {
    loadConfig({ ...ADS_ON, ads: { enabled: false } });
    TestBed.inject(ConsentService).set('granted');

    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test=ad-slot-landing]'))
      .toBeNull();
    expect(scriptCount()).toBe(0);
  });

  it('renders nothing and loads nothing until consent is given', () => {
    loadConfig();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-test=ad-slot-landing]'))
      .toBeNull();
    // The banner is worthless if the tag is already running behind it.
    expect(scriptCount()).toBe(0);
  });

  it('renders nothing when consent was declined', () => {
    loadConfig();
    TestBed.inject(ConsentService).set('denied');
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test=ad-slot-landing]'))
      .toBeNull();
    expect(scriptCount()).toBe(0);
  });

  it('renders with a reserved height once consent is granted', () => {
    loadConfig();
    TestBed.inject(ConsentService).set('granted');
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const slot = fixture.nativeElement.querySelector('[data-test=ad-slot-landing]');
    expect(slot).not.toBeNull();
    // Reserved *before* the ad arrives: layout shift under somebody's cursor
    // mid-task is worse than the revenue is worth.
    expect(slot.style.minHeight).toBe('250px');
    expect(scriptCount()).toBe(1);
  });

  it('requests the provider script exactly once for several slots', () => {
    loadConfig();
    TestBed.inject(ConsentService).set('granted');
    TestBed.createComponent(Host).detectChanges();
    TestBed.createComponent(Host).detectChanges();
    expect(scriptCount()).toBe(1);
  });

  it('renders nothing for a slot with no unit configured', () => {
    loadConfig({ ...ADS_ON, ads: { ...ADS_ON.ads, slots: {} } });
    TestBed.inject(ConsentService).set('granted');
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-test=ad-slot-landing]'))
      .toBeNull();
  });

  it('names the routes that never carry advertising', () => {
    // The signing ceremony, the verification page and the legal pages are
    // trust surfaces. This is a code-level refusal, not a convention.
    expect(AdSlot.FORBIDDEN).toEqual(['/s/', '/verify', '/legal/']);
  });
});

describe('ConsentService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  afterEach(() => localStorage.clear());

  it('remembers a choice across reloads', () => {
    TestBed.inject(ConsentService).set('denied');
    expect(localStorage.getItem('zen_ad_consent')).toBe('denied');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    expect(TestBed.inject(ConsentService).choice()).toBe('denied');
  });

  it('defaults Consent Mode to denied before anything is decided', () => {
    const layer = (window as unknown as { dataLayer?: unknown[] });
    layer.dataLayer = [];
    TestBed.inject(ConsentService);
    const [call] = layer.dataLayer as [string, string, Record<string, string>][];
    expect(call[0]).toBe('consent');
    expect(call[1]).toBe('default');
    expect(call[2]['ad_storage']).toBe('denied');
  });
});
