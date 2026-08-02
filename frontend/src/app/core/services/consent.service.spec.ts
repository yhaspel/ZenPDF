import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { regionOfBrowser } from './config.service';

/**
 * The region signal (§9A).
 *
 * The bug this pins is a quiet one: reading the country out of
 * `navigator.language` tells a visitor in Berlin they are American, because
 * `en-US` is the most common language tag in the world — and the consent
 * banner they are entitled to never appears.
 */
describe('regionOfBrowser', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  function withTimeZone(timeZone: string): void {
    vi.spyOn(Intl, 'DateTimeFormat').mockReturnValue({
      resolvedOptions: () => ({ timeZone }),
    } as unknown as Intl.DateTimeFormat);
  }

  it('reads the timezone, not the UI locale', () => {
    withTimeZone('Europe/Berlin');
    // The machine is in Germany and its interface is in English — the common
    // case this exists for.
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
    expect(regionOfBrowser()).toBe('DE');
  });

  it('maps every consent-region zone it claims to', () => {
    withTimeZone('Europe/Dublin');
    expect(regionOfBrowser()).toBe('IE');
    withTimeZone('Europe/Zurich');
    expect(regionOfBrowser()).toBe('CH');
    withTimeZone('Europe/London');
    expect(regionOfBrowser()).toBe('GB');
  });

  it('says nothing rather than guessing for an unknown zone', () => {
    // The server treats "no region" as "ask", which is the safe direction to
    // be wrong in.
    withTimeZone('America/New_York');
    expect(regionOfBrowser()).toBe('');
    withTimeZone('');
    expect(regionOfBrowser()).toBe('');
  });
});
