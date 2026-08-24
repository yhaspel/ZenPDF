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
