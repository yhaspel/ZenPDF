# Handoff to Claude CLI — ship "text boxes: one layout, drawn twice"

**Written 2026-09-25 by the Cowork session that implemented `.zen-annotate-text-PROMPT.md`.**
Paste this prompt into `claude` in the repo root (`~/Documents/Claude/Projects/ZenPDF`). It
follows the contract in `docs/reviews/handoffs/README.md` and owns **row 13** in
`TRACKING.md`.

---

## What this is

The owner's 2026-09-25 report: *"Annotate feature is very fragile. Text cut off constantly
and shifts when PDF is downloaded so text is not exactly aligned. Match the behaviour of
simplepdf.com/editor."*

**Root cause (proven before any code — `.zen-annotate-text-PROMPT.md` §1):** a text box was
laid out by **two unrelated text engines** — the browser (Zen Kaku Gothic New, line-height
1.25, 1 px/2 px *screen-pixel* insets, `pre-wrap` + `overflow-wrap:anywhere`) and MuPDF
(Helvetica, 1.2, its own breaker, an HTML fallback path for Hebrew) — and **both clipped to
a user-drawn rectangle**. Every row that differed was a shift; every overflow a cut-off, at
different points on screen and in the file.

**The fix — one layout, drawn twice:**

- **One face on both sides: Arimo Regular** (OFL, metric-compatible with Helvetica, covers
  Hebrew), vendored once: `backend/apps/pdf_engine/fonts/Arimo-Regular.ttf` and the
  **same bytes** at `frontend/public/fonts/Arimo-Regular.ttf` (+ a lossless woff2). CSS
  pins its metrics (`ascent-override` 1854/2048, `descent-override` 434/2048,
  `line-gap-override` 0) so the baseline is the same on every OS.
- **Line height 1.2, zero inset, kerning/ligatures off.** Baseline of line *i* =
  `(1.2 − (A + D))/2 · size + A · size + i · 1.2 · size` on both sides.
- **The client decides the lines** (`frontend/src/app/core/text-layout.ts`): hard breaks are
  the user's Enter; the only soft break is at the page's right edge (greedy by word; a word
  wider than the space by character). Measurement uses Arimo's own advance widths
  (a generated table — the same numbers PyMuPDF's `Font.text_length` uses), so the two
  sides cannot disagree about where a line ends, and layout does not wait for a web font.
- **The file draws exactly those lines.** The FreeText annotation stays MuPDF's (Contents,
  DA, NM intact — still selectable, editable, round-trippable); only its `/AP /N` is
  replaced, drawn line-by-line with `fitz.TextWriter` on scratch pages created in a
  **pre-pass before any `Page`/`Annot` handle exists** (the `_embed_images` segfault
  rule), and written with **raw xref keys after `annot.update()`** (the 2026-08-28 dirty-
  annot lesson — the test has a trailing op on another page). The lines are stored in
  `/ZenLines` and returned as `lines` by the reader. The font is subset on save (a saved
  file with one box is ~23 KB, not +300 KB).
- **The box is its text's size and never clips**: `w` = widest line, `h` = lines × 1.2 ×
  size; `overflow: visible` on screen. Text boxes lose their resize handles (size is
  derived); moving still works and re-wraps against the new right edge.
- **Click to place.** The click is line 1's vertical centre (`top = y − 0.6·size`),
  clamped to the page. The box grows as you type (re-laid per keystroke; the model still
  hears once per sitting, so Undo still takes back a sentence).
- **RTL by first strong character**: `dir="rtl"`, right-aligned lines; the engine emits
  UAX #9 visual order via `python-bidi` (new dependency, LGPL-3.0, pinned 0.6.11).

## What changed (one commit, delivered as a patch)

**Backend**

- `backend/apps/pdf_engine/engine/annotations.py` — `text_baseline()`,
  `paragraph_is_rtl()`, `_text_font()`, `_TextAP`, `_prepare_text_aps()` (pre-pass),
  `_write_text_ap()`, `_subset()`; `_read_annot` returns `lines` and rounds its rect to six
  decimals (the known cosmetic). `free_text` without `lines` (old clients, API users,
  foreign files) keeps MuPDF's stock appearance, unchanged.
- `backend/apps/pdf_engine/schemas/__init__.py` — optional `lines: string[]` (≤ 200 items,
  each ≤ 2000); never cross-checked against `contents`.
- `backend/requirements/engine.txt` — `python-bidi==0.6.11`.
- `backend/apps/pdf_engine/fonts/Arimo-Regular.ttf`, `Arimo-OFL.txt`, `README.md`.
- `backend/apps/pdf_engine/tests/test_annotations.py` — 32 new cases: font coverage +
  metrics; frontend serves the same bytes; baselines equal the formula to 0.01 pt for
  1/2/5 lines × 9/12/14/24 pt; `/Rect` is the rect sent; no glyph outside the rect ±0.5 pt;
  Hebrew right-aligned and extracting in logical spelling; bidi visual order; direction
  rule; `/Rotate` 90/180/270 upright; **trailing op on another page**; update redraws;
  foreign FreeText round-trips byte-identical AP; no-`lines` keeps stock; subset size;
  validation.

**Frontend**

- `frontend/src/app/core/text-layout.ts` (+ `.spec.ts`, 14 tests) — `layoutText`,
  `paragraphDir`, `textBaseline`, `arimoMeasure` (advance table), `canvasMeasure`
  (fallback for code points outside the table), `pageTextMeasure`, `loadPageTextFont`.
- `frontend/src/styles.scss` §19 — `@font-face "Zen Page Text"` + the new `.page-text` /
  `.page-text-editing` rules.
- `frontend/src/app/features/workspace/annotate.ts/.html` — Text box tool is `point`
  (click); `atLeastOneLine`, `TEXT_LINE_HEIGHT`, `TEXT_INSETS_PX` deleted; layout/rect/lines
  on create, on commit, on move, on paste/duplicate, on font-size change (Select only);
  live layout while typing; `flowText` reflow hook; hint copy "Click where the text goes
  and type."; the Font size control also shows under Select with a text box selected.
- `frontend/src/app/shared/page-overlay/*` — `OverlayItem.textDir` / `fixedSize`;
  `textInput` output and `textFlow` input; textarea `wrap="off"`, `dir`, grows as you
  type; drawn div gets `dir`; no handles on `fixedSize` items; `caretAfterReflow` (+ tests).
- `frontend/src/app/core/models/models.ts` — `Annotation.lines`.
- `frontend/public/fonts/Arimo-Regular.{ttf,woff2}`; `frontend/nginx.conf` caches `.ttf`
  like the other static assets.
- `annotate.spec.ts` — the "never shorter than one line" block replaced by 10
  click-to-place/size-from-text cases; `drawBox` now clicks the page like a person does.

**E2E** — new `e2e/tests/annotate-text-wysiwyg.spec.ts`: 8 runs (light/dark × dpr
0.75/1/1.5 + 390 px phone), 5 boxes each (name; two-line address; Hebrew with digits and a
comma; a 9 pt line; a line that wraps at the page edge). For each box it compares the
overlay's ink (screenshot minus the same screenshot with the drawn text hidden) against
the saved file's ink (the engine's raster of the saved version minus the same raster
without annotations) at the same device width: **ink bbox |Δ| ≤ 1 device px on every
edge** (the spec's gate), **the file's ink inside its box**, and a secondary
**shape-shift guard** — the cross-correlation peak between the two ink patches —
≤ 1.25 device px (the browser snaps baselines to whole pixels and MuPDF does not; the
spec header explains the allowance and the control that proves it still bites). Set
`WYSIWYG_EVIDENCE_DIR=<dir>` to keep every PNG and the measurements.

**Records** — design contract §2 (Page text face), §3 *Text on the page* rewritten
("One layout, drawn twice", "Click to place"; the one-line paragraph struck through as
superseded, its still-valid handle rules kept), §11 row (attached to the table —
checked with `grep -B1`); `01-architecture.md` §2 (python-bidi, Arimo); TRACKING row 13;
evidence in `docs/reviews/evidence/annotate-text/`; this prompt.

## Already verified in the sandbox (do not re-derive, do re-run)

- **Backend**, full `pytest` in the sandbox: **1159 passed / 16 skipped**, and 17 failed +
  13 errors that are **the identical set `main` produces in the same sandbox** (1128 passed
  there — the +31 are this change's tests): no `/certs/zenpdf-dev.p12`, no Ghostscript/OCR
  binaries, no Gotenberg. `ruff check .` clean; `mypy apps config` clean (180 files).
- **Frontend**: unit **633 passed / 68 files** (608 / 67 before); `ng lint` clean; build
  **43 prerendered routes** + `verify:prerender` green.
- **E2E** against a **local stack running this branch on both sides** (Django
  `runserver` + eager Celery + filesystem storage; the built frontend with `/api`
  proxied; Chromium 1194): the final full run is
  **88 passed / 1 skipped**, including the new wysiwyg spec **8 / 8** (and 24/24 more
  under `--repeat-each 3`); worst ink-bbox delta **1 device px**, worst shape shift
  **0.93 px** over all 40 boxes. Phase-3 and phase-12 — every annotate regression row
  from #44–#48 (type → place the next box keeps both, Undo/Redo, autosave, stamps,
  tick box) — green. The **8 failures are all environmental** and none touches
  Annotate: six need Mailpit on :8025 (phase-1 signature-request delete, phase-10-a11y
  ceremony, phase-8 ×2, phase-9 ×2), `phase-9: ads.txt` needs nginx's `/ads.txt`
  proxy (the sandbox's static server has none), and `phase-2b @smoke` gets the blob
  download's filename as "download" from this Chromium build (tool page untouched).
  Earlier full runs found two real flakes *in the new spec itself*, both fixed in it: a
  centre-of-mass metric that two rasterisers' shading moved by ~0.9 px (replaced by the
  cross-correlation shift), and a phone click that landed on the palette drawer while
  it slid shut (the spec now waits until the page is what the point hits).
- **The gate discriminates:** with the engine's baseline deliberately moved by 1.5 pt,
  all four light-theme runs failed — the shape shift read 1.0–3.0 px against a worst of
  0.93 px when nothing is moved.
- **What the sandbox could not do:** run the compose stack (`--e2e` with Mailpit,
  Gotenberg, Postgres), and anything on production (the new backend is not deployed).

## Your job

0. **Preflight.** `git status` — expect a clean tree on `main` at or after `bcba629`,
   plus untracked delivery files in the repo root: `.zen-annotate-text.patch`,
   `.zen-annotate-text-HANDOFF.md` (the pre-apply copy of this prompt with the patch's
   sha256 — verify with `shasum -a 256 .zen-annotate-text.patch`), and the three spec
   files the owner delivered (`.zen-annotate-text-PROMPT.md`, `freetext_ap_prototype.py`,
   `annotate-text-evidence.png`). `.claude/`, `_to_delete/` and `zen-sandbox.bundle` may
   also be present — leave `.claude/`/`_to_delete/` alone; `zen-sandbox.bundle` is the
   Cowork session's transfer copy of the repo and can be deleted.
1. **Apply.** `git checkout -b fix/annotate-text-wysiwyg && git am .zen-annotate-text.patch`
   (a `--binary` patch: fonts and PNGs). Set TRACKING row 13 🔵 in a follow-up commit.
   **Install the new backend dependency** — rebuild the api/worker images
   (`./infra/up.sh` rebuilds; `python-bidi` ships manylinux/macOS wheels for x86-64 and
   arm64). No frontend dependency changes.
   Move the owner's three spec files into the record rather than deleting them:
   `docs/archived/2026-09-25-annotate-text-PROMPT.md`,
   `docs/reviews/evidence/annotate-text/freetext_ap_prototype.py`,
   `docs/reviews/evidence/annotate-text/annotate-text-evidence.png` (one commit).
2. **Gate.** The full `infra/test.sh --e2e`. The new `annotate-text-wysiwyg.spec.ts` has
   never run against the compose stack; expect it green in all 8 runs. If a run fails,
   read its `measurements.json` attachment before touching tolerances — the spec's header
   and the evidence README explain what the numbers mean, and a real shift shows as a
   shape shift well over 1 px on most boxes of a run, not a 1-px fringe on one. The
   compose stack runs a newer Chromium than the sandbox's 1194; if its baseline
   snapping differs, record the measured distribution before changing anything.
3. **Self-review before the PR.** Adversarial pass over the diff. Lenses that matter:
   (a) the pre-pass: no `Page`/`Annot` handle may span a scratch-page create/delete
   (segfault, not an exception); (b) raw xref writes only after `annot.update()`;
   (c) rotation 90/270 — BBox in display dims, `/Matrix` from `_AP_ROTATION`, exactly as
   `_write_image_ap`; (d) the foreign-FreeText path must stay byte-identical until edited;
   (e) contract conformance — §11 row attached, both themes, 44 px floors untouched.
4. **Ship.** PR `fix/annotate-text-wysiwyg` → `main` (squash per habit), then the
   `docs(tracking): …` commit on `main`: row 13 ✅ with PR + sha, this prompt archived to
   `docs/archived/2026-09-25-handoff-to-cli-annotate-text-wysiwyg.md` with an
   **Executed** banner, and the PROGRESS session log **"2026-09-25 — Text boxes: one
   layout, drawn twice"** (report, RCA, decisions, gate numbers, production evidence).
5. **Verify production** (Railway auto-deploys `main`; wait for the new bundle hash). As a
   guest from `/annotate-pdf` with `backend/tests/fixtures/pdfs/text.pdf`, place the same
   five boxes (the spec's `BOXES`), Save, **Download**, and open the file in a desktop
   viewer (Preview/Acrobat) — no shift, nothing cut off, Hebrew right-aligned with "12,"
   where the browser put it. Then the owner's Chrome, both themes, and one pass at 390 px.
   If you use the Cowork reverse-proxy harness, remember `.mjs` in its MIME table.
6. **Leave the tree clean.** No `.zen-annotate-text.patch`, no `.zen-annotate-text-HANDOFF.md`,
   row 13 ✅, prompt archived.

## Out of scope (from the spec, §7 — do not widen)

- Edit mode's add-text path (`engine/content.py`) keeps its own font choices.
- Existing saved text boxes keep MuPDF's appearance until edited; no migration.
- Default size stays 12 pt (SimplePDF uses 10).

## Warnings inherited

- Never run git through the Cowork device bridge. `_to_delete/` is gitignored debris.
- Autosave (30 s) can turn placements into saved facts mid-test; save explicitly before
  comparing.
- `pkill -f <pattern>` from a shell whose own command line contains the pattern kills that
  shell — use `fuser -k <port>/tcp`.
