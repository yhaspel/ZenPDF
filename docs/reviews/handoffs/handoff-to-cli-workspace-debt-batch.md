# Handoff — Workspace debt batch: subscriptions that outlive their panel, thumbnails that hammer a 429, a palette that lies, and one odd sentence (2026-08-21)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `fix/workspace-debt-2026-08`. **Depends on:** `handoff-to-cli-e2e-gate-hardening.md` merged (its `adopt()` change touches the same workspace files).
**Source of truth:** `docs/reviews/status-review-2026-08-21.md` §3.1 item 8, §3.3, §5.1 item 3; PROGRESS Human review queue rows of 2026-08-04 ("five remaining workspace panels…", "L9 gives thumbnails a manual retry but no backoff") and the 2026-08-21 report's "smaller observations" (`image_stamp` palette state; "4 of 2 page(s) differ").
**Deploys on merge?** Yes — frontend.

---

```text
You are paying down four pieces of frontend debt the record has carried since 2026-08-04,
verified as still present on 2026-08-21. Read AGENTS.md, docs/design/design-instructions.md
(§3 components, §4 workspace, §5 motion/feedback, §10 invariants — you will touch the
annotate palette and the thumbnail tile), docs/reviews/status-review-2026-08-21.md §3, and
the two PROGRESS queue rows named above. Frontend state lives in facades
(`app/abstraction/`), components stay presentation-only — keep it that way.

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    git switch -c fix/workspace-debt-2026-08

Open the PROGRESS session-log entry; set the two queue rows to 🔵.

## 1. Every job subscription dies with its component

Audit, do not assume: `grep -rn "\.subscribe(" frontend/src/app/features frontend/src/app/shared`
and classify each hit. The known bare job subscriptions:
`features/workspace/convert.ts:105,116,148` (OCR — the longest-running job in the
product — export, repair), `annotate.ts:604,642,685`, `compare.ts:102`,
`protect.ts:188,206,233,353,392`, `sign.ts:141`, plus the strays L8 missed:
`features/tools/tool-page.ts:320`, `features/dashboard/dashboard.ts:181,190,201`, and
`workspace.ts:637` (the autosave on leave — decide deliberately whether that one must
survive destruction, and write the decision down either way).

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

## 5. Gate

`npm test`, `npx ng lint`, `npm run build && npm run verify:prerender`;
`./infra/test.sh --e2e` on the restarted stack, fully green; data-test parity (additive
only: list the additions). Backend untouched — say so.

## 6. UI testing via the Chrome MCP tools

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
Screenshot each; one line per finding in PROGRESS.

After merge, repeat 2 and 4 on https://zenpdf.up.railway.app once the deploy is live.

## 7. Record, self-archive, ship

PROGRESS: close the two queue rows ✔ with evidence; Decisions log: the `workspace.ts:637`
decision, the backoff parameters, the "backing off is loading" contract reading; amend
the design contract wherever you added a pattern.

    git mv docs/reviews/handoffs/handoff-to-cli-workspace-debt-batch.md docs/archived/$(date +%F)-handoff-to-cli-workspace-debt-batch.md

prepend the "Executed <date>" banner; mark row 3 done in docs/reviews/handoffs/README.md.

Commit in chunks (`fix(workspace): …`, `feat(annotate): the palette shows the armed
stamp`, `fix(thumbnails): …`, `test: …`, `docs(progress): …`); push;
`gh pr create --base main --head fix/workspace-debt-2026-08 --title "fix(workspace): subscriptions, thumbnail backoff, stamp palette state, compare copy" --body "<What / Why / Verification numbers / Contract amendments / Chrome evidence>"`.

Self-review: *regression* (does the scheduler slow a healthy rail? measure time-to-all-
thumbnails before/after on the 60-page doc), *a11y* (the new palette button has a name,
focus ring, ≥44 px target, AA contrast in both themes — run the phase-10 axe spec),
*contract* (every token semantic, no hardcoded colours). Fix, re-run the gate, then
`gh pr merge --merge --delete-branch && git switch main && git pull --ff-only origin main`,
then the production re-check. Revert on `main` if production regresses. Report.
```
