# ZenPDF — Annotate text boxes: one layout, drawn twice (PR `fix/annotate-text-wysiwyg`)

Owner report (2026-09-25): "Annotate feature is very fragile. Text cut off constantly and shifts when PDF is downloaded so text is not exactly aligned. Match the behaviour of https://simplepdf.com/editor."

Base: `main` @ `bcba629`. Read `AGENTS.md`, `docs/design/design-instructions.md` §3 "Text on the page", and this whole file before touching code.

---

## 1. Root cause (proven, not guessed)

A text box is laid out by **two unrelated text engines** and both **clip to a user-drawn rectangle**:

| | Editor overlay (`.page-text`, `styles.scss:1402`) | Saved file (`engine/annotations.py:445`, `add_freetext_annot`) |
|---|---|---|
| Font | `--font-ui` = Zen Kaku Gothic New (Latin subset only → Hebrew falls back to a system font) | Helvetica (`/Helv`); for non-Latin MuPDF silently switches to an HTML layout path with a fallback font |
| Line height | 1.25 | 1.2 (Latin); different again on the non-Latin path |
| First baseline | half-leading + that font's ascent | 0.8 × size below top (Latin), 0.9 × size (non-Latin) |
| Inset | `1px 2px` **screen pixels** (zoom-dependent) | 0 |
| Wrapping | browser `pre-wrap` + `overflow-wrap:anywhere` with Zen Kaku widths + kerning | MuPDF's own breaker with Helvetica widths |
| Overflow | `overflow:hidden` | `re W n` clip to `/Rect` |
| RTL | textarea has no `dir` → Hebrew laid out LTR, left-aligned | MuPDF lays it out RTL |

Every row that differs is a visible shift; every overflow is a cut-off — and the overflow happens at *different* points on screen and in the file because the wrap widths differ. `atLeastOneLine` (PR #45/#46) only hid the thinnest case. Reproduced in the sandbox against PyMuPDF 1.28.2 and Chromium 1194 — see `annotate-text-evidence.png` (left).

## 2. What SimplePDF does (measured by driving simplepdf.com/editor headlessly, 2026-09-25)

- **Click to place**, no drag. The click is the vertical centre of the first line; the box's top-left follows.
- The field is a `<textarea>` with **padding 0**, `white-space: pre-wrap`, `overflow: hidden`, sized by a hidden `<pre style="width:max-content">` mirror holding the same text → **the box grows to fit its text** (width while on one line, height per line). **It never clips.**
- **One font on both sides**: the browser uses Liberation Sans; the downloaded PDF contains an embedded `LiberationSans` subset at the same size. Default 10 pt, line height 1.054 × size.
- Output is drawn as explicit lines at explicit baselines (they flatten into page content; we will keep a real FreeText annotation — see §4). Hebrew works because the font covers it.

The principle to copy: **the client decides the lines; the file draws exactly those lines with the same font at baselines both sides compute with the same formula; the box is sized from its content, so nothing is ever clipped.**

## 3. Proof the design holds (sandbox, 2026-09-25)

`freetext_ap_prototype.py` (delivered alongside this prompt) writes FreeText annots whose `/AP` is drawn line-by-line in **Arimo** (OFL/Apache, metric-compatible with Helvetica/Liberation Sans, **covers Hebrew**). The same boxes rendered by Chromium with the CSS in §5.2 were pixel-diffed against the PyMuPDF raster at 2×:

| box | file ink extent (pt) | browser ink extent (pt) |
|---|---|---|
| "Yuval Haspel" 12pt | x 1.0–72.5, y 6.0–19.5 | x 1.0–72.5, y 5.5–19.5 |
| 2 lines Latin 12pt | x 0.5–138.0, y 6.0–30.0 | x 0.5–138.0, y 5.5–29.5 |
| 2 lines Hebrew 14pt (RTL, right-aligned, "12," bidi) | x 4.0–158.5 | x 4.0–159.0 |
| 9pt with AVAWAY/fi/fl | x 3.5–110.0 | x 3.5–110.0 |

Horizontal: identical. Vertical: ≤ 0.5 pt = one device pixel of browser baseline snapping. Hebrew word order and alignment identical. Extracted baselines equal the formula exactly (52 + 11.36 = 63.36). Evidence image, right panel.

## 4. Decisions (owner may overrule; do not relitigate otherwise)

1. **Stay a FreeText annotation** (not flattened like SimplePDF): Annotate's marks must stay selectable/editable/deletable and round-trip through extract→apply. We replace only its **appearance stream**.
2. **Text font = Arimo Regular**, one file, shipped in `backend/apps/pdf_engine/fonts/Arimo-Regular.ttf` and served to the frontend from `frontend/public/fonts/` (same bytes; add to `fonts/README.md` with licence). Get it from `https://fonts.gstatic.com/s/arimo/v36/P5sfzZCDf9_T_3cV7NCUECyoxNk37cxsBw.ttf` (full cmap incl. Hebrew; upm 2048, hhea/typo ascent 1854, descent 434, USE_TYPO_METRICS on). Verify Hebrew coverage with fontTools in a test.
3. **Line height 1.2 × size. Zero inset.** Baseline of line *i* (from box top) = `(1.2 − (A + D))/2 · size + A · size + i · 1.2 · size`, with `A = 1854/2048`, `D = 434/2048`.
4. **The box is sized from its lines**: `w = widest line`, `h = lines × 1.2 × size`. No clipping anywhere, on screen or in the file.
5. **Line breaks are decided once, in the client**, and sent as `lines`. Hard breaks are the user's `\n`; a soft break is inserted only when a line would cross the page's right edge (greedy by word; a single word wider than the space breaks by character).
6. **Click to place.** A drag is treated as a click at its start point. The click is the vertical centre of line 1 (`top = y − 0.6·size`), clamped so the box stays on the page.
7. **RTL**: paragraph direction = first strong character (Hebrew/Arabic → RTL). RTL boxes right-align lines inside the box; the file uses the Unicode bidi algorithm (`python-bidi`, `get_display(line, base_dir='R'|'L')`) to emit visual order.
8. **Kerning and ligatures off on both sides** (MuPDF's TextWriter does not kern; the browser must not either).

## 5. Implementation

### 5.1 Backend (`backend/apps/pdf_engine`)

- `requirements`: add `python-bidi` (pin latest). No other new deps.
- `schemas/__init__.py` ANNOTATION: optional `lines: array[string]` (maxItems ~200, each maxLength ~2000); for `free_text` the join of `lines` with spaces/newlines must be consistent with `contents` only loosely — do **not** reject on mismatch, `lines` wins for drawing, `contents` stays the comment text.
- `engine/annotations.py`, `free_text` branch: create the annot as today (keeps `/Contents`, `/DA`, NM etc.), then call a new `_write_text_ap(doc, annot, rect, lines, size, color, rotate)` modelled on `_write_image_ap` and the prototype:
  - draw the lines with `fitz.TextWriter` on a **scratch page** of exactly the box size (use the `_embed_images` hoisting rule — scratch pages mutate the page list and invalidate live handles; create them before any `Page`/`Annot` handle is held, or build all text APs in a pre-pass and delete the scratch pages at the end — read the segfault notes in `_embed_images` first);
  - `scratch.clean_contents()`, copy its content stream into `AP/N` and its `/Resources` into the AP's `/Resources`, set `BBox [0 0 w h]`, `Matrix` from `_AP_ROTATION[rotate]` (swap w/h at 90/270 exactly as `_write_image_ap` does);
  - **raw xref writes only after `annot.update()`** — `set_rect`/`set_info` after this would mark the annot dirty and MuPDF re-synthesises dirty annots when a later op loads another page (the 2026-08-28 stamp lesson). Regression test must include a trailing op on another page.
  - store the lines in a private key (e.g. `/ZenLines`, JSON via `get_pdf_str`) next to `_IMAGE_STAMP_KEY`; `_read_annot` returns them as `lines`. Round floats in `_read_annot` like the words reader does (known cosmetic).
  - Subset the font on save (the engine already subsets in `content.py:428`; make sure annotation saves do too, or files grow ~300 KB per document).
- Tests (`tests/test_annotations.py`): baseline positions from `get_text('dict')` equal the formula to 0.01 pt for 1/2/5 lines at 9/12/14/24 pt; Hebrew line extracts in logical order and renders right-aligned; `/Rect` equals the sent rect; no `re W n` clip wider than the box is needed (assert no clipped glyphs: every span bbox inside rect ± 0.5 pt); rotation 90/180/270; trailing-op-on-another-page; foreign FreeText (made by stock `add_freetext_annot`, no `/ZenLines`) round-trips untouched when not edited.

### 5.2 Frontend

- `styles.scss` — replace the `.page-text` rule:
  ```css
  @font-face {
    font-family: "Zen Page Text";
    src: url("/fonts/Arimo-Regular.woff2") format("woff2"), url("/fonts/Arimo-Regular.ttf") format("truetype");
    ascent-override: 90.52734375%;  /* 1854/2048 — pins the baseline across OSes */
    descent-override: 21.19140625%; /* 434/2048 */
    line-gap-override: 0%;
    font-display: block;
  }
  .page-text {
    position: absolute; margin: 0; padding: 0; border: 0;
    font-family: "Zen Page Text"; line-height: 1.2;
    white-space: pre; overflow: visible;
    font-kerning: none; font-variant-ligatures: none; font-feature-settings: "kern" 0, "liga" 0;
    background: transparent;
  }
  ```
  `.page-text-editing` keeps its ring/wash/caret, **no padding, no border**, `overflow: hidden` only on the textarea's scrollbars (`resize:none`, `wrap="off"`), and its size is driven by the measured lines, not by CSS. Preload the font (`<link rel="preload" as="font" crossorigin>`) — a fallback-font first paint *is* a shift.
- New pure module `frontend/src/app/core/text-layout.ts`:
  - `layoutText(text, sizePt, maxWidthPt, measure) → { lines, widthPt, heightPt }` — greedy word wrap only at `maxWidthPt`, hard breaks kept, over-long words broken by character; `measure(str, sizePt)` injected.
  - `canvasMeasure` implementation: an `OffscreenCanvas`/`<canvas>` 2D context with `ctx.font = \`${size}px "Zen Page Text"\``, `ctx.fontKerning = 'none'`; await `document.fonts.load(...)` before first use.
  - `paragraphDir(text)` — first strong char.
  - Unit tests: fixed widths via a fake `measure`; hard/soft breaks; long word; empty lines; RTL detection; idempotence (re-wrapping the output at its own width reproduces it).
- `annotate.ts`:
  - `free_text` placement → click semantics per §4.6; delete `atLeastOneLine`, `TEXT_LINE_HEIGHT`, `TEXT_INSETS_PX`.
  - On every text change (and on commit): run `layoutText` with `maxWidthPt = pageWidthPt − box.x`, set `rect = {x, y, w: widthPt, h: heightPt}` (normalised) and `lines`. Send `lines` in the op.
  - Font-size change on an existing box re-lays it out.
  - Items loaded without `lines` (foreign files): lay out `contents` at the rect's width for display only; do not rewrite them until edited.
- `page-overlay.html/ts`: the drawn view renders `lines` joined by `\n` with `white-space: pre`, `dir` from `paragraphDir`, `text-align: start`; the textarea uses the same box, `dir`, and grows as you type (recompute on `input`, not on blur). Text boxes lose the four corner handles (size is derived); dragging to move stays. Keep every existing `data-test`.
- The textarea's own soft-wrap must never kick in: `wrap="off"` + width from the layout. Only `layoutText` breaks lines.

### 5.3 Design contract (owner is authority; this is the requested change)

Amend §3 "Text on the page" in place and add a §11 log row: box sized from its text and **never clipped**; one text face (Arimo) on screen and in the file; 1.2 line height; zero inset; click to place; lines decided by the client; RTL by first strong character; the "never shorter than one line" paragraph is superseded. Check the table-row blank-line gotcha with `grep -B1` after appending.

## 6. Acceptance gate

1. `pytest` (engine + annotations API), frontend unit, `ng lint`, ruff, mypy, build + prerender + `verify:prerender`, `--e2e`.
2. **Pixel gate (new Playwright spec, both themes, zoom 0.75/1/1.5, and 390 px):** place boxes with "Yuval Haspel", a two-line address, a Hebrew line with digits and a comma, a 9 pt line, and a line long enough to hit the page edge. Save. For each box compare the overlay's ink bbox (screenshot) with the file's ink bbox (`/api/…/render` of the saved version, `annots=true`) — **|Δ| ≤ 1 device px horizontally and vertically**, zero clipped glyphs (file span bboxes ⊂ rect).
3. Regression rows from #44/#45/#46/#47/#48 still green (type → draw next box keeps both; Undo/Redo; autosave; stamps; tick box).
4. Verify on production after deploy with the reverse-proxy harness (`/tmp/harness.mjs` pattern, `.mjs` MIME) and in the owner's Chrome: the same five boxes, download, open in a desktop viewer, confirm no shift.

## 7. Out of scope / note for the owner

- Edit mode's add-text path (`engine/content.py`) has its own font choices; not touched here.
- Existing saved text boxes keep their old MuPDF appearance until edited; once edited they get the new one. No migration.
- SimplePDF defaults to 10 pt; ZenPDF keeps its 12 pt default unless the owner says otherwise.
