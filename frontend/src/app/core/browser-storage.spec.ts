import { TestBed } from '@angular/core/testing';
import { PLATFORM_ID } from '@angular/core';

import { inBrowser, usableLocalStorage } from './browser-storage';
import { GuestTokenService } from './services/guest-token.service';
import { ThemeService } from './services/theme.service';
import { TokenService } from './services/token.service';

/**
 * The regression this file exists for: a `localStorage` that **exists** and
 * cannot be **used**.
 *
 * Node 25 ships exactly that — a bare object with no methods — and the old
 * `typeof localStorage === 'undefined'` guard handed it to three services as if
 * it were storage. The stub below is that object. Nothing here depends on the
 * host's own storage, so the assertions hold on node 24 and node 25 alike.
 */
function withStubbedLocalStorage(stub: unknown, body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: stub,
    configurable: true,
    writable: true,
  });
  try {
    body();
  } finally {
    if (original) {
      Object.defineProperty(globalThis, 'localStorage', original);
    } else {
      delete (globalThis as Record<string, unknown>)['localStorage'];
    }
  }
}

/** Node 25's global: an object, and nothing else. */
const HALF_PRESENT = {};

describe('usableLocalStorage', () => {
  it('rejects a localStorage that exists but has no getItem', () => {
    withStubbedLocalStorage(HALF_PRESENT, () => {
      expect(usableLocalStorage(true)).toBeNull();
    });
  });

  it('rejects storage outside a browser platform, however complete it looks', () => {
    // The prerender case: node's own storage answers every method once
    // `--localstorage-file` is valid, and writing a visitor's token onto the
    // build machine's disk is not a thing this app should ever do. A working
    // storage is present here — the platform is the only reason for the null.
    expect(typeof localStorage.getItem).toBe('function');
    expect(usableLocalStorage(false)).toBeNull();
  });

  it('accepts a real storage in a browser', () => {
    expect(usableLocalStorage(true)).toBe(localStorage);
  });

  it('returns null when reading the global itself throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new DOMException('cookies are blocked', 'SecurityError');
      },
      configurable: true,
    });
    try {
      expect(usableLocalStorage(true)).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', original!);
    }
  });
});

describe('inBrowser', () => {
  it('follows PLATFORM_ID rather than the presence of a global', () => {
    TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: 'server' }] });
    expect(TestBed.runInInjectionContext(() => inBrowser())).toBe(false);
  });
});

/**
 * The three services, constructed against the half-present storage.
 *
 * Construction is the part that used to explode: `TokenService`'s constructor
 * reads storage immediately, which is why a broken guard took 29 prerendered
 * routes and 110 unit tests down with it rather than degrading quietly.
 */
describe('the storage-backed services under a half-present localStorage', () => {
  it('TokenService constructs, reads null and falls back to memory', () => {
    withStubbedLocalStorage(HALF_PRESENT, () => {
      TestBed.configureTestingModule({});
      const tokens = TestBed.inject(TokenService);
      expect(tokens.access).toBeNull();
      expect(tokens.isAuthenticated).toBe(false);

      // A write cannot persist, and must not throw either: the session still
      // has to work for as long as the tab is open.
      tokens.set('access-1', 'refresh-1');
      expect(tokens.access).toBe('access-1');
      expect(tokens.refresh).toBe('refresh-1');
      tokens.clear();
      expect(tokens.access).toBeNull();
    });
  });

  it('GuestTokenService constructs and keeps the token in memory', () => {
    withStubbedLocalStorage(HALF_PRESENT, () => {
      TestBed.configureTestingModule({});
      const guests = TestBed.inject(GuestTokenService);
      expect(guests.token).toBeNull();
      guests.set('guest-1');
      expect(guests.token).toBe('guest-1');
      guests.clear();
      expect(guests.hasToken).toBe(false);
    });
  });

  it('ThemeService constructs and keeps the default preference', () => {
    withStubbedLocalStorage(HALF_PRESENT, () => {
      TestBed.configureTestingModule({});
      const themes = TestBed.inject(ThemeService);
      expect(themes.preference()).toBe('system');
      themes.set('dark');
      expect(themes.preference()).toBe('dark');
      expect(themes.resolved()).toBe('dark');
    });
  });
});
