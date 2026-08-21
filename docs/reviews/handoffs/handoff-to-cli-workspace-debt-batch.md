# Handoff — Workspace debt batch: subscriptions that outlive their panel, thumbnails that hammer a 429, a palette that lies, one odd sentence, and an Undo chain that a 429 can drop (2026-08-21, revision 2 after Phase 12)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `fix/workspace-debt-2026-08`. **Depends on:** `handoff-to-cli-e2e-gate-hardening.md` merged (its `adopt()` change and the node-25 guard touch the same files; without the guard, host-side `ng test` fails on this Mac).
**Source of truth:** `docs/reviews/status-review-2026-08-21.md` (rev 2) §3.1 item 8, §3.2 item 24, §3.3, §5.1 item 3; PROGRESS Human review queue rows of 2026-08-04 ("five remaining workspace panels…", "L9 gives thumbnails a manual retry but no backoff"), the 2026-08-21 report's "smaller observations" (`image_stamp` palette state; "4 of 2 page(s) differ"), and the cursor row the docs-reconciliation prompt adds.
**Deploys on merge?** Yes — frontend.

---

```text
You are paying down five pieces of frontend debt — four the record has carried since
2026-08-04 and re-verified on 2026-08-21 after Phase 12 (which rewrote large parts of the
files you will touch but fixed none of these), and one Phase 12 itself introduced. Read
AGENTS.md, docs/design/design-instructions.md (§3 components — including the new Context
menu spec, §4 workspace, §5 motion/feedback, §6 accessibility — the no-single-character-
shortcut rule, §10 invariants; you will touch the annotate palette, the thumbnail tile and
the workspace bar), development-plans/phase-12-usability-add-ons.md §1 D11 and §4.8 (the
version cursor you are about to harden), docs/reviews/status-review-2026-08-21.md §3, and
the PROGRESS queue rows named above. Frontend state lives in facades (`app/abstraction/`),
components stay presentation-only — keep it that way.

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    git switch -c fix/workspace-debt-2026-08

Open the PROGRESS session-log entry; set the three queue rows to 🔵 (the two of 2026-08-04 and the cursor row).

## 1. Every job subscription dies with its component

Audit, do not assume: `grep -rn "\.subscribe(" frontend/src/app/features frontend/src/app/shared`
and classify each hit (a polling `Observable<Job>` must be piped; a one-shot HTTP call
should be, for consistency). The bare subscriptions at `f34800f`:
`features/workspace/convert.ts:105,116,135,148` (OCR — the longest-running job in the
product — export, download, repair), `annotate.ts:806,827,865,908`, `compare.ts:72,102`,
`protect.ts:231,249,276,429,468`, `sign.ts:143,152,211`, plus the strays L8 missed:
`features/tools/tool-page.ts:261,291,320,491,516,590,606`,
`features/dashboard/dashboard.ts:181,190,201,258,299`, and `workspace.ts`'s autosave on
leave (the `confirmLeave` path — decide deliberately whether that one must survive
destruction, and write the decision down either way). Only `edit.ts`, `forms.ts` and
`workspace.ts` use `takeUntilDestroyed` today.

- Pipe every polling `Observable<Job>` through `takeUntilDestroyed(this.destroyRef)` the
  way `edit.ts:628` and `forms.ts:443` already do; prefer a single `track(job$, …)`
  helper per component (they exist in some — reuse, do not fork).
- Unit tests: for each of the five panels, a spec that destroys the component fixture
  mid-poll and asserts the polling observable was unsubscribed (use a `Subject` stub for
  `JobsFacade.dispatch`/the service and check `observed === false`). One shared helper in
  `frontend/src/app/testing/` is fine.
- A lint guard so it cannot regress: an ESLint rule (the repo uses angular-eslint 22 via
  `frontend/eslint.config.js`) or a unit test that greps `features/**/*.ts` for
  `.subscribe(` outside `takeUntilDestroyed`-piped chains and known exemptions — pick
  the mechanism that produces a readable failure, and document the exemption list.

## 2. Thumbnails back off instead of mashing

`shared/pdf-thumbnail.ts:102–105` sets `failed` on any error; `:132–135` is the manual
retry. `documents.service.ts:220–227 thumbnailBlob` is a plain `http.get`.

- On HTTP 429 (and 503), retry automatically with exponential backoff honouring
  `Retry-After` when present (cap 30 s, max 4 attempts, jitter), keeping the tile in its
  loading state with the contract's `.breath` indicator — not the failed state. Only
  after the attempts are spent does it become `failed` with the existing labelled retry.
  Other statuses (404/423) fail immediately as today.
- Coordinate across a rail: one `ThumbnailScheduler` (in `core/services/`) so a 429 on one
  tile pauses the others for the `Retry-After` window instead of 500 tiles each
  discovering the limit. Keep the visibility-gated loading from phase 10.
- Tests: `pdf-thumbnail.spec.ts` — 429 with `Retry-After: 2` retries after ~2 s (fake
  timers), succeeds; four 429s → failed with retry button; 404 fails at once; the
  scheduler pauses siblings. e2e `phase-10-debt.spec.ts` "thumbnails lazy" test extended:
  with the guest throttle set low via dev env, the rail still fills without a wall of
  retry buttons.
- Contract: §3 already specifies the tile states (loading / loaded / failed with retry);
  if "backing off" needs a distinct visual, amend §3 in the same change (gap rule) — the
  simplest honest answer is that it *is* the loading state.

## 3. The annotate palette shows what is armed

Uploading a custom stamp switches the active tool to `image_stamp` but no palette button
lights up, and there is no way back to it without re-uploading.

- Add an `image_stamp` entry to the palette that is disabled until a stamp exists in the
  session, shows the uploaded image as its icon (24 px, contract §3 tool-button spec —
  read it), carries `aria-pressed` like its siblings, and re-arms the tool when clicked.
  `data-test="tool-image-stamp"` (additive).
- Tests: `annotations.facade.spec.ts` (arming/disarming, stamp ref retained per session);
  a component spec for the palette's pressed state; e2e `phase-3.spec.ts` — upload a
  stamp, assert the palette shows it pressed, place it, switch to select, click the
  palette entry, place a second one.
- Both themes, 1280 and 390 px — the palette wraps; check it still does.

## 4. "4 of 2 page(s) differ"

`features/workspace/compare.*` summary. Make the sentence honest when page counts
differ: e.g. "Compared 2 pages against 4 — 4 pages differ (2 only exist in the other
document), 4 text changes." Keep the existing `data-test` attributes; add a unit test
for the three cases (equal counts, A longer, B longer). Copy in the product's voice
(contract §1).

## 5. The version-Undo/Redo cursor survives a failed revert (Phase 12, D11)

`features/workspace/workspace.ts:447–457 stepVersion()` writes the cursor
`{ ceiling, content, expected: seq + 1 }` **before** dispatching `revert(target)`. If the
revert job fails or is refused — a guest's 429, a `locked` document, a `version_conflict`
— `currentSeq` never reaches `expected`, `canRedoVersion()`/`undoTarget()` treat the
cursor as dead, and the bar silently falls back to "Undo → currentSeq − 1", Redo disabled.
Measured live on 2026-08-21 (status review §3.2 #24): at v5 showing v1 with Redo offering
v2, a throttled Redo left the bar reading *"Undo the last change — back to v4"* / *"Nothing
to redo"*; the next Undo would have reverted to v4 (content v2) — not where the person was.
Fix: keep the previous cursor, commit the new one only in `trackReload` when the revert
job `succeeded` (the e2e-gate-hardening prompt's `adopt()` gives you the new seq right
there), and restore the previous cursor on `failed`/error, with the existing toast saying
why. Tests in `workspace-undo.spec.ts`: a failed Undo leaves Undo/Redo exactly as they were
(titles, disabled states, targets); a failed Redo likewise; a successful one advances as
today (the six existing cases must keep passing unchanged). Both themes unaffected by
construction (no template change) — say so, still screenshot the bar.

## 6. Gate

`npm test`, `npx ng lint`, `npm run build && npm run verify:prerender` (on the host now
that prompt 2 fixed node 25 — if they fail with `getItem`, prompt 2 did not land; stop);
`./infra/test.sh --e2e` on the restarted stack, fully green (63 + your new specs);
data-test parity (additive only: list the additions). Backend untouched — say so.

## 7. UI testing via the Chrome MCP tools

On http://localhost:4200 with the Chrome MCP tools, both themes, 1280 and 390 px,
console read after each step:
1. Open a 60-page document (generate one with the fixture generator or upload
   `large-generated.pdf` from backend/tests/fixtures/pdfs/): scroll the rail fast; no
   retry buttons appear; thumbnails arrive. Then, with `THROTTLE_GUEST` temporarily
   lowered in `infra/.env` (and restored afterwards — do not commit it), confirm tiles
   wait and then fill rather than failing.
2. Annotate: upload a custom stamp → palette shows it pressed → place → select tool →
   click the palette entry → place again → save → reload → both stamps present.
3. Start an OCR on a scan, navigate away mid-job to the dashboard and back: no console
   error, no toast from a dead panel, the job still completes (watch Settings → usage).
4. Compare a 2-page with a 4-page document: read the new summary sentence.
5. The bar: rotate twice, Undo once (bar reads "back to v1" / "Redo — forward to v3"), then
   lower `THROTTLE_GUEST` in `infra/.env` so the next revert 429s (restore afterwards):
   press Redo — the toast explains, and the bar still reads "back to v1" / "forward to v3".
   Press Redo again after the window: it advances.
Screenshot each; one line per finding in PROGRESS. After merge, repeat 2, 4 and 5 (without
the throttle trick) on https://zenpdf.up.railway.app once the deploy is live.

## 8. Record, self-archive, ship

PROGRESS: close the three queue rows ✔ with evidence; Decisions log: the autosave-on-leave
decision, the backoff parameters, the "backing off is loading" contract reading, the
cursor-commit-on-success rule (and amend phase-12's D11 prose in `01-architecture.md`
only if you moved the rule there); amend the design contract wherever you added a
pattern (the `image_stamp` palette entry sits beside Phase 12's *Paste* — follow the §3
tool-button spec and the menu spec's 44 px floor).

    git mv docs/reviews/handoffs/handoff-to-cli-workspace-debt-batch.md docs/archived/$(date +%F)-handoff-to-cli-workspace-debt-batch.md

prepend the "Executed <date>" banner; mark row 3 done in docs/reviews/handoffs/README.md.

Commit in chunks (`fix(workspace): …`, `feat(annotate): the palette shows the armed
stamp`, `fix(thumbnails): …`, `test: …`, `docs(progress): …`); push;
`gh pr create --base main --head fix/workspace-debt-2026-08 --title "fix(workspace): subscriptions, thumbnail backoff, stamp palette state, compare copy, undo cursor on failure" --body "<What / Why / Verification numbers / Contract amendments / Chrome evidence>"`.

Self-review: *regression* (does the scheduler slow a healthy rail? measure time-to-all-
thumbnails before/after on the 60-page doc), *a11y* (the new palette button has a name,
focus ring, ≥44 px target, AA contrast in both themes — run the phase-10 axe spec),
*contract* (every token semantic, no hardcoded colours). Fix, re-run the gate, then
`gh pr merge --merge --delete-branch && git switch main && git pull --ff-only origin main`,
then the production re-check. Revert on `main` if production regresses. Report.
```
