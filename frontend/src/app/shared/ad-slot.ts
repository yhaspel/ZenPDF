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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
      <aside class="ad-frame w-full overflow-hidden" [style.min-height.px]="height()"
             [attr.data-test]="'ad-slot-' + name()" aria-label="Advertisement">
        <p class="ad-label">Advertisement</p>
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

  /** Routes that never carry advertising, whatever anybody wires up (§9A).
   *
   *  `/app/doc` is the editor and viewer canvas: somebody is mid-way through
   *  redacting a contract there, and an ad beside the page they are working on
   *  is both a trust problem and a misclick waiting to happen. */
  static readonly FORBIDDEN = ['/s/', '/verify', '/legal/', '/app/doc'];

  // Seeded from the router, not `location`: a slot created *after* navigation
  // (which is every slot on a lazily-rendered page) would otherwise miss the
  // `NavigationEnd` that already fired and read the wrong route.
  private url = signal(this.router.url);
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
    // `Router` outlives every slot, so an unmanaged subscription keeps each
    // destroyed component (and its host element) reachable for the session.
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
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

/** Whether the provider script was ever appended in this page's life. */
export function providerScriptLoaded(): boolean {
  return scriptRequested;
}

/**
 * Take the tag back out when consent is withdrawn (§9A).
 *
 * Removing the element stops nothing that is already running — a third-party
 * script cannot be un-executed — so the honest teardown is to drop the element
 * *and* reload, which is what `ConsentService` does. Without the reload,
 * "withdraw consent" would only mean "hide the boxes".
 */
export function unloadProviderScript(): void {
  if (typeof document === 'undefined') return;
  document
    .querySelectorAll('script[src*="googlesyndication.com"]')
    .forEach((node) => node.remove());
  scriptRequested = false;
}

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
