import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

import { ConfigService } from '../core/services/config.service';
import { ConsentService } from '../core/services/consent.service';

/**
 * One advertising slot, by logical name (§9A).
 *
 * Everything about the ad layer that could go wrong for a *user* is decided
 * here rather than at each call site:
 *
 * * **Nothing loads without consent**, and nothing loads when `ADS_ENABLED` is
 *   false — which is the shipped default. The script tag is appended once, on
 *   the first slot that is allowed to render, and never before.
 * * **The box is reserved before the ad arrives**, so nothing on the page
 *   moves when it does. Layout shift on a tool the user is mid-way through is
 *   worse than no revenue.
 * * **Trust surfaces are refused in code, not by convention.** The signing
 *   ceremony, `/verify` and the document canvas never carry advertising, and
 *   this component will not render on those routes even if somebody drops one
 *   in by mistake.
 * * **Unfilled collapses quietly.** No "please disable your ad blocker".
 */
@Component({
  selector: 'app-ad-slot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <aside class="w-full overflow-hidden" [style.min-height.px]="height()"
             [attr.data-test]="'ad-slot-' + name()" aria-label="Advertisement">
        <p class="mb-1 text-[10px] uppercase tracking-wide text-slate-300">
          Advertisement
        </p>
        <ins #unit class="adsbygoogle block"
             [attr.data-ad-client]="client()"
             [attr.data-ad-slot]="unitId()"
             data-ad-format="auto"
             data-full-width-responsive="true"
             [style.min-height.px]="height()"></ins>
      </aside>
    }
  `,
})
export class AdSlot {
  /** A logical name — `dashboard-rail`, `tool-result`, `landing`. The unit id
   *  behind it comes from `/api/config/`, so retiring a placement is config. */
  readonly name = input.required<string>();
  /** Reserved height. Guessing low causes the shift this exists to prevent. */
  readonly height = input(250);

  private config = inject(ConfigService);
  private consent = inject(ConsentService);
  private router = inject(Router);
  private unit = viewChild<ElementRef<HTMLElement>>('unit');

  /** Routes that never carry advertising, whatever anybody wires up (§9A). */
  static readonly FORBIDDEN = ['/s/', '/verify', '/legal/'];

  private url = signal(typeof location !== 'undefined' ? location.pathname : '');
  private pushed = false;

  protected readonly client = computed(() => this.config.ads().client_id ?? '');
  protected readonly unitId = computed(
    () => this.config.ads().slots?.[this.name()] ?? '',
  );

  protected readonly visible = computed(() => {
    if (!this.consent.canLoadAds()) return false;
    if (!this.client() || !this.unitId()) return false;
    return !AdSlot.FORBIDDEN.some((prefix) => this.url().startsWith(prefix));
  });

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.url.set(event.urlAfterRedirects);
    });
    effect(() => {
      if (!this.visible() || this.pushed) return;
      // The element has to exist before the provider is told to fill it.
      if (!this.unit()) return;
      loadProviderScript(this.client());
      const win = window as unknown as { adsbygoogle?: unknown[] };
      win.adsbygoogle = win.adsbygoogle ?? [];
      win.adsbygoogle.push({});
      this.pushed = true;
    });
  }
}

let scriptRequested = false;

/** Appended once per page, and only from a slot that is allowed to render. */
export function loadProviderScript(client: string): void {
  if (scriptRequested || typeof document === 'undefined' || !client) return;
  scriptRequested = true;
  const script = document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src =
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client='
    + encodeURIComponent(client);
  document.head.appendChild(script);
}

/** Test seam: the module-level latch would otherwise leak between specs. */
export function resetProviderScript(): void {
  scriptRequested = false;
}
