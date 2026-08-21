/**
 * The overlay layer's vocabulary (01-architecture.md §7, §8).
 *
 * Deliberately generic: this is the primitive built once in Phase 3 and reused
 * by content editing (4), form fields (5), redaction boxes (7) and signature
 * placement (8). It knows about *shapes on a page*, never about annotations —
 * each feature maps its own model onto `OverlayItem` and back.
 *
 * All geometry is normalized visual-space (§8): `x, y, w, h ∈ [0,1]` relative to
 * the displayed page, origin top-left, rotation already applied. That is what
 * makes the overlay zoom-independent — nothing here stores a pixel.
 */

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NormPoint = [number, number];

/** What a shape *is*, geometrically. Feature semantics live in `data`. */
export type OverlayShape =
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polygon'
  | 'polyline'
  | 'ink'
  | 'quads'
  | 'point';

export interface OverlayItem {
  id: string;
  page: number;
  shape: OverlayShape;
  rect?: NormRect;
  quads?: NormRect[];
  points?: NormPoint[];
  ink?: NormPoint[][];
  stroke?: string;
  fill?: string | null;
  opacity?: number;
  /** Stroke width in *points*, scaled to pixels at render time. */
  width?: number;
  /** Short badge drawn at the top-left corner (field name, "REDACT", …). */
  label?: string;
  /**
   * Text drawn *inside* the rectangle, the way the file will show it.
   *
   * A text box whose words only appeared in a 10px badge above the box — and
   * truncated at 24 characters — is not a text box; it is an empty rectangle
   * with a tooltip. Anything that carries `text` renders as text on the page
   * and can be edited there.
   */
  text?: string;
  /** Point size of `text`, converted against the page width at render time. */
  fontSize?: number;
  /** Colour of `text`. Separate from `stroke`: the border may be off. */
  textColor?: string;
  /** Opaque payload owned by the feature that created the item. */
  data?: Record<string, unknown>;
  locked?: boolean;
}

/** Which pointer gesture the overlay is currently interpreting. */
export type OverlayTool =
  | 'select'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polygon'
  | 'polyline'
  | 'ink'
  | 'point'
  | 'text';

/** A shape the user just drew, before the feature turns it into its own model. */
export interface OverlayDraft {
  shape: OverlayShape;
  page: number;
  rect?: NormRect;
  quads?: NormRect[];
  points?: NormPoint[];
  ink?: NormPoint[][];
}

export interface OverlayWord {
  i: number;
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  b: number;
  l: number;
  n: number;
}

export interface OverlayGeometryChange {
  id: string;
  /** Where the item is now. */
  rect: NormRect;
  /** Where it was, so the consumer can derive the transform for non-rect
   *  geometry (quads, ink strokes, polygon vertices) rather than losing it. */
  from: NormRect;
}

/** Bounding box of loose points — gives ink/lines/polygons a grabbable rect. */
export function boundsOfPoints(points: NormPoint[]): NormRect | undefined {
  if (!points.length) return undefined;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Map a point through the affine transform that takes `from` onto `to`.
 *
 * This is what lets a highlight, an ink stroke or a polygon be dragged: the
 * overlay only ever moves a *rectangle*, and the feature re-derives its real
 * geometry from how that rectangle moved. A zero-width or zero-height source
 * (a horizontal line) scales by 1 on that axis instead of dividing by zero.
 */
export function transformPoint(p: NormPoint, from: NormRect, to: NormRect): NormPoint {
  const sx = from.w > 1e-6 ? to.w / from.w : 1;
  const sy = from.h > 1e-6 ? to.h / from.h : 1;
  return [
    clamp01(to.x + (p[0] - from.x) * sx),
    clamp01(to.y + (p[1] - from.y) * sy),
  ];
}

export function transformRect(r: NormRect, from: NormRect, to: NormRect): NormRect {
  const [x, y] = transformPoint([r.x, r.y], from, to);
  const [x2, y2] = transformPoint([r.x + r.w, r.y + r.h], from, to);
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export function normalizeRect(a: NormPoint, b: NormPoint): NormRect {
  const x = clamp01(Math.min(a[0], b[0]));
  const y = clamp01(Math.min(a[1], b[1]));
  return {
    x,
    y,
    w: Math.min(1 - x, Math.abs(a[0] - b[0])),
    h: Math.min(1 - y, Math.abs(a[1] - b[1])),
  };
}

/** Union of a set of rects — used to give a multi-quad markup one bounding box. */
export function boundsOf(rects: NormRect[]): NormRect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

export const MAX_STROKE_POINTS = 2000;

/**
 * Chaikin corner-cutting, run twice.
 *
 * Ink has to look like a pen stroke regardless of how the pointer sampled it —
 * a mouse emits far fewer points than a stylus, and pressure/tilt are not
 * available at all on most hardware. Smoothing the *path* rather than reacting
 * to pressure gives both the same result, which is why phase-03 specifies
 * "pressure-agnostic smoothing".
 */
export function smoothStroke(points: NormPoint[]): NormPoint[] {
  if (points.length < 3) return points;
  let current = points;
  for (let pass = 0; pass < 2; pass += 1) {
    const next: NormPoint[] = [current[0]];
    for (let i = 0; i < current.length - 1; i += 1) {
      const [x0, y0] = current[i];
      const [x1, y1] = current[i + 1];
      next.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      next.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  // Cap the point count: a long stroke smoothed twice is ~4x the samples, and
  // the schema caps a stroke at 5000. Thin by index and then *replace* the last
  // kept sample with the true endpoint — appending it would push the result one
  // over the cap, which is how an off-by-one gets shipped.
  if (current.length > MAX_STROKE_POINTS) {
    const step = Math.ceil(current.length / MAX_STROKE_POINTS);
    const thinned = current.filter((_, i) => i % step === 0);
    thinned[thinned.length - 1] = current[current.length - 1];
    current = thinned;
  }
  return current;
}

/**
 * Merge the rects of a word run into per-line quads.
 *
 * A text selection spanning three lines must become three quads, not one box
 * covering the paragraph — otherwise a highlight paints over everything in
 * between. Grouping by PyMuPDF's (block, line) indices is also what makes RTL
 * behave: words on one visual line share a line index whichever way they run.
 */
export function quadsFromWords(words: OverlayWord[]): NormRect[] {
  const lines = new Map<string, OverlayWord[]>();
  for (const w of words) {
    const key = `${w.b}:${w.l}`;
    const bucket = lines.get(key);
    if (bucket) bucket.push(w);
    else lines.set(key, [w]);
  }
  const quads: NormRect[] = [];
  for (const bucket of lines.values()) {
    const rect = boundsOf(bucket.map((w) => ({ x: w.x, y: w.y, w: w.w, h: w.h })));
    if (rect && rect.w > 0 && rect.h > 0) quads.push(rect);
  }
  return quads;
}

/**
 * One entry in the overlay's context menu (phase-12 D6).
 *
 * The overlay renders these and reports which was chosen; what any of them
 * *means* stays with the feature that supplied the list, exactly as `OverlayItem`
 * keeps feature semantics in `data`.
 */
export interface OverlayMenuAction {
  id: string;
  label: string;
  /** Rendered in the `--color-danger` treatment: removals, and nothing else. */
  danger?: boolean;
  /**
   * Offered but not currently possible. Rendered with the contract's dashed
   * disabled treatment and `aria-disabled`, and skipped by the arrow keys —
   * never the native `disabled` attribute, which drops the item out of the
   * accessibility tree so "Paste (unavailable)" vanishes instead of reading as
   * unavailable.
   */
  disabled?: boolean;
  /** e.g. "⌘C" — a hint in the end column, never the only place a key is named. */
  shortcut?: string;
}

/**
 * Move a rect by a delta and keep it on the page.
 *
 * The clamp mirrors the one `PageOverlay.dragRect` applies to a pointer move:
 * a shape pushed at the edge stops at the edge rather than sliding off it and
 * becoming unselectable. Clamping x and y *after* accounting for the shape's
 * own width and height is what makes the far edge behave — clamping the origin
 * alone lets a wide shape hang off the right of the page.
 */
export function nudgeRect(rect: NormRect, dx: number, dy: number): NormRect {
  return {
    x: Math.min(clamp01(rect.x + dx), Math.max(0, 1 - rect.w)),
    y: Math.min(clamp01(rect.y + dy), Math.max(0, 1 - rect.h)),
    w: rect.w,
    h: rect.h,
  };
}
