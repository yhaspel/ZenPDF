/**
 * How wide to draw a page inside the space its pane actually has.
 *
 * Design contract §3 workspace panes says the render width is taken from the
 * pane, **not fixed**. Only Annotate took it from anywhere at all, and even that
 * asked the window. Measured at 390 px on 2026-08-24, after the phone workspace
 * landed — every one of these inside a pane whose scroller is 327 px wide:
 *
 * | mode | drew the page at | over by |
 * |---|---|---|
 * | Edit, Forms | 750 | 423 |
 * | Protect, Sign | 680 | 353 |
 * | Compare | 420 × 2 + 16 gap = 856 | 529 |
 * | Annotate | 342 | 15 |
 *
 * and only Annotate has a zoom control, so in the other five the page simply
 * could not be brought into view except by scrolling the pane sideways.
 *
 * The available width comes from `FitWidth` (`shared/fit-width.ts`), which
 * measures the scroller's content box. This function is only the clamp: each
 * pane keeps its own maximum, so nothing gets *wider* than it draws today.
 */

/** Narrower than this and a page stops being readable at all. */
export const MIN_PAGE_WIDTH = 280;

export interface PageFitOptions {
  /** How many pages sit side by side. Compare draws two, and one on a phone. */
  columns?: number;
  /** The gap between them, when there is more than one. */
  gap?: number;
}

/**
 * @param max the widest this pane ever draws a page — its desk value.
 * @param available the pane scroller's content-box width, from `FitWidth`.
 */
export function clampPageWidth(
  max: number,
  available: number,
  { columns = 1, gap = 0 }: PageFitOptions = {},
): number {
  const share = (available - gap * Math.max(0, columns - 1)) / Math.max(1, columns);
  return Math.max(MIN_PAGE_WIDTH, Math.min(max, Math.floor(share)));
}
