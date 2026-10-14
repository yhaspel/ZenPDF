import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FakeMediaMatcher } from '../../shared/fake-media-matcher';
import { ThemePreference, ThemeService } from './theme.service';

const KEY = 'zenpdf.theme';

/**
 * jsdom has no `matchMedia`. The service reads the global, so the seam is
 * the global: CDK's `FakeMediaMatcher` already knows how to be a list a test
 * can flip, and it records the query so a wrong one would show.
 */
let os: FakeMediaMatcher;
let queries: string[];

function installMatchMedia(dark: boolean): void {
  os = new FakeMediaMatcher(dark);
  queries = [];
  const matchMedia = (query: string) => {
    queries.push(query);
    return os.matchMedia();
  };
  // The service reads the bare global; the boot script reads `window.`. Under
  // vitest's jsdom those are two objects.
  (globalThis as { matchMedia?: unknown }).matchMedia = matchMedia;
  (window as { matchMedia?: unknown }).matchMedia = matchMedia;
}

function uninstallMatchMedia(): void {
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  delete (window as { matchMedia?: unknown }).matchMedia;
}

function installThemeColorMetas(): void {
  for (const scheme of ['light', 'dark']) {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.setAttribute('media', `(prefers-color-scheme: ${scheme})`);
    meta.content = scheme === 'light' ? '#F5F1E6' : '#171310';
    meta.dataset['spec'] = 'theme';
    document.head.appendChild(meta);
  }
}

function metaColors(): string[] {
  return [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')]
    .map((m) => m.content);
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

function service(): ThemeService {
  const theme = TestBed.inject(ThemeService);
  // The class is applied from an effect, which runs at the next tick.
  TestBed.tick();
  return theme;
}

/**
 * Light → Dark → System, persisted, following the OS under System, and
 * never disagreeing with the boot script that painted the first frame
 * (design contract §5).
 */
describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    installThemeColorMetas();
    installMatchMedia(false);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.head.querySelectorAll('meta[data-spec=theme]').forEach((m) => m.remove());
    uninstallMatchMedia();
  });

  it('defaults to System and asks the OS the right question', () => {
    const theme = service();
    expect(theme.preference()).toBe('system');
    expect(queries).toEqual(['(prefers-color-scheme: dark)']);
    expect(theme.resolved()).toBe('light');
    expect(isDark()).toBe(false);
  });

  it('cycles Light → Dark → System → Light', () => {
    const theme = service();
    theme.set('light');
    const seen: ThemePreference[] = [theme.preference()];
    for (let i = 0; i < 3; i += 1) {
      theme.cycle();
      seen.push(theme.preference());
    }
    expect(seen).toEqual(['light', 'dark', 'system', 'light']);
  });

  it('paints the html element to match the preference', () => {
    const theme = service();
    theme.set('dark');
    TestBed.tick();
    expect(theme.resolved()).toBe('dark');
    expect(isDark()).toBe(true);

    theme.set('light');
    TestBed.tick();
    expect(isDark()).toBe(false);
  });

  it('persists every choice under its key', () => {
    const theme = service();
    theme.set('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
    theme.cycle();
    expect(localStorage.getItem(KEY)).toBe('system');
  });

  it.each(['light', 'dark', 'system'] as const)('restores a stored %s on the next load', (stored) => {
    localStorage.setItem(KEY, stored);
    installMatchMedia(true);
    const theme = service();
    expect(theme.preference()).toBe(stored);
    expect(isDark()).toBe(stored !== 'light');
  });

  it('ignores a stored value it does not understand', () => {
    localStorage.setItem(KEY, 'sepia');
    expect(service().preference()).toBe('system');
  });

  it('follows the OS while System is active, and stops following once a mode is forced', () => {
    const theme = service();
    expect(isDark()).toBe(false);

    os.resize(true);
    TestBed.tick();
    expect(theme.resolved()).toBe('dark');
    expect(isDark()).toBe(true);

    theme.set('light');
    TestBed.tick();
    expect(isDark()).toBe(false);
    os.resize(false);
    os.resize(true);
    TestBed.tick();
    expect(isDark()).toBe(false);
  });

  it('keeps the browser chrome on the same paper', () => {
    const theme = service();
    // Under System each meta keeps its own colour and the browser picks.
    expect(metaColors()).toEqual(['#F5F1E6', '#171310']);

    theme.set('dark');
    TestBed.tick();
    expect(metaColors()).toEqual(['#171310', '#171310']);

    theme.set('light');
    TestBed.tick();
    expect(metaColors()).toEqual(['#F5F1E6', '#F5F1E6']);

    theme.set('system');
    TestBed.tick();
    expect(metaColors()).toEqual(['#F5F1E6', '#171310']);
  });

  it('survives a storage that refuses to write', () => {
    const theme = service();
    // Patch whichever object answers `setItem`: jsdom's `Storage.prototype` on
    // node 24, the own-property stub `test-setup.ts` installs on node 25.
    const owner: { setItem: Storage['setItem'] } =
      Object.hasOwn(localStorage, 'setItem') ? localStorage : Storage.prototype;
    const setItem = owner.setItem;
    owner.setItem = () => { throw new DOMException('QuotaExceededError'); };
    try {
      expect(() => localStorage.setItem('probe', 'x')).toThrow();
      expect(() => theme.set('dark')).not.toThrow();
    } finally {
      owner.setItem = setItem;
    }
    TestBed.tick();
    expect(theme.preference()).toBe('dark');
    expect(isDark()).toBe(true);
  });

  describe('agrees with the first-paint boot script', () => {
    // `public/theme-boot.js` paints the first frame from the same key before
    // Angular exists; the service "must mirror that logic exactly" or there is
    // a flash of the wrong paper. The script is run here, against the same
    // storage and the same fake OS, and the two verdicts are compared.
    const boot = readFileSync(resolve(process.cwd(), 'public/theme-boot.js'), 'utf8');

    it.each([
      ['light', false, false],
      ['light', true, false],
      ['dark', false, true],
      ['dark', true, true],
      ['system', false, false],
      ['system', true, true],
      [null, true, true],
      ['garbage', true, true],
    ])('stored=%s, OS dark=%s → dark=%s, in both', (stored, osDark, expected) => {
      if (stored !== null) localStorage.setItem(KEY, stored);
      installMatchMedia(osDark);

      runInThisContext(boot);
      const painted = isDark();
      document.documentElement.classList.remove('dark');

      service();
      expect(painted).toBe(expected);
      expect(isDark()).toBe(expected);
    });

    it('follows an OS change before Angular takes over', () => {
      runInThisContext(boot);
      expect(isDark()).toBe(false);
      os.resize(true);
      expect(isDark()).toBe(true);
    });
  });
});
