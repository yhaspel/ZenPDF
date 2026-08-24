import { describe, expect, it } from 'vitest';

import { MIN_PAGE_WIDTH, clampPageWidth } from './page-fit';

/**
 * The clamp behind fit-to-width (design contract §3 workspace panes).
 *
 * jsdom has no layout and no scrollbars, so a unit test cannot catch the defect
 * this exists for — that is `expectNoPaneOverflow` in `phase-10-mobile.spec.ts`,
 * which runs at a real 390 × 844. What *can* be locked here is the arithmetic:
 * the desk value is a ceiling and never a floor, a phone gets the pane, and two
 * pages share it with their gap taken out first.
 */
describe('clampPageWidth', () => {
  it('never draws wider than the desk maximum', () => {
    expect(clampPageWidth(750, 1200)).toBe(750);
    expect(clampPageWidth(680, 945)).toBe(680);
    expect(clampPageWidth(900, 901)).toBe(900);
  });

  it('shrinks to the pane when the pane is the smaller of the two', () => {
    // The measured numbers: a 390 px phone whose pane scroller is 327 wide.
    expect(clampPageWidth(750, 327)).toBe(327);
    expect(clampPageWidth(680, 327)).toBe(327);
    // …and 342 where the browser draws no scrollbar.
    expect(clampPageWidth(900, 342)).toBe(342);
  });

  it('stops at a width where a page is still a page', () => {
    expect(clampPageWidth(750, 40)).toBe(MIN_PAGE_WIDTH);
    expect(clampPageWidth(750, 0)).toBe(MIN_PAGE_WIDTH);
    // A negative available width is what a pane reports mid-teardown.
    expect(clampPageWidth(750, -100)).toBe(MIN_PAGE_WIDTH);
  });

  it('gives two pages a share each, with the gap taken out first', () => {
    // Compare on a desk: 992 px of pane, a 16 px gap, capped at 420.
    expect(clampPageWidth(420, 992, { columns: 2, gap: 16 })).toBe(420);
    // Compare where the pane is tight: (600 − 16) / 2.
    expect(clampPageWidth(420, 600, { columns: 2, gap: 16 })).toBe(292);
    // And on a phone it stacks, so it asks for one column and gets the lot.
    expect(clampPageWidth(420, 327, { columns: 1, gap: 16 })).toBe(327);
  });

  it('rounds down, so a fractional pane never overflows by half a pixel', () => {
    expect(clampPageWidth(900, 327.9)).toBe(327);
    expect(clampPageWidth(420, 601, { columns: 2, gap: 16 })).toBe(292);
  });
});

/**
 * The loop that fitting a page to its pane actually is.
 *
 * `clampPageWidth` is pure, but the thing it takes part in is not: the width it
 * returns sets the page's *height*, the height decides whether the pane needs a
 * vertical scrollbar, and a **classic** scrollbar takes 15 px out of the content
 * box — which is the input to the next call. That is a fixed-point problem, and
 * a fixed-point problem can have two answers.
 *
 * It did. Measured on production at 390 px in a guest workspace on 2026-08-24:
 * Edit and Sign settled at **342 with a scrollbar** (`scrollWidth` 390 against
 * `clientWidth` 375 — 15 px of overflow), while Annotate and Protect settled at
 * **327 with none**. Same document, same session. Whichever the `ResizeObserver`
 * emitted last is where it stopped.
 *
 * **Why this is a unit test and not an e2e.** It cannot be an e2e: measured
 * across ten browser configurations on 2026-08-24 — bundled Chromium and the
 * installed Chrome, headless and headed, `--disable-features=OverlayScrollbar`,
 * `-webkit-appearance: none` on `::-webkit-scrollbar`, `overflow-y: scroll` —
 * a nested scroller in Playwright's browser gave up **0 px** every time. Even
 * `scrollbar-gutter: stable`, the rule that fixes this, reserves nothing there,
 * because an overlay scrollbar has no width to reserve. The suite cannot see the
 * defect *or* the fix, so `phase-10-mobile.spec.ts` asserts the declaration and
 * says why. The convergence itself is arithmetic, and arithmetic travels.
 */
describe('fitting a page to its pane converges', () => {
  const A4 = 1.414;

  /**
   * Run the loop and report what it does: the width it settles on, or the pair
   * it oscillates between.
   */
  function settle(opts: {
    paneWidth: number;
    paneHeight: number;
    padding: number;
    scrollbar: number;
    max: number;
    /** `true` models `scrollbar-gutter: stable` — the gutter is always reserved. */
    gutterStable: boolean;
  }): { settled: number } | { cycles: [number, number] } {
    const { paneWidth, paneHeight, padding, scrollbar, max, gutterStable } = opts;
    const seen: number[] = [];
    let scrolling = gutterStable;
    for (let i = 0; i < 20; i += 1) {
      const taken = gutterStable || scrolling ? scrollbar : 0;
      const width = clampPageWidth(max, paneWidth - padding - taken);
      const contentHeight = width * A4 + padding;
      scrolling = contentHeight > paneHeight;
      const previous = seen[seen.length - 2];
      if (seen[seen.length - 1] === width) return { settled: width };
      if (previous === width) return { cycles: [previous, seen[seen.length - 1]] };
      seen.push(width);
    }
    return { settled: seen[seen.length - 1] };
  }

  /** The guest workspace at 390 x 844, which is where it was found. */
  const GUEST = { paneWidth: 390, paneHeight: 525, padding: 48, max: 750 };

  it('has two answers when the gutter is not reserved, and one of them does not fit', () => {
    const result = settle({ ...GUEST, scrollbar: 15, gutterStable: false });
    expect('cycles' in result, JSON.stringify(result)).toBe(true);
    const [a, b] = (result as { cycles: [number, number] }).cycles;
    expect(new Set([a, b])).toEqual(new Set([327, 342]));
    // And the wider answer is the broken one: 342 does not fit the 327 that a
    // scrollbar leaves. That is the 15 px of overflow seen on production.
    expect(342).toBeGreaterThan(GUEST.paneWidth - GUEST.padding - 15);
  });

  it('has exactly one answer once the gutter is reserved', () => {
    const result = settle({ ...GUEST, scrollbar: 15, gutterStable: true });
    expect('settled' in result, JSON.stringify(result)).toBe(true);
    expect((result as { settled: number }).settled).toBe(327);
  });

  it('is unaffected where the scrollbar is an overlay — which is why no browser test sees it', () => {
    // scrollbar: 0 is Playwright's browser, and a real phone. One fixed point
    // either way, which is exactly why the defect was invisible until production.
    expect(settle({ ...GUEST, scrollbar: 0, gutterStable: false })).toEqual({ settled: 342 });
    expect(settle({ ...GUEST, scrollbar: 0, gutterStable: true })).toEqual({ settled: 342 });
  });

  it('converges on a desk, where the page is taller than the pane at either width', () => {
    // The reason the gutter rule is scoped below `md` (§10): up here the
    // scrollbar is needed at both candidate widths, so there is one answer
    // already and the desk pays nothing.
    const desk = { paneWidth: 801, paneHeight: 700, padding: 48, max: 900 };
    expect(settle({ ...desk, scrollbar: 15, gutterStable: false })).toEqual({ settled: 738 });
  });
});
