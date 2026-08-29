**Executed 2026-08-29 — see PROGRESS.md session log "2026-08-28 — Annotate tells the truth: stamp, image stamp, squiggly", PR #48 (`cdaa5b3`). The patch's sha256 matched the record in the pre-apply copy before it was touched, `git am` applied clean on `6916604`, and the fifteen files shipped **unchanged — no product code was edited by the executing session**. The gate was green end to end: backend **1168 passed / 6 skipped**, coverage apps 91.56 % / pdf_engine 91.91 %, ruff + mypy clean (180 source files), `ng lint` clean, unit **608 passed / 67 files**, build **43 prerendered routes** + `verify:prerender`, Playwright **88 passed / 1 skipped** — and *both* phase-3 cases this prompt correctly flagged as never having run anywhere passed on their first execution: the amended `the palette shows the uploaded stamp, and arms it again` (filechooser flow) and the new `squiggly waves, stamps stamp, and the drawn rect survives the save`. The known `phase-1 @smoke` flake behaved. **One correction to this prompt's own record, from the browser:** step 5 says to compare production against `main-YDCXFDKV.js`, "which is live now" — by the time the CLI ran, production was already on `main-PMI4V7BP.js`, so that was the baseline used. **What this prompt could not prove and the CLI could:** the two engine fixes. Run against the *local* stack (new frontend **and** new backend), the stamp drawn at ratio 1.531 and the image stamp at 1.217 both came back out of the file at **exactly those ratios** after Save and a full reload — not the ~4:1 the aspect-fit used to impose — and the comment typed on the stamp came back **"second pass, please"**, not "Approved". The self-review's four lenses cleared the change and added two verifications rather than findings: the new backend tests **discriminate** (monkeypatch `_restore_stamp_rect_and_contents` to a no-op and both fail), and the raw `/Rect` write **cannot emit scientific notation**, which PDF numbers do not permit — probed across `/Rotate` 0/90/180/270 × four extreme rects including sub-micron origins, zero exponent forms, because the six-decimal clamp upstream keeps every non-zero coordinate at or above ~4e-4. **No queue rows added.** Historical.**

# Handoff to Claude CLI — ship the annotate defect fixes (stamp / image stamp / squiggly)

**Written 2026-08-28 by the Cowork session that validated and fixed the defects.** Paste
this prompt into `claude` in the repo root (`~/Documents/Claude/Projects/ZenPDF`). It
follows the contract in `docs/reviews/handoffs/README.md` and owns **row 12** in
`TRACKING.md`.

---

## What this is

The owner's 2026-08-28 defect report on Annotate, all three **validated on production**
before any code was touched:

1. **"Stamp tool just draws a rectangle with the word approved above it."** True — the
   overlay mapped a stamp to a bare outlined rect with its name in the 10 px selection
   badge floating above. The *saved file* was right all along (MuPDF synthesises the
   bordered-capitals appearance; View mode showed it), but Annotate's raster is
   deliberately clean (`?annots=false`), so the overlay is the only rendering anyone
   sees in the editor — and it lied for the whole session.
2. **"Image Stamp is not working (button not clickable)."** True — the palette entry was
   natively `disabled` until a stamp existed in the session, exactly as the design
   contract specified on 2026-08-23. Its only explanation was a hover `title`, which
   reads as "broken" and does not exist on touch. The upload path itself works
   end-to-end on production (verified: upload → button arms wearing the preview →
   placement → save → pixels in the file).
3. **"Squiggly tool seems to just highlight text."** True — the overlay painted all four
   text-markup kinds as identical filled quads. The saved file was right (a real yellow
   wave, verified in View mode); underline and strike-out had the same defect.

And two engine defects the review found **behind** the report, both probed in
isolation with PyMuPDF before fixing:

4. **Both stamp kinds saved reshaped.** `add_stamp_annot` aspect-fits `/Rect` to the
   built-in appearance — a 190×80 pt box comes back 190×50 for "Approved" — so the
   stamp landed squashed relative to what the user drew, and an image stamp's pixels
   were stretched into the *reshaped* box (measured live on production: a 3:2 drag
   saved as ~4:1).
5. **A comment typed on any stamp was clobbered on save.** `annot.update()` writes the
   stamp's own name into `/Contents` — every stamp's comment came back "Approved",
   image stamps' included.

## What changed (14 files, one commit, delivered as a patch)

**Frontend — the overlay draws every mark the file's own way:**

- `frontend/src/app/shared/page-overlay/overlay-model.ts` — `OverlayItem` gains
  `quadStyle` (`'fill' | 'underline' | 'strikeout' | 'squiggly'`), `stampText`
  (bordered-capitals rubber-stamp rendering) and `imageUrl` (pixels stretched to the
  rect, `preserveAspectRatio: none`, exactly as the saved appearance stream does).
- `frontend/src/app/shared/page-overlay/page-overlay.html` — the `quads` case renders
  per style (wash / line under / line through / wave under; thickness proportional to
  the quad's height, 1.5 px floor); the default rect case renders `imageUrl` as an SVG
  `<image data-test=overlay-image>`, `stampText` as a double border
  (`overlay-stamp-border`) + squeezed `textLength` serif capitals
  (`overlay-stamp-text`); plain rects unchanged.
- `frontend/src/app/shared/page-overlay/page-overlay.ts` — the helpers
  (`markupColor/markupLinePx/squigglePath/stampBorderPx/stampInnerPx/stampFontPx/
  stampTextLengthPx`), and `strokePx` now scales against `pageWidthPt()` instead of a
  hardcoded 595 (strokes rendered ~3 % thin on Letter pages).
- `frontend/src/app/features/workspace/annotate.ts` — markup mapping carries
  `quadStyle`; stamp maps to `stampText: stampDisplay(name)` (camel-case split, upper
  — `NotForPublicRelease` → "NOT FOR PUBLIC RELEASE", matching MuPDF); image stamp maps
  to the held stamp's object URL while `annotations.stamp()` matches its `image_ref`,
  else a stamp-style `IMAGE` placeholder (a reloaded mark's pixels live only in the
  file — there is no asset-download endpoint, and that is fine); no more floating
  `label` on either stamp kind. New `armImageStamp(picker)`: with a stamp it re-arms
  the tool, with none it opens the picker. New exported `stampDisplay()`.
- `frontend/src/app/features/workspace/annotate.html` — the image-stamp entry loses
  `[disabled]` and the dashed disabled classes, gains
  `(click)="armImageStamp(stampUpload)"` and a state-dependent `title`; the custom
  stamp input gains `#stampUpload`.

**Backend — the engine saves what was drawn:**

- `backend/apps/pdf_engine/engine/annotations.py` — new
  `_restore_stamp_rect_and_contents(page, annot, rect, spec)` called by both stamp
  branches after the appearance work. Writes `/Rect` and `/Contents` as **raw xref
  keys** (`rect × ~page.transformation_matrix`, probed equal to `set_rect`'s output on
  /Rotate 0/90/180 and offset-CropBox pages; `fitz.get_pdf_str` for contents).
  Raw on purpose: `set_rect`/`set_info` mark the annot **dirty**, and MuPDF
  re-synthesises dirty stamps when a later op loads another page — the restored rect
  was undone mid-batch, and a dirty image stamp would entitle MuPDF to rebuild the
  custom appearance we just wrote. The docstring carries this.

**Tests (all written to fail on the old code):**

- `frontend/src/app/features/workspace/annotate.spec.ts` — new describe **"Annotate —
  marks look like what the file will save"** (6 tests: wash / lines with exact y /
  wave / stamp text+border+no badge / image pixels / placeholder), and the image-stamp
  entry's first test becomes **"opens the stamp picker when pressed with nothing
  uploaded"**.
- `backend/apps/pdf_engine/tests/test_annotations.py` — `test_stamps_keep_the_rect_the_
  user_drew` (both kinds + red-pixel region check, **with a later op on another page**,
  which is the regression trigger) and `test_a_stamps_comment_survives_the_appearance_
  builder` (typed, empty, and image-stamp comments).
- `e2e/tests/phase-3.spec.ts` — the stamp test's disabled assertions become the
  filechooser flow (Playwright `waitForEvent('filechooser')`), and a new test
  **"phase 3: squiggly waves, stamps stamp, and the drawn rect survives the save"**
  (wave not fill; APPROVED in a border, no floating badge; 3:2 drawn aspect survives
  save+reload ±0.1; the typed comment survives).

**Records:**

- `docs/design/design-instructions.md` — §3 Tool palette button amended (always
  pressable, opens the picker; the superseded "disabled until" spec kept inline with
  the reason it failed); the §3 raster paragraph gains **"the overlay owes every mark
  the file's own appearance"**; §11 log row (attached to the table — mind the blank
  line).
- `docs/reviews/handoffs/TRACKING.md` — row 12 (this prompt; set it 🔵 first thing).
- `docs/reviews/evidence/annotate-defects/` — three harness screenshots (all marks
  drawn, after save+reload light, dark).
- `docs/reviews/handoffs/handoff-to-cli-annotate-defects.md` — this prompt.

## Already verified in the sandbox (do not re-derive, do re-run)

Unit **608 passed / 67 files** (602 before; 6 new). Type-aware `ng lint` clean. Prod
build + **43 prerendered routes** + `verify:prerender` green. Backend
`apps/pdf_engine/tests/ + apps/documents/tests/test_annotations_api.py`: **505 passed /
10 skipped** (4 fails = the sandbox's usual missing Ghostscript/OCR/unpaper binaries);
`ruff` + `mypy` clean. Browser pass: the built frontend served against the
**production API**, both themes, console clean — all four markups render distinct, the
stamp draws as bordered APPROVED capitals, the image stamp draws its actual pixels,
and after reload the image stamp shows the IMAGE placeholder (evidence PNGs in the
patch).

**What the sandbox could NOT verify (production still runs the old backend):** the
rect and contents fixes live. On that harness run the reloaded stamps still came back
aspect-fitted (3.80) with contents "Approved" — that is the *old production backend*
answering, and it is what your post-deploy check must show fixed.

## Your job

0. **Preflight.** `git status` — expect a clean tree on `main` at or after `6916604`,
   plus two untracked delivery files in the repo root:
   `.zen-annotate-defects.patch` and `.zen-annotate-defects-PROMPT.md` (the pre-apply
   copy of this prompt, which carries the patch's sha256 — verify it with
   `shasum -a 256 .zen-annotate-defects.patch` before applying). `.claude/` and
   `_to_delete/` may also be present — leave those alone.
1. **Apply.** `git checkout -b fix/annotate-truth && git am .zen-annotate-defects.patch`
   — it applies cleanly on `6916604` (proven by a fresh-clone `git am` in the sandbox;
   it is a `--binary` patch because of the three PNGs). Then
   `rm .zen-annotate-defects.patch .zen-annotate-defects-PROMPT.md`. Set TRACKING
   row 12 🔵 in a follow-up commit. `npm install` in `frontend/` is NOT needed (no
   dependency changes).
2. **Gate.** The full `infra/test.sh --e2e`. Two phase-3 e2e cases have **never run
   anywhere**: the amended `the palette shows the uploaded stamp, and arms it again`
   (filechooser flow) and the new `squiggly waves, stamps stamp, and the drawn rect
   survives the save`. Expect Playwright 88 passed / 1 skipped (87+1 before). Watch
   the known flake: `phase-1 @smoke` is intermittent in full `--e2e` runs (queue row).
3. **Self-review before the PR.** Adversarial pass over the diff (this step caught a
   real regression in PR #45 — take it seriously). Four lenses that matter here:
   (a) SVG rendering — `textLength` on short words stretches ("SOLD" fills 84 % of its
   box; MuPDF does the same, see `docs/reviews/evidence/annotate-defects/`);
   (b) the raw-xref writes — confirm the docstring's dirty-flag story against the
   test with the trailing op; (c) template a11y — the image-stamp button kept
   `aria-pressed` and its 44 px floor; (d) contract conformance — §11 row attached to
   its table (the blank-line lint remains unwritten), grounding list deliberately
   unchanged.
4. **Ship.** PR `fix/annotate-truth` → `main` (squash-merge per repo habit), then the
   `docs(tracking): …` commit on `main` flipping row 12 ✅ with the PR number + sha,
   archiving this prompt to `docs/archived/2026-08-28-handoff-to-cli-annotate-defects.md`
   with an **Executed** banner, and writing the PROGRESS session log
   **"2026-08-28 — Annotate tells the truth: stamp, image stamp, squiggly"** (defects,
   root causes incl. the MuPDF dirty-stamp re-synthesis mechanism, gate numbers,
   production evidence). `docs/**` never deploys — product code drives the deploy.
5. **Verify production** (Railway auto-deploys `main`; wait for the new bundle hash in
   `index.html`, compare against `main-YDCXFDKV.js` which is live now). As a guest
   from `/annotate-pdf` with `backend/tests/fixtures/pdfs/text.pdf`:
   - **Squiggly** over words → a wave on the overlay (not a fill); underline and
     strike-out draw as lines; highlight still a wash. Save → View mode agrees.
   - **Stamp** drawn deliberately squarish (~3:2) → bordered APPROVED capitals filling
     the drawn box, no floating badge; type a comment on its row; Save → reload →
     **the rect is still ~3:2** (not ~4:1) and **the comment is still yours** (not
     "Approved"). This is the backend fix only production can prove.
   - **Image stamp** pressed with nothing uploaded → the file picker opens; pick
     `backend/tests/fixtures/images/sample.png` → button arms wearing the preview →
     drag ~3:2 → **the actual pixels render in the box**; Save → reload → rect keeps
     its shape, placeholder reads IMAGE; View mode shows the pixels at the drawn
     shape.
   - Both themes on the annotate screen; one pass at 390 px (the palette drawer);
     console clean throughout.
6. **Leave the tree clean.** No stray files, no `.zen-annotate-defects.patch`, row 12
   ✅, prompt archived.

## Warnings inherited from the sessions before this one

- Never run git through the Cowork device bridge (strands `.git/index.lock`) — not
  your problem in the CLI, recorded so nobody "helpfully" does it from Cowork.
- `_to_delete/` in the repo root is gitignored debris awaiting the owner's manual
  delete; leave it.
- The workspace turns `dir=rtl` after visiting View mode in a Hebrew-locale browser
  until the next full load — pre-existing, layout mirrors correctly, not this change.
- Autosave (30 s) can turn placements into saved facts mid-test; local Undo cannot
  take those back (by design). Save explicitly before comparing counts.
