import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The seal — ZenPDF's logo mark (design contract §1).
 *
 * A vermilion rounded square carrying a stroked "Z", drawn in `--color-on-accent`
 * so it holds in both modes. The wordmark is Shippori Mincho: "Zen" strong,
 * "PDF" muted. Wrap it in an anchor with class `brand`; this host renders as
 * `display: contents` so the `.brand` flex layout reaches the svg and wordmark.
 *
 * The 🧘‍♀️ emoji is retired. The seal never mirrors under RTL (§8).
 */
@Component({
  selector: 'app-brand',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { style: 'display: contents' },
  template: `
    <svg
      class="seal"
      [style.width.px]="size()"
      [style.height.px]="size()"
      viewBox="0 0 32 32"
      aria-hidden="true">
      <rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="var(--color-accent)" />
      <path
        d="M10.5 11h11l-11 10h11"
        fill="none"
        stroke="var(--color-on-accent)"
        stroke-width="2.6"
        stroke-linecap="round"
        stroke-linejoin="round" />
    </svg>
    @if (wordmark()) {
      <b>Zen<i>PDF</i></b>
    }
  `,
})
export class Brand {
  /** 28 in headers, 20 in compact bars, 56 on the auth brand panel (§1). */
  readonly size = input(28);
  readonly wordmark = input(true);
}
