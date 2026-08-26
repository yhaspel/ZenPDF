**Executed 2026-08-26 — see PROGRESS.md session log 2026-08-26. Historical.**

# Handoff — Land the annotate text-box fix (2026-08-26)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** the patch carries its own commit — you apply it onto a fresh `fix/annotate-text-fields`.
**Depends on:** nothing — the handoff programme (rows 1–10) is complete; this is a one-off fix outside it, recorded in TRACKING's "Landed outside the programme" table, not as a numbered row.
**What lands:** `.zen-annotate-text-fields.patch` (repo root on this Mac, sha256 `733eeadb…`), one commit authored in the review sandbox and proven to `git am` cleanly onto `d10fb5e`, reproducing the reviewed tree byte for byte:

`fix(annotate): text boxes survive the next gesture; the overlay raster is drawn without annotations` — the owner filled in a scanned two-page bank form with Annotate's text box (type, draw the next box, type…) and reported "the previous field disappears or doubles itself like it copy-pasted". Reproduced on production before the change: of four boxes drawn straight after typing, **two vanished as they were drawn**; after Save every survivor was **drawn twice**, and a drag left its twin behind. Two root causes, both in the Phase 3 overlay:

1. **The next box's gesture never blurred the box being typed into.** Every draw handler cancels `pointerdown` (it must, to drag), and a cancelled pointerdown moves no focus in Chromium — measured: `pointerdown, pointerup`, no `mousedown`, no `blur`. The editor was torn down uncommitted when `pageEditingId` moved on, and the browser decided what that meant. Chromium fires `blur` for a removed element, so the text *was* committed, but `editingEnded` carried no id and `onPageEditingEnded()` read `pageEditingId()` — already the *new*, empty box — and deleted it as litter. WebKit/Firefox/jsdom fire nothing: the *previous* box lost its words and stayed on the page invisible. Fix: `PageOverlay.finishEditing()` (public, idempotent) commits the open editor at the start of every pointer gesture on the page; `editingEnded` names its item; `Annotate.onPageEditingEnded(id)` judges only that item; undo / redo / "Edit text…" / a drawn box go through `editOnPage()` which finishes first; `AnnotationsFacade.update` ignores a no-op patch so a double report costs no ⌘Z.
2. **The Annotate raster was rendered with the annotations baked in.** `?annots=false` has existed since Phase 3 with a backend test naming the overlay as its reason; the frontend never sent it. Fix: `PageOverlay.rasterAnnotations` input (Annotate passes `false`) → `thumbnailBlob(…, { annots: false })`. Backend refinement: the clean render now strips the page's markup from the in-memory copy and **keeps form widgets** (MuPDF's own `annots=False` hid those too, which would blank a filled form under Annotate) — `_strip_annotations` in `render.py`, with an engine test.

Also in the commit, found on the way: Edit's **scanned-page gate shows only in *Edit text*** (it sat above *Add text* on the scan, which works, saying the page could not be edited); *Add text* gets a one-line hint (`data-test=add-text-hint`) and its editor takes the caret on opening. Design contract amended in place (§3 *Text on the page*: two new paragraphs; §4 workspace Edit; §11 row — no grounding-list entry, nothing new is offered). `PROGRESS.md`: session-log entry "2026-08-26 — Filling in a form with text boxes…" plus two LOW queue rows (the open box goes out empty in the 30 s autosave; Edit's *Add text* is a version per box). `e2e/tests/phase-3.spec.ts`: the free-text test now draws the next box straight after typing and asserts the overlay's raster requests carry `annots=false` — **type-checked and `--list`ed in the sandbox, not run**.

**Verified in the sandbox before delivery:** `ng test` **587 passed / 66 files** (11 new or amended; the five that script the fill-in-a-form flow all fail on the old code — `['', '', 'Bank Hapoalim']`), `ng lint` clean, `npm run build` → **43 prerendered routes**, `verify:prerender` green; backend **1148 passed / 16 skipped** with the dev cert generated (the 7 failures were the sandbox's usual admin/redis ×2, Ghostscript ×2, tesseract/unpaper ×3), `ruff check` + `mypy` clean; the fixed build served locally against the **production API** kept 4/4 boxes with their words, drew them once after Save, left no ghost after a drag; Edit checked in both themes. The defect was also reproduced in the owner's own Chrome 152 on production before the fix (box vanished on the spot; doubled text after the autosaves).

**Deploys on merge?** Yes — `frontend/**` rebuilds `web`, `backend/**` rebuilds `api` and the workers. No migrations, no new dependencies, no env changes; the clean raster's cache key already carries its own suffix (`-clean`), so nothing cached collides.

Paste everything in the block below into `claude`.

---

```text
You are landing a prepared one-commit fix for Annotate's text boxes (they vanished or
doubled when a scanned form was filled in field by field), then running the repo's full
gate, browser-verifying it locally, shipping it through a PR with a self-review, and
validating it on production in a real browser. Read AGENTS.md first, then the PROGRESS
session-log entry "2026-08-26 — Filling in a form with text boxes: the field that
vanished, the text that doubled" (it is the record of what this patch does and why —
it is inside the patch, so read it after step 0), then docs/reviews/handoffs/TRACKING.md
("Landed outside the programme" is where you will record this; it is not a numbered row).

## 0. Preflight and apply

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain            # must be clean apart from the two delivered files:
                                      #   .zen-annotate-text-fields.patch  (repo root)
                                      #   docs/reviews/handoffs/handoff-to-cli-annotate-text-fields.md
                                      # if anything ELSE shows, stop and tell me
    shasum -a 256 .zen-annotate-text-fields.patch   # must start 733eeadb
    git switch main && git pull --ff-only origin main
    git log --oneline -1              # if main has moved past d10fb5e, git am --3way below;
                                      # on any conflict: git am --abort, stop, tell me — the patch is regenerable
    git switch -c fix/annotate-text-fields
    git am --3way .zen-annotate-text-fields.patch
    git log --oneline -2              # one commit, titled exactly:
                                      #   fix(annotate): text boxes survive the next gesture; the overlay raster is drawn without annotations
    rm .zen-annotate-text-fields.patch
    git add docs/reviews/handoffs/handoff-to-cli-annotate-text-fields.md
    git commit -m "docs(handoffs): the annotate text-fields prompt, as run"

No TRACKING 🔵 for this one — it is not a numbered row. PROGRESS needs no new entry either:
the patch carries the session-log entry; you will append the gate's numbers and the
production evidence to it in steps 3 and 7.

## 1. Read the diff before you trust it

`git show --stat HEAD~1` and read the full diff of these, in this order:
frontend/src/app/shared/page-overlay/page-overlay.ts (finishEditing, commitEditor, the
four gesture handlers that now call it, the `rasterAnnotations` input, `editingEnded`'s
type), page-overlay.html (`data-item-id` on the textarea), features/workspace/annotate.ts
(editOnPage, onPageEditingEnded(id), undo/redo), annotate.html (the two bindings),
abstraction/annotations.facade.ts (the no-op guard in update()), core/services/
documents.service.ts, features/workspace/edit.ts + edit.html (gate scoping, hint, focus
effect), backend/apps/pdf_engine/engine/render.py (_strip_annotations), and the tests:
page-overlay.spec.ts, annotate.spec.ts (the new "filling in fields" describe),
annotations.facade.spec.ts, test_engine.py, e2e/tests/phase-3.spec.ts. Each change is
small and self-describing; if anything looks wrong after reading the code it lands in,
say so before running anything. Two things to check on purpose: (a) `finishEditing()`
is a no-op in every mode that never sets `editingId` — Edit, Forms, Protect, Sign — so
the new calls in onItemPointerDown / onHandlePointerDown / onTextPointerDown change
nothing there; (b) `render_page(annots=False)` no longer passes `annots=` to
`get_pixmap` — the strip happens on the in-memory copy, and the default path is
untouched.

## 2. The gate, on the restarted stack

    ./infra/up.sh
    ./infra/test.sh --pg --e2e        # test.sh restarts the workers itself since PR #23

Expect, at d10fb5e + this patch: backend green with only the six allowed PG-only skips
and **one more passing test than the last green run** (1164 → 1165 —
`test_render_without_annotations_keeps_the_form_fields`); coverage floors hold; unit
**587 across 66 files**; `ng lint` clean; build + **43 prerendered routes** +
`verify:prerender`; Playwright green — the last three runs were 86 passed / 1 skip
(`phase-11:164`'s isDevServer skip), and this patch changes exactly one spec:
`phase-3 "a text box shows its words on the page, and undo takes them back"` now draws
the second box straight after typing and asserts both texts, the undo order
(`[sentence, '']` then `[sentence, 'Second field']`), and that every overlay raster
request (`/thumbnail/` with `w` > 500) carries `annots=false`. If that spec fails, it is
a real finding about the fix, not a flake — read the failure before touching anything.
If the annotate-autosave 1-in-N flake row fires, re-run that spec in isolation 5× and
record, per its queue row — do not paper over anything else.

## 3. Record the numbers

Append the gate's real numbers (each suite, durations, coverage) to the "2026-08-26 —
Filling in a form with text boxes…" session-log entry under a "**Landed.**" line. Tick
nothing else — the entry's mechanism and fix sections already say what this patch does.

## 4. UI testing via the Chrome MCP tools, on http://localhost:4200

Use backend/tests/fixtures/pdfs/scanned.pdf (a two-page scan with no fields — the same
shape as the owner's form) unless the owner's form is at hand. Both themes, 1280 px and
390 px, console read after each step; screenshot each; one line per finding in PROGRESS.

1. Guest path: /annotate-pdf → drop scanned.pdf → Annotate PDF → the workspace opens in
   Annotate. Click "Text box". Drag a box on a line, type "Yuval Haspel", and — without
   Escape, without clicking anywhere else — drag the next box on the line below and type
   "Tel Aviv"; repeat for "Bank Hapoalim" and "123456". Expect four boxes, each with its
   words, the caret landing in each new box as it is drawn, the comments rail listing all
   four, the badge "4 unsaved". (Before the fix: boxes 2 and 4 vanished as drawn, or on
   Safari the words of 1 and 3 were lost.)
2. Type a Hebrew field: draw a box, type "שלום עולם", draw the next. Expect the Hebrew
   kept in the model, its letters in reading order in the box (the bidi algorithm handles
   a Hebrew run; alignment stays at the start edge — that is existing behaviour, not a
   finding), and after Save the same words in the page image.
3. Save. Expect "Annotations saved", "All changes saved", and **each box drawn exactly
   once** — no bolder twin at a slight offset. Read the network log: the overlay's
   `/thumbnail/?w=…` requests carry `annots=false`; the thumbnail rail's (`w=240`) do not.
4. Select tool → drag a saved box to a new spot. Expect it to move and **leave nothing
   behind**. Undo once: it moves back. Reload the page, re-open Annotate: all five boxes
   present, drawn once.
5. Double-click a box → caret in it; change a word; draw a new box straight away. Expect
   the edit committed and the new box open. Press Escape in the new (empty) box: it is
   removed, the edited one stays.
6. Widgets survive the clean raster: open backend/tests/fixtures/pdfs/form.pdf in
   Annotate. Expect the two form fields still visible on the page image (the clean render
   keeps widgets); draw one text box, Save, confirm the fields are still visible after
   the raster refreshes.
7. Edit screen on scanned.pdf: "Edit text" shows the scanned-page gate ("This page is a
   scan… Run OCR first"); switch to "Add text": the gate is gone, the hint
   `data-test=add-text-hint` reads "Drag a box where the text should go, type, then press
   OK — each box is written into the file as its own version."; draw a box: the editor
   has the caret already; type "Herzl 12" → OK → "Text added" and the words are in the
   page image. Whiteout, Images and Links: no gate either.
8. Measure one thing and file it, do not fix it: in the workspace at a 1919×873 window
   (or your closest), read `document.documentElement.scrollHeight` vs `innerHeight`. The
   owner's Chrome showed **1472 vs 873** with `.ws-panes` 1379 px tall — the *window*
   scrolled instead of the page pane, and a stray space keystroke scrolled the whole
   workspace out of view. If you can reproduce it, add a queue row with the numbers and
   the likely cause (the annotate start rail's content height at that viewport); if you
   cannot, say so in PROGRESS.

## 5. Self-archive

    git mv docs/reviews/handoffs/handoff-to-cli-annotate-text-fields.md \
           docs/archived/$(date +%F)-handoff-to-cli-annotate-text-fields.md

Prepend "**Executed <date> — see PROGRESS.md session log 2026-08-26. Historical.**",
commit (`docs: archive the annotate text-fields handoff`).

## 6. Ship

    git push -u origin fix/annotate-text-fields
    gh pr create --base main --head fix/annotate-text-fields \
      --title "fix(annotate): text boxes survive the next gesture; the overlay raster is drawn without annotations" \
      --body "<What (the two root causes, one paragraph each; the Edit-screen follow-ups) / Verification (the gate's real numbers + the Chrome evidence from step 4) / Risk: frontend overlay + annotate + edit, backend render.py only; no migrations, no deps, no env>"

Self-review with three lenses before merging — *regression*: the overlay is shared by
five modes, so confirm in the code (and by clicking through Forms' field editor,
Protect's redact tab and Sign's placement in step 4's browser) that a mode which never
sets `editingId` is unchanged; confirm phase-4's and phase-6's scanned-gate e2e
assertions still hold (they run in the default "Edit text" mode — the gate is still
there); confirm the e2e `annots=false` assertion filters by `w` > 500 so the rail's
240 px thumbnails are not caught. *Correctness of the backend refinement*: `_strip_
annotations` walks `first_annot`, which excludes widgets — check on form.pdf that
`page.widgets()` still yields two after the strip and that a Popup-bearing Text
annotation (add one with PyMuPDF in a scratch script) does not raise. *Test quality*:
temporarily revert `finishEditing()`'s call in `onPointerDown` and confirm the annotate
spec's "keeps every box and every word…" test fails, then restore it. Fix what is real,
re-run the gate on the final commit, then:

    gh pr merge --merge --delete-branch
    git switch main && git pull --ff-only origin main
    git log --oneline -3 && git status

TRACKING: add a row to the **"Landed outside the programme"** table — What: "**Annotate
text boxes** (`fix/annotate-text-fields`, PR #<n> `<merge sha>`) — the owner-reported
vanishing/doubling text boxes; two root causes in the Phase 3 overlay (a cancelled
pointerdown never blurred the editor; the raster was drawn with the annotations); Edit's
scanned gate scoped to Edit text"; Where: the PROGRESS session-log entry
"2026-08-26 — Filling in a form with text boxes…" and the archived prompt path. Commit
directly on main as `docs(tracking): annotate text-fields landed` and push. Touch no
numbered row.

## 7. Validate on production (this is the deploy — do not skip it)

Wait for Railway: `curl -s https://zenpdf.up.railway.app/ | grep -o 'main-[A-Z0-9]*\.js'`
must no longer be `main-NVCT7IQQ.js`, and `/api/health/` must be ok. Then, in the Chrome
MCP tools on https://zenpdf.up.railway.app, as a guest, repeat step 4's items 1, 3, 4
and 7 with scanned.pdf, plus one Hebrew box — both themes at 1280 px, and the fill-in
flow once at 390 px in the phone workspace (type → draw next box, with the drawer
closed). Also open a *pre-existing* production document if one is at hand: a page saved
before the deploy must now draw its annotations once, not twice (the clean raster is a
new cache key, so the first open renders it fresh — allow a second or two). Console
clean throughout. Append the production evidence to the same PROGRESS entry under a
"**Live.**" line, commit on main as `docs(progress): annotate text-fields verified live`
and push — the last commit of the run.

Report: the gate's numbers, the local and production Chrome evidence, anything the
self-review changed, and confirm what remains open is exactly the two LOW queue rows
the patch filed (the open box in the autosave; Edit's version-per-box) plus whatever
step 4.8 measured. If you find anything beyond that, file it as a queue row; do not
grow this branch.
```
