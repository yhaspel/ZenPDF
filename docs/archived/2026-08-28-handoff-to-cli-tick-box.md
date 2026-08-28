**Executed 2026-08-28 — see PROGRESS.md session log "2026-08-28 — The Tick box tool", and `docs/reviews/evidence/tick-box/` for the browser pass. The working tree arrived exactly as this prompt described it — the eight files and `.stage/`, nothing else — and the eight were shipped unchanged: no product code was edited by the executing session. The gate was green end to end on the first run: backend **1166 passed / 6 skipped**, coverage apps 91.55 % / pdf_engine 91.88 %, ruff + mypy clean, `ng lint` clean, unit **602 passed / 67 files**, build **43 prerendered routes** + `verify:prerender`, Playwright **87 passed / 1 skipped** — and the new `phase 3: tick box places the chosen mark with one click`, which this prompt correctly flagged as never having run anywhere, **passed on its first execution**, no selector slip. Browser evidence as a guest in both themes at 1280 and 390 with zero console errors: four marks placed, saved, reloaded out of the file, drawn by pdf.js from the real PDF, and surviving Flatten as page artwork with the rail emptied. **One correction the browser forced**, and the only change beyond the eight files besides the record: §3 "Tick box" claimed the page bar wraps "below `md`" — it wraps on the desk too, and it is a question about the pane, not the breakpoint (816 px of pane at a 1280 px window: 53 → 97 px armed; 976 and 1136 stay one row). The contract now carries the measurement. The self-review's four lenses — geometry, the `loadWords` trigger, template a11y, contract conformance — found nothing else real. Historical.**

# Handoff to Claude CLI — ship the Tick box tool (annotate)

**Written 2026-08-28 by the Cowork session that implemented the feature.** Paste this
prompt into `claude` in the repo root (`~/Documents/Claude/Projects/ZenPDF`). It follows
the contract in `docs/reviews/handoffs/README.md` and owns **row 11** in `TRACKING.md`.

---

## What this is

The owner's change request of 2026-08-28: an annotate **Tick box** tool that ticks a
printed form's checkboxes — one click places a **✓ checkmark (the default), − dash, or
✗ cross**, chosen from a mark selector in the annotate page bar (where Undo/Redo are).

**The feature is already implemented, in the working tree, uncommitted** — the Cowork
sandbox cannot push (git proxy 403), and git must never run through its device bridge
(strands `.git/index.lock`). Your job: verify, gate, commit, push, PR, self-review,
merge, then verify in production. You are the first `git` this change meets.

## Design decision you are inheriting (do not re-derive)

A tick is saved as a **plain `ink` annotation** (multi-stroke; ✓ = one 3-point stroke,
− = one 2-point stroke, ✗ = two strokes) in a **14 pt square in page points**, centred
on the click, clamped at page edges, `clamp01`-rounded. Deliberately **not** a `free_text`
glyph: no font-coverage dependency, renders identically in overlay and file, and the
placed mark selects/drags/resizes/copies/deletes like any drawing. **Zero backend
changes** — schema (`ink` strokes `minItems: 1`), engine (`add_ink_annot`) and extraction
already handle it; this was verified against the running local stack, not assumed.
The mark selection is remembered for the session (like family colours); a fresh
Annotate starts at ✓. The tool stays armed after each click (*click, click, click*).

## The working tree (verify with `git status` — expect exactly these 8, no more)

1. `frontend/src/app/features/workspace/annotate.ts` — `AnnotateTool` + `'tick'`;
   `GESTURE.tick = 'point'`; `TickMark`/`TICK_STROKES`/`TICK_SIZE_PT`; `tickMark`
   signal; the words-loading effect now also fires for `'tick'` (real page size in
   points, same reason as `free_text`); `onCreated` tick branch; `tickAnnotation()`.
2. `frontend/src/app/features/workspace/annotate.html` — palette entry `tool-tick`
   (after Text box, §3 tool-palette-button pattern); rail hint `tick-hint`; page-bar
   `.seg` mark selector `tick-marks` / `tick-mark-check|dash|cross` (aria-pressed,
   glyphs aria-hidden, rendered only while armed, outside the `.ws-hoisted` span so
   it stays in the bar at every width).
3. `frontend/src/app/features/workspace/annotate-tick.spec.ts` — **new**, 9 tests
   (default ✓, stroke shapes, 14 pt geometry, corner clamp, ink-family styling,
   stays-armed, undo, session memory, selector-only-while-armed).
4. `frontend/src/app/features/workspace/annotate.spec.ts` — palette-parity count
   17 → 18 (one line).
5. `e2e/tests/phase-3.spec.ts` — `clickOnPage` helper + new test
   `phase 3: tick box places the chosen mark with one click`.
6. `docs/design/design-instructions.md` — grounding-list bullet (2026-08-28); §3 tabs
   usage line; **new §3 "Tick box (Annotate)"**; §3 Phone workspace palette count
   seventeen → eighteen; §4 Annotate line; §11 log row — which **also reattaches the
   three stranded 2026-08-26 rows** (the diff shows three blank-line removals; that is
   the register's own requested fix, not noise).
7. `docs/reviews/handoffs/handoff-to-cli-tick-box.md` — this prompt.
8. `docs/reviews/handoffs/TRACKING.md` — row 11 (set it 🔵 in your first commit).

Also present: `.stage/` in the repo root (snapshot debris the bridge cannot delete) —
`rm -rf .stage` in your first commit's housekeeping; it is untracked and gitignored.

## Already verified (evidence, not claims — spot-check 1–2, then trust)

- **Live, owner's Chrome, dev stack at :4200 (2026-08-28 ~13:10–13:20 IDT):** guest
  upload → annotate; palette entry arms; selector appears with ✓ preselected; placed
  ✓✓−✗ at click points at the right size; comments rows appear ("ink"); undo/redo;
  **Save succeeded and a reload restored all marks from the file**; **View mode
  (pdf.js, an independent renderer) drew the saved marks from the real PDF**;
  Select-drag moved a ✗ (ink transform) and undo restored it; **both themes**, and —
  because the owner's Chrome is Hebrew-locale — **the mirrored `dir=rtl` workspace
  too**; console clean across a full page load. Scratch guest doc; auto-deletes.
- **Cowork sandbox, on this exact tree:** `ng test` **602/602, 67 files** (was 593/66 —
  the 9 new tests pass and nothing else moved); `ng lint` clean (type-aware);
  production build + **43 prerendered routes** + `verify:prerender` green.

**Not yet executed anywhere: the new e2e test** (needs the full local stack). Assume
it may have a selector slip until `--e2e` proves otherwise; fix it there, not by
weakening assertions.

## Do, in order

1. **Preflight.** `git status` — confirm the 8 files above and nothing else. Read
   `AGENTS.md` and the contract's new §3 "Tick box" section. Bring the stack up
   (`./infra/up.sh`); backend is untouched, so no worker concerns beyond the README's
   standard restart-before-gate rule.
2. **Branch + commit.** `git switch -c feat/annotate-tick-box`; set TRACKING row 11
   🔵 and remove `.stage/` in the same commit. Suggested message:
   `feat(annotate): tick box tool — ✓/−/✗ marks placed as ink (contract §3 Tick box)`.
3. **Gate.** `./infra/test.sh --e2e` (no `--pg` — no backend change). Expect unit
   602 + your e2e run to include the new phase-3 test. Investigate any e2e failure in
   the new test first (selectors/timing), then the suite's known flakes (see the
   queue rows) before suspecting the feature.
4. **Browser evidence, per the README contract:** both themes, **1280 px and 390 px**,
   console clean, screenshots into `docs/reviews/evidence/tick-box/` with a README
   index. At 390: the selector stays in the (wrapped) page bar, Undo/Redo live in the
   bottom bar, the palette drawer shows Tick box + hint. Also check one placed mark
   survives **Flatten** (it becomes page content, sidebar empties — ink baking).
5. **Record.** PROGRESS.md session-log entry (what landed, the gate numbers, the
   evidence path). Amend anything you had to change beyond the 8 files, honestly.
6. **Ship.** Commit, push, open the PR, **review it autonomously with independent
   lenses** (the 2026-08-26 episode's self-review caught a real regression — take it
   seriously: geometry math, the `loadWords` effect's extra trigger, template a11y,
   contract conformance), fix what is real, merge to `main`,
   `git switch main && git pull --ff-only`.
7. **Production** (push to main auto-deploys Railway): wait for the deploy, confirm
   the served `main-*.js` hash changed, then as a guest on https://zenpdf.up.railway.app
   upload a PDF → Annotate → place ✓, − and ✗ → Save → reload → View mode shows them.
   Console clean. If anything regressed, **revert on `main`** rather than fixing
   forward into broken production.
8. **Close out.** Move this file to `docs/archived/2026-08-28-handoff-to-cli-tick-box.md`
   with an "Executed" banner (in the PR, per the README); TRACKING row 11 → ✅ with PR,
   sha, archived path and PROGRESS anchor, as a `docs(tracking)` commit on `main`.

## Owner-only items

None. Nothing here touches SMTP, the domain, certificates or Railway settings.

## Constraints (from AGENTS.md / the contract — the diff already respects them; keep it so)

Semantic tokens only; both themes; `data-test` additions only (`tool-tick`, `tick-hint`,
`tick-marks`, `tick-mark-check|dash|cross` — nothing removed or renamed); aria-pressed
(never aria-selected); anonymous-first untouched; no new routes, slugs, copy invariants
or ads surfaces; the contract amendment is part of this change and ships with it.
