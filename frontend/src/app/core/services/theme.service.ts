import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { inBrowser, usableLocalStorage } from '../browser-storage';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'zenpdf.theme';
const LIGHT_THEME_COLOR = '#F5F1E6';
const DARK_THEME_COLOR = '#171310';

/**
 * The theme is one of the two interactive elements the redesign added
 * (design contract §5). Light → Dark → System, defaulting to System, persisted
 * under `zenpdf.theme`, applied as a `.dark` class on <html>.
 *
 * The inline <head> script in index.html applies the class before first paint;
 * this service takes over after bootstrap and must mirror that logic exactly —
 * disagreement between the two is a flash of the wrong paper.
 *
 * SSR-safe the same way the rest of the app is: storage and matchMedia are
 * feature-checked, not assumed, so prerendering renders the light default.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = inBrowser();

  readonly preference = signal<ThemePreference>('system');
  private readonly systemDark = signal(false);

  /** What is actually on screen right now. */
  readonly resolved = computed<'light' | 'dark'>(() => {
    const pref = this.preference();
    if (pref === 'system') return this.systemDark() ? 'dark' : 'light';
    return pref;
  });

  private get storage(): Storage | null {
    return usableLocalStorage(this.isBrowser);
  }

  constructor() {
    const stored = this.storage?.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      this.preference.set(stored);
    }

    const media = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)');
    if (media) {
      this.systemDark.set(media.matches);
      // The listener stays attached for the app's lifetime — the service is a
      // root singleton, so there is nothing to unhook.
      media.addEventListener?.('change', (event) => this.systemDark.set(event.matches));
    }

    effect(() => this.apply(this.resolved()));
  }

  /** Cycles Light → Dark → System (contract §5). */
  cycle(): void {
    const order: ThemePreference[] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(this.preference()) + 1) % order.length];
    this.set(next);
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    try {
      this.storage?.setItem(STORAGE_KEY, preference);
    } catch {
      /* private mode — the choice lives for the session only */
    }
  }

  private apply(resolved: 'light' | 'dark'): void {
    const root = this.document.documentElement;
    if (!root) return;
    root.classList.toggle('dark', resolved === 'dark');

    // Keep the browser chrome on the same paper. When a mode is forced, both
    // media-scoped metas carry the forced color; under "system" they return to
    // their own colors (contract §5).
    const metas = this.document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    metas.forEach((meta) => {
      const media = meta.getAttribute('media') ?? '';
      if (this.preference() === 'system') {
        meta.content = media.includes('dark') ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
      } else {
        meta.content = resolved === 'dark' ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
      }
    });
  }
}
