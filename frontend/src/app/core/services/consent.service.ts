import { Injectable, computed, effect, inject, signal } from '@angular/core';

import { providerScriptLoaded, unloadProviderScript } from '../../shared/ad-slot';
import { ConfigService } from './config.service';

export type ConsentChoice = 'granted' | 'denied' | null;

const KEY = 'zen_ad_consent';

/**
 * Ad consent (§9A).
 *
 * Two things this is careful about, because both are ways to be dishonest with
 * somebody's choice:
 *
 * 1. **Nothing loads before a decision.** Not the AdSense script, not a pixel.
 *    A banner that appears while the tag is already running is theatre.
 * 2. **"Denied" is a real answer**, not a prompt to ask again. It is stored,
 *    it survives a reload, and it means non-personalized ads — or, until the
 *    certified CMP is wired at launch, no ads at all, which is the safe
 *    direction to be wrong in.
 *
 * Google's certified CMP (Funding Choices) is the owner-executed half of this
 * for TCF regions: it replaces the banner below and calls the same
 * `set()`. What lives here is the wiring — the gate, the persistence, and
 * Consent Mode's default state — so the product is correct with or without it.
 */
@Injectable({ providedIn: 'root' })
export class ConsentService {
  private config = inject(ConfigService);

  private _choice = signal<ConsentChoice>(null);
  readonly choice = this._choice.asReadonly();

  /**
   * Ads are on, and this visitor has either said yes or is somewhere no
   * question is required.
   *
   * The second half matters: outside the consent regions nothing ever asks, so
   * gating on an explicit `granted` would mean ads never load anywhere — a
   * product that is free because of advertising, showing none. "Denied" is
   * still honoured everywhere, whether or not it was solicited.
   */
  readonly canLoadAds = computed(() => {
    if (!this.config.ads().enabled) return false;
    const choice = this._choice();
    if (choice === 'denied') return false;
    return choice === 'granted' || !this.config.consentRequired();
  });

  /** Ask, and only ask, when ads are on and nothing has been decided. */
  readonly mustAsk = computed(
    () => this.config.ads().enabled
      && this.config.consentRequired()
      && this._choice() === null,
  );

  constructor() {
    this._choice.set(this.read());
    // Consent Mode's *default* has to be set before any Google tag loads —
    // denied for everything, upgraded only if the visitor says yes.
    this.pushDefaults();
    effect(() => {
      const choice = this._choice();
      if (choice) this.pushUpdate(choice);
    });
  }

  set(choice: Exclude<ConsentChoice, null>): void {
    const withdrawn = choice === 'denied' && providerScriptLoaded();
    try {
      localStorage.setItem(KEY, choice);
    } catch {
      // A browser that refuses storage still gets the choice for this page.
    }
    this._choice.set(choice);
    if (withdrawn) this.teardown();
  }

  /** For the settings screen: let somebody change their mind. */
  reset(): void {
    const withdrawn = providerScriptLoaded();
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* nothing to clear */
    }
    this._choice.set(null);
    if (withdrawn) this.teardown();
  }

  /**
   * Withdrawal has to actually withdraw.
   *
   * Hiding the slots and pushing a `denied` Consent Mode update leaves the
   * Google tag loaded and running for the rest of the session — a consent you
   * cannot take back is not consent. A third-party script cannot be
   * un-executed, so the only complete answer is to drop it and reload.
   */
  private teardown(): void {
    unloadProviderScript();
    if (typeof location !== 'undefined') location.reload();
  }

  private read(): ConsentChoice {
    try {
      const stored = localStorage.getItem(KEY);
      return stored === 'granted' || stored === 'denied' ? stored : null;
    } catch {
      return null;
    }
  }

  private gtag(...args: unknown[]): void {
    const win = window as unknown as { dataLayer?: unknown[] };
    win.dataLayer = win.dataLayer ?? [];
    win.dataLayer.push(args);
  }

  private pushDefaults(): void {
    if (typeof window === 'undefined') return;
    this.gtag('consent', 'default', {
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    });
  }

  private pushUpdate(choice: Exclude<ConsentChoice, null>): void {
    if (typeof window === 'undefined') return;
    const value = choice === 'granted' ? 'granted' : 'denied';
    this.gtag('consent', 'update', {
      ad_storage: value,
      ad_user_data: value,
      ad_personalization: value,
    });
  }
}
