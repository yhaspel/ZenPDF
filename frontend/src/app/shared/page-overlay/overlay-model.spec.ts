import {
  MAX_STROKE_POINTS,
  NormPoint,
  boundsOf,
  clamp01,
  normalizeRect,
  quadsFromWords,
  smoothStroke,
} from './overlay-model';

/**
 * The overlay's geometry math (§8). These are the calculations that decide
 * whether a highlight lands on the words the user selected, so they are tested
 * directly rather than only through the component.
 */
describe('overlay geometry', () => {
  it('clamps to the page', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.25)).toBe(0.25);
  });

  it('normalizes a rect drawn in any direction', () => {
    const topLeftFirst = normalizeRect([0.2, 0.3], [0.6, 0.5]);
    const bottomRightFirst = normalizeRect([0.6, 0.5], [0.2, 0.3]);
    expect(topLeftFirst).toEqual(bottomRightFirst);
    expect(topLeftFirst.x).toBeCloseTo(0.2);
    expect(topLeftFirst.y).toBeCloseTo(0.3);
    expect(topLeftFirst.w).toBeCloseTo(0.4);
    expect(topLeftFirst.h).toBeCloseTo(0.2);
  });

  it('never produces a rect that leaves the page', () => {
    const rect = normalizeRect([0.9, 0.9], [2, 2]);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1);
  });

  it('bounds a set of quads', () => {
    const bounds = boundsOf([
      { x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
      { x: 0.4, y: 0.3, w: 0.2, h: 0.05 },
    ])!;
    expect(bounds.x).toBeCloseTo(0.1);
    expect(bounds.y).toBeCloseTo(0.1);
    expect(bounds.w).toBeCloseTo(0.5);
    expect(bounds.h).toBeCloseTo(0.25);
    expect(boundsOf([])).toBeUndefined();
  });

  describe('quadsFromWords', () => {
    const word = (i: number, b: number, l: number, x: number, y: number) => ({
      i, t: 'w', x, y, w: 0.1, h: 0.02, b, l, n: i,
    });

    it('produces one quad per line, not one box over the paragraph', () => {
      // Three words on line 0 and two on line 1: a single bounding box would
      // paint over everything between them.
      const quads = quadsFromWords([
        word(0, 0, 0, 0.1, 0.1),
        word(1, 0, 0, 0.25, 0.1),
        word(2, 0, 0, 0.4, 0.1),
        word(3, 0, 1, 0.1, 0.2),
        word(4, 0, 1, 0.25, 0.2),
      ]);
      expect(quads.length).toBe(2);
      expect(quads[0].y).toBeCloseTo(0.1);
      expect(quads[0].w).toBeCloseTo(0.4);
      expect(quads[1].y).toBeCloseTo(0.2);
      expect(quads[1].w).toBeCloseTo(0.25);
    });

    it('separates lines that share an index across different blocks', () => {
      const quads = quadsFromWords([word(0, 0, 0, 0.1, 0.1), word(1, 5, 0, 0.1, 0.8)]);
      expect(quads.length).toBe(2);
    });

    it('handles right-to-left runs, where x decreases along the line', () => {
      // Hebrew: the first word of the line sits at the *right*. Grouping by
      // (block, line) and taking the union is direction-agnostic by construction.
      const quads = quadsFromWords([
        word(0, 0, 0, 0.7, 0.1),
        word(1, 0, 0, 0.5, 0.1),
        word(2, 0, 0, 0.3, 0.1),
      ]);
      expect(quads.length).toBe(1);
      expect(quads[0].x).toBeCloseTo(0.3);
      expect(quads[0].w).toBeCloseTo(0.5);
    });

    it('returns nothing for an empty selection', () => {
      expect(quadsFromWords([])).toEqual([]);
    });
  });

  describe('smoothStroke', () => {
    it('leaves a two-point stroke alone', () => {
      const stroke: NormPoint[] = [[0, 0], [1, 1]];
      expect(smoothStroke(stroke)).toEqual(stroke);
    });

    it('keeps the endpoints and rounds the corners', () => {
      const stroke: NormPoint[] = [[0, 0], [0.5, 0.5], [1, 0]];
      const smoothed = smoothStroke(stroke);
      expect(smoothed.length).toBeGreaterThan(stroke.length);
      expect(smoothed[0]).toEqual([0, 0]);
      expect(smoothed[smoothed.length - 1]).toEqual([1, 0]);
      // The sharp apex is gone: no smoothed point reaches the original corner.
      const apex = smoothed.find((p) => p[1] > 0.49);
      expect(apex).toBeUndefined();
    });

    it('caps the point count so a long stroke cannot blow the schema limit', () => {
      const long: NormPoint[] = Array.from({ length: 3000 }, (_, i) => [i / 3000, 0.5]);
      const smoothed = smoothStroke(long);
      expect(smoothed.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
      // The pen-up point still ends the stroke.
      expect(smoothed[smoothed.length - 1]).toEqual(long[long.length - 1]);
    });
  });
});
