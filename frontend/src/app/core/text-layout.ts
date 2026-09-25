/**
 * Text boxes: one layout, drawn twice (design contract §3 "Text on the page").
 *
 * The client decides a text box's lines — once, here — and sizes the box from
 * them. The overlay draws those lines with `white-space: pre`; the engine
 * draws the very same lines into the file's appearance stream, in the same
 * face (Arimo), at baselines both sides compute from one formula. Nothing
 * re-wraps a line anywhere else, and the box is always its text's size, so
 * nothing is ever clipped — on screen or in the file.
 *
 * Pure: no Angular, no DOM at import time. Measurement is injected.
 */

/** Line height as a multiple of the point size — CSS `line-height: 1.2`. */
export const TEXT_LINE_HEIGHT = 1.2;
/** Arimo's vertical metrics, pinned in CSS with ascent-/descent-override. */
export const TEXT_ASCENT = 1854 / 2048;
export const TEXT_DESCENT = 434 / 2048;
/** Where a click lands on line 1: its vertical centre (`top = y − 0.6·size`). */
export const TEXT_CLICK_OFFSET = TEXT_LINE_HEIGHT / 2;
/** The `@font-face` family `styles.scss` declares over the vendored Arimo. */
export const PAGE_TEXT_FONT = 'Zen Page Text';

/** A string's advance width in points at `sizePt`, kerning and ligatures off. */
export type Measure = (text: string, sizePt: number) => number;

export interface TextLayout {
  /** The lines, exactly as they will be drawn. Never empty (`['']` at least). */
  lines: string[];
  /** The widest line, in points. The box's width. */
  widthPt: number;
  /** `lines × 1.2 × size`, in points. The box's height. */
  heightPt: number;
}

/** Distance from the box's top to line `index`'s baseline, in points. */
export function textBaseline(index: number, sizePt: number): number {
  const halfLeading = ((TEXT_LINE_HEIGHT - (TEXT_ASCENT + TEXT_DESCENT)) / 2) * sizePt;
  return halfLeading + TEXT_ASCENT * sizePt + index * TEXT_LINE_HEIGHT * sizePt;
}

/**
 * Lay text out into lines.
 *
 * Hard breaks are the user's own newlines. A soft break is inserted only when
 * a line would cross `maxWidthPt` (the page's right edge): greedily by word,
 * the whitespace at the break dropped, and a single word wider than the
 * space broken by character — at least one character per line, so a box
 * placed hard against the edge still makes progress.
 *
 * Idempotent: laying the output out again at its own width reproduces it.
 */
export function layoutText(
  text: string,
  sizePt: number,
  maxWidthPt: number,
  measure: Measure,
): TextLayout {
  const lines: string[] = [];
  const fits = (s: string) => measure(s, sizePt) <= maxWidthPt + 1e-6;

  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (fits(paragraph.trimEnd())) {
      lines.push(paragraph);
      continue;
    }
    // Words with the whitespace that follows each one: ["foo ", "bar  ", "baz"].
    const pieces = paragraph.match(/\S+\s*|\s+/g) ?? [];
    let line = '';
    for (const piece of pieces) {
      if (fits(line + piece) || fits(line + piece.trimEnd())) {
        line += piece;
        continue;
      }
      if (line.trim()) {
        lines.push(line.trimEnd());
        line = '';
      }
      const word = line + piece;
      if (fits(word.trimEnd())) {
        line = word;
        continue;
      }
      // One word wider than the space: break it by character.
      let chunk = '';
      for (const ch of Array.from(word.trimEnd())) {
        if (chunk && !fits(chunk + ch)) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += ch;
      }
      line = chunk + word.slice(word.trimEnd().length);
    }
    // The paragraph's own end keeps its trailing whitespace: it is what the
    // person just typed, and dropping it would eat every space typed at the
    // end of a wrapped line. Only a soft break (above) drops whitespace.
    lines.push(line);
  }

  // Trailing whitespace is not ink, and does not widen the box — a space
  // typed at the end of a line must not push a box at the page's edge left.
  const widthPt = Math.max(0, ...lines.map((l) => measure(l.trimEnd(), sizePt)));
  return { lines, widthPt, heightPt: lines.length * TEXT_LINE_HEIGHT * sizePt };
}

/**
 * Paragraph direction by its first strong character (UAX #9 rules P2/P3):
 * Hebrew or Arabic → `rtl`, a Latin (or other LTR) letter → `ltr`. Digits
 * and punctuation are weak and do not decide. The engine applies the same
 * rule (`annotations.paragraph_is_rtl`).
 */
export function paragraphDir(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    if (STRONG_RTL.test(ch)) return 'rtl';
    if (STRONG_LTR.test(ch)) return 'ltr';
  }
  return 'ltr';
}

const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]|\uD802[\uDC00-\uDFFF]|\uD803[\uDC00-\uDFFF]/u;
const STRONG_LTR = /\p{L}/u;

// --------------------------------------------------------------------------- //
// Measurement
// --------------------------------------------------------------------------- //
/**
 * Arimo Regular's advance widths (font units, 2048/em), run-length encoded as
 * `[first code point, [advance, …]]` over Latin, Latin-1/Extended-A/B,
 * spacing modifiers, combining marks, Hebrew, general punctuation, currency,
 * letterlike, arrows, maths and Hebrew presentation forms — generated with
 * fontTools from `frontend/public/fonts/Arimo-Regular.ttf` (the same bytes the
 * engine draws with). With kerning and ligatures off, a line's width is
 * exactly the sum of these, which is what the engine's `Font.text_length`
 * computes too: the two sides cannot disagree about where a line ends, and
 * the answer does not wait for a web font to load.
 */
const ARIMO_UPM = 2048;
const ARIMO_ADVANCE_RUNS: [number, number[]][] = [
  [0x0020, [569,569,727,1139,1139,1821,1366,391,682,682,797,1196,569,682,569,569,1139,1139,1139,1139,1139,1139,1139,1139,1139,1139,569,569,1196,1196,1196,1139,2079,1366,1366,1479,1479,1366,1251,1593,1479,569,1024,1366,1139,1706,1479,1593,1366,1593,1479,1366,1251,1479,1366,1933,1366,1366,1251,569,569,569,961,1139,682,1139,1139,1024,1139,1139,569,1139,1139,455,455,1024,455,1706,1139,1139,1139,1139,682,1024,569,1139,1024,1479,1024,1024,1024,684,532,684,1196]],
  [0x00a0, [569,682,1139,1139,1139,1139,532,1139,682,1509,758,1139,1196,682,1509,1131,819,1124,682,682,682,1180,1100,682,682,682,748,1139,1708,1708,1708,1251,1366,1366,1366,1366,1366,1366,2048,1479,1366,1366,1366,1366,569,569,569,569,1479,1479,1593,1593,1593,1593,1593,1196,1593,1479,1479,1479,1479,1366,1366,1251,1139,1139,1139,1139,1139,1139,1821,1024,1139,1139,1139,1139,569,569,569,569,1139,1139,1139,1139,1139,1139,1139,1124,1251,1139,1139,1139,1139,1024,1139,1024,1366,1139,1366,1139,1366,1139,1479,1024,1479,1024,1479,1024,1479,1024,1479,1259,1479,1139,1366,1139,1366,1139,1366,1139,1366,1139,1366,1139,1593,1139,1593,1139,1593,1139,1593,1139,1479,1139,1479,1139,569,569,569,569,569,569,569,455,569,569,1505,909,1024,455,1366,1024,1024,1139,455,1139,455,1139,597,1139,684,1139,455,1479,1139,1479,1139,1479,1139,1237,1481,1139,1593,1139,1593,1139,1593,1139,2048,1933,1479,682,1479,682,1479,682,1366,1024,1366,1024,1366,1024,1366,1024,1251,569,1251,768,1251,569,1479,1139,1479,1139,1479,1139,1479,1139,1479,1139,1479,1139,1933,1479,1366,1024,1366,1251,1024,1251,1024,1251,1024,455,1139,1553,1344,1139,1344,1139,1479,1479,1024,1479,1658,1344,1139,1140,1366,1541,1237,1251,571,1593,1278,1804,455,569,1366,1024,455,1024,1824,1479,1139,1593,1756,1343,1778,1367,1545,1139,1366,1366,1024,1266,779,569,1251,569,1251,1749,1371,1531,1479,1582,1024,1251,1024,1251,1251,1116,1116,1139,1139,939,997,1139,532,846,1196,569,2730,2503,2148,2175,1706,924,2503,1934,1579,1366,1139,569,455,1593,1139,1479,1139,1479,1139,1479,1139,1479,1139,1479,1139,1139,1366,1139,1366,1139,2048,1821,1593,1139,1593,1139,1366,1024,1593,1139,1593,1139,1251,1116,455,2730,2503,2148,1593,1139,2118,1266,1479,1139,1366,1139,2048,1821,1593,1251,1366,1139,1366,1139,1366,1139,1366,1139,569,569,569,569,1593,1139,1593,1139,1479,682,1479,682,1479,1139,1479,1139,1366,1024,1251,569,1116,894,1479,1139,1446,1396,1238,1158,1251,1024,1366,1139,1366,1139,1593,1139,1593,1139,1593,1139,1593,1139,1366,1024,715,1402,752,455,1816,1816,1366,1479,1024,1139,1251,1024,1024,1189,928,1366,1479,1368,1366,1139,1024,455,1510,1139,1479,682,1366,1024]],
  [0x02b0, [785,785,326,491,491,491,746,985,657,384,725,455,455,455,682,682,714,714,1196,1196,1196,1196,683,682,682,682,682,682,682,682,682,682,569,569,682,682,682,682,682,682,682,682,682,682,682,682,682,682,660,322,696,672,714,784,784,784,784,784,682,682,682,682,682,682,682,682,682,682,682,682,682,682,569,682,682,682,682,814,814,682,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]],
  [0x0591, [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,784,0,1153,0,0,569,0,0,776,0]],
  [0x05d0, [1286,1225,866,1135,1298,532,662,1348,1337,532,1094,1075,1085,1389,1407,532,797,1343,1192,1276,1249,1032,1116,1208,1094,1495,1415]],
  [0x05f0, [1042,1042,1042,788,1235]],
  [0x2000, [1024,2048,1024,2048,683,512,341,1139,569,410,171,0,0,0,0,0,682,682,1139,1139,2048,2048,856,1131,455,455,455,455,682,682,682,682,1139,1139,717,717,569,1059,2048,569,0,0,0,0,0,0,0,410,2048,2703,384,725,725,384,725,1067,663,682,682,1228,1024,1139,682,1627,1627,1005,1672,682,342,569,569,2201,1539,1539,945,1100,1100,1100,797,569,1056,797,806,1196,1627,981,1030,1284,1491,1491,569,1517,1196,569,569,455,0,1638,1838,1638,1838]],
  [0x2066, [1638,1638,1638,1638,0,0,0,0,0,0]],
  [0x20a0, [1139,1479,1479,1139,1139,1706,1479,2240,2384,1933,1739,1051,1139,1366,1251,2048,1067,1366,1593,1366,1139,1479,1139,1366,1251,1139,1139,1699,1610,1139,1285]],
  [0x2100, [1813,1813,1400,2149,1139,1813,1813,1139,1472,1921,1188,2167,1503,1529,1139,1139,1522,1145,1706,662,1666,1593,2197,1509,1651,1341,1593,1786,1739,1462,1404,1304,2048,2048,2048,1366,1290,1116,1573,1531,1200,455,1366,1366,1716,1376,1229,946,1235,1688,1251,2365,983,1286,1225,866,1135,555,1997,2503,1413,1024,1128,1479,1270,1593,1139,1139,1366,1495,1186,1022,702,702,1366,1366,1341,1931,1003,2111]],
  [0x2153, [1708,1708]],
  [0x215b, [1708,1708,1708,1708]],
  [0x2190, [2048,1024,2048,1024,2048,1024]],
  [0x21a8, [1024]],
  [0x2202, [1012]],
  [0x2206, [1253]],
  [0x220f, [1686]],
  [0x2211, [1460,1196]],
  [0x2215, [342]],
  [0x2219, [569,1124]],
  [0x221e, [1460,2005]],
  [0x2229, [1472]],
  [0x222b, [561]],
  [0x2248, [1124]],
  [0x2260, [1124,1195]],
  [0x2264, [1124,1124]],
  [0xfb1d, [532,0,1042,1192,1286,1135,1298,1075,1085,1389,1094,1415,1151,1495,1495,1495,1495,1286,1286,1286,1225,866,1135,1298,532,662]],
  [0xfb38, [1337,532,1094,1075,1085]],
  [0xfb3e, [1407]],
  [0xfb40, [797,1343]],
  [0xfb43, [1276,1249]],
  [0xfb46, [1116,1208,1094,1495,1415,532,1225,1075,1249,1286]]
];

let advanceTable: Map<number, number> | null = null;

function advances(): Map<number, number> {
  if (!advanceTable) {
    advanceTable = new Map();
    for (const [start, run] of ARIMO_ADVANCE_RUNS) {
      run.forEach((adv, i) => advanceTable!.set(start + i, adv));
    }
  }
  return advanceTable;
}

/**
 * The table above, with a fallback for code points it does not carry.
 *
 * `fallback` measures one character (in points at `sizePt`); the browser
 * passes the canvas measurer, tests pass nothing and get Arimo's average
 * character width.
 */
export function arimoMeasure(fallback?: Measure): Measure {
  return (text, sizePt) => {
    const table = advances();
    let units = 0;
    let extraPt = 0;
    for (const ch of text) {
      const adv = table.get(ch.codePointAt(0)!);
      if (adv !== undefined) units += adv;
      else if (fallback) extraPt += fallback(ch, sizePt);
      else units += 1191; // OS/2 xAvgCharWidth
    }
    return (units * sizePt) / ARIMO_UPM + extraPt;
  };
}

/**
 * A canvas 2D context set in the page-text face, kerning off — for the rare
 * character outside the advance table. `null` where there is no canvas (the
 * prerender, jsdom).
 */
export function canvasMeasure(): Measure | null {
  if (typeof document === 'undefined') return null;
  let ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  try {
    ctx =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1).getContext('2d')
        : document.createElement('canvas').getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const REF = 1000; // measure large, scale down: no per-size rounding
  ctx.font = `${REF}px "${PAGE_TEXT_FONT}"`;
  if ('fontKerning' in ctx) ctx.fontKerning = 'none';
  if ('textRendering' in ctx) (ctx as CanvasRenderingContext2D).textRendering = 'optimizeSpeed';
  const context = ctx;
  return (text, sizePt) => (context.measureText(text).width * sizePt) / REF;
}

/**
 * The measurer the editor uses: the exact table, the canvas for anything
 * else. Built once.
 */
let shared: Measure | null = null;
export function pageTextMeasure(): Measure {
  if (!shared) shared = arimoMeasure(canvasMeasure() ?? undefined);
  return shared;
}

/**
 * Start fetching the page-text face and resolve when it is usable.
 *
 * A text box drawn before the face arrives is drawn in a fallback font, and
 * a fallback font *is* a shift — so the first paint waits for it
 * (`font-display: block`), and Annotate kicks the download off as it mounts
 * rather than every page of the site preloading ~125 KB it will never use.
 */
export function loadPageTextFont(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return Promise.resolve();
  return document.fonts
    .load(`12px "${PAGE_TEXT_FONT}"`, 'Aא')
    .then(() => undefined)
    .catch(() => undefined);
}

