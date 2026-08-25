# Handoff — Land the post-programme review's findings (2026-08-25)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** the patch carries its own — you apply it onto a fresh `fix/post-programme-review`.
**Depends on:** nothing — the programme (rows 1–9) is complete; this is row 10, the last one.
**What lands:** `.zen-post-programme-review.patch` (repo root on this Mac, sha256 `ea0eea47…`), two commits authored in the review sandbox and proven to `git am` cleanly onto `22ecb16`:

1. `fix: the five things the post-programme review found` — `infra/test.sh` skip-guard: the failure message expanded unbound `${ALLOWED_SKIP_FILE}` (diagnostics died under `set -u`) and `count_skips` counted `SKIPPED` lines while pytest `-rs` groups them (`[8]` read as 1); now the right variable and a summed count, with the self-test transcripts extended to pin both. `ViewerFacade.adopt()` gains a `result.document_id` identity check so a late save for the document you just left cannot stamp its seq onto the newcomer (+ spec). The guide and tool pages remove their JSON-LD `<script>` from `document.head` on destroy so client-side navigation stops leaking structured data across pages (+ spec; prerendered HTML was never affected). The compare toast pluralises properly. `ThumbnailScheduler.reset()`'s comment now states the deliberate per-principal behaviour instead of describing a caller that does not exist.
2. `docs: the post-programme review's record` — the PROGRESS session-log entry "2026-08-25 — Post-programme adversarial review" (verdict + evidence), a new LOW queue row (ws-drawer effect ordering, unreachable via UI), the corrected page-drew resolution pointer, TRACKING's programme-complete note + row 10 + the example-collision fix, the status review's Revision-3 note, and the honest `playwright.config.ts` header.

**Verified in the sandbox before delivery:** the patch applies with `git am` onto pristine `22ecb16`; with it, `ng test` **578 passed / 66 files** (2 new), `ng lint` clean, `npm run build` → **43 prerendered routes**, `verify:prerender` green, `bash -n infra/test.sh` clean and the new counter returns 16 for a transcript with `[8]`-grouped skips. Backend untouched.

**Deploys on merge?** Yes — `frontend/**` rebuilds `web`. No backend code, no migrations, no dependencies, no env changes.

Paste everything in the block below into `claude`.

---

```text
You are landing the post-programme review's findings: a prepared two-commit patch, the
repo's full gate, browser verification, PR, self-review, merge, and the tracking record.
Read AGENTS.md first, then the PROGRESS session-log entry "2026-08-25 — Post-programme
adversarial review" (it is the record of what this patch does and why), then
docs/reviews/handoffs/TRACKING.md (row 10 is you).

## 0. Preflight and apply

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain            # must be clean apart from the two delivered files:
                                      #   .zen-post-programme-review.patch  (repo root)
                                      #   docs/reviews/handoffs/handoff-to-cli-post-programme-review.md
                                      # if anything ELSE shows, stop and tell me
    shasum -a 256 .zen-post-programme-review.patch   # must start ea0eea47
    git switch main && git pull --ff-only origin main
    git log --oneline -1              # if main has moved past 22ecb16, git am --3way below;
                                      # on any conflict: git am --abort, stop, tell me — the patch is regenerable
    git switch -c fix/post-programme-review
    git am --3way .zen-post-programme-review.patch
    git log --oneline -2              # the two commits, exactly as titled above
    rm .zen-post-programme-review.patch
    git add -f docs/reviews/handoffs/handoff-to-cli-post-programme-review.md
    git commit -m "docs(handoffs): the row-10 prompt, as run"

TRACKING: set row 10 to `🔵 in progress — `fix/post-programme-review`, <today>`, amend
into that last commit (`git add docs/reviews/handoffs/TRACKING.md && git commit --amend
--no-edit`). Touch no other row. PROGRESS needs no 🔵 — the patch already carries the
session-log entry; you will append the gate's numbers to it in step 3.

## 1. Read the diff before you trust it

`git show --stat` both patch commits and read the full diff of `infra/test.sh`,
`viewer.facade.ts`, `guide-page.ts`, `tool-page.ts`, `compare.ts`. Each change is small
and self-describing; if anything looks wrong after reading the code it lands in, say so
before running anything.

## 2. The gate, on the restarted stack

    ./infra/up.sh
    ./infra/test.sh --pg --e2e        # test.sh restarts the workers itself since PR #23

Expect, at 22ecb16 + this patch: the skip-guard self-test passes (it now checks the
summed counter); backend green with only the six allowed PG-only skips (the guard now
also proves Gotenberg-dependent tests ran — if it refuses, fix the environment, never
the guard); coverage floors hold; unit **578 across 66 files**; `ng lint` clean; build +
**43 prerendered routes** + `verify:prerender`; Playwright fully green (the suite was 86
passed / 1 deliberate webkit skip on the three 2026-08-25 runs — yours should match ±
this patch's zero e2e changes). If the annotate-autosave 1-in-N flake row fires, re-run
that spec in isolation 5× and record, per its queue row — do not paper over anything
else.

## 3. Record the numbers

Append the gate's real numbers (each suite, durations, coverage) to the "2026-08-25 —
Post-programme adversarial review" session-log entry under a "**Landed (row 10).**"
line, and tick nothing else — the entry's findings list already says what this patch
does.

## 4. UI testing via the Chrome MCP tools

On http://localhost:4200 (both themes, 1280 px and 390 px, console read after each):
1. Compare a 2-page with a 4-page document → the toast says "N pages differ" (plural
   correct; "1 page differs" when you compare near-identical fixtures).
2. Open /guides/how-to-merge-pdf-files, then navigate client-side to /merge-pdf and read
   `document.head`: exactly one JSON-LD script (`zen-tool-jsonld`), no `zen-guide-jsonld`
   residue; navigate to /app… and confirm both are gone.
3. Open a document, run a rotate, and while its toast is still up open a second document
   from the dashboard: the second document's version chip never flashes the first one's
   seq (the adopt guard); no console errors.
4. Screenshot each; one line per finding in PROGRESS.

After merge (step 6), on https://zenpdf.up.railway.app once the `web` deploy is live:
repeat 2 (the JSON-LD residue check) and confirm `/api/health/` is ok and the bundle
name changed.

## 5. Self-archive

    git mv docs/reviews/handoffs/handoff-to-cli-post-programme-review.md \
           docs/archived/$(date +%F)-handoff-to-cli-post-programme-review.md

Prepend "**Executed <date> — see PROGRESS.md session log 2026-08-25. Historical.**",
commit (`docs: archive the row-10 handoff`).

## 6. Ship

    git push -u origin fix/post-programme-review
    gh pr create --base main --head fix/post-programme-review \
      --title "fix: the five findings of the post-programme review, and its record" \
      --body "<What (the five findings, one line each) / Verification (the gate's real numbers + the Chrome evidence) / Risk: frontend + test.sh, no backend, no migrations>"

Self-review with two lenses before merging — *regression* (read the adopt guard against
the Phase-12 version cursor in workspace.ts: a revert's job result names the same
document, so the cursor path must be unaffected — the existing workspace-undo suite
proves it, confirm it ran; and the JSON-LD removal must not run during prerender teardown
in a way that breaks the build — the 43-route build above proves it) and *test-quality*
(temporarily reintroduce the unbound variable locally and confirm the self-test catches
nothing but the real run's failure path now prints the skip list — then revert that
experiment). Fix what is real, re-run the gate on the final commit, then:

    gh pr merge --merge --delete-branch
    git switch main && git pull --ff-only origin main
    git log --oneline -3 && git status

TRACKING: set row 10 to `✅ merged — PR #<n> (<merge sha>), <date>, archived at
docs/archived/<date>-handoff-to-cli-post-programme-review.md`, evidence = the PROGRESS
entry; commit directly on main as `docs(tracking): prompt 10 merged` and push — the
last commit of the run. Then the production re-check from step 4.

Report: the gate's numbers, the Chrome evidence, anything the self-review changed, and
confirm what remains open is exactly what the review said — the owner checklist
judgements, the production p95, the literal three-nightly-runs reading, the two
characterised e2e rows, and the two product questions (`/MK /R` widget rotation, the
trash-promise decision). If you find anything beyond that, file it as a queue row; do
not grow this branch.
```
