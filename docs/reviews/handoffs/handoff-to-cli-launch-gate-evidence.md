# Handoff — Launch-gate evidence an agent can produce: Lighthouse on the deployed build, three recorded full runs, `@smoke` against production, and the p95 number (2026-08-21, revision 2 after Phase 12)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `docs/launch-gate-evidence`. **Depends on:** `handoff-to-cli-e2e-gate-hardening.md` merged (the page-drew smoke and the worker restart are part of the evidence).
**Source of truth:** `docs/10-launch-checklist.md` "Final" section; PROGRESS Phase-10 `[~]` criteria (Lighthouse, `@full` three runs, p95) and queue rows "Lighthouse on the deployed prod build", "`@full` suite, three consecutive nightly runs", "Load test (`locust`) and p95 budgets", "The p95 number itself"; `docs/ops/release.md`; `infra/perf/README.md`; `docs/reviews/status-review-2026-08-21.md` §2 Phase 10, §5.1 item 8, §5.2.
**Deploys on merge?** No — docs and `infra/perf/` (outside the watch patterns).

---

```text
You are producing the launch-gate evidence that needs a machine, time and the deployed
host but not a human's signature — and recording it where the owner ticks boxes. You
change no product code in this prompt; if you find a defect, file a queue row.

Read: docs/10-launch-checklist.md, docs/ops/release.md, infra/perf/README.md and
locustfile.py, the Phase-10 section of PROGRESS (criteria 2, 4, 6 and their queue rows),
docs/ops/launch-handoff-owner.md items 7–8, docs/reviews/status-review-2026-08-21.md §5.

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    git switch -c docs/launch-gate-evidence
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat

TRACKING: in docs/reviews/handoffs/TRACKING.md set row 8 to
`🔵 in progress — `docs/launch-gate-evidence`, <today>` (Status column) and put the branch name in
the next column; include that edit in your FIRST commit on the branch. Touch no other row.

PROGRESS session-log entry; the four rows → 🔵.

## 1. Lighthouse on the deployed build

    npx lighthouse https://zenpdf.up.railway.app/ --preset=desktop --output=json --output=html --output-path=docs/reviews/evidence/lighthouse-landing-desktop
    npx lighthouse https://zenpdf.up.railway.app/ --form-factor=mobile --output=json --output=html --output-path=docs/reviews/evidence/lighthouse-landing-mobile
    npx lighthouse https://zenpdf.up.railway.app/merge-pdf --preset=desktop ...        # one tool page
    (after the Phase-11 prompt has merged, also one guide)

Paste the four scores (perf / a11y / best-practices / SEO) per page into PROGRESS and the
checklist note. The dashboard run needs an authenticated browser: do it on the LOCAL
stack (`http://localhost:4200/app/dashboard` with a seeded account, `--extra-headers` or
a Chrome profile via the Chrome MCP tools logged in) and label it "local build, not the
host" — do not log into a real account on production. Criterion: ≥ 90 on all four for
landing; report honestly if performance is below (Railway cold starts are a known
factor — say what the trace shows, do not round up). Commit the JSON (not the HTML if
> 1 MB).

## 2. Three consecutive full e2e runs, recorded

On the restarted stack, run `./infra/test.sh --pg --e2e` three times back to back, each
from a fresh `./infra/reset.sh --yes && ./infra/up.sh` (worker restart is now inside
test.sh). Record each run's numbers and duration in PROGRESS. Criterion: three
consecutive fully green runs of the whole suite (63 tests at `f34800f`; the Phase-12 gate
on 2026-08-21 was 63/63 once — that counts as run one only if you re-run from the same
commit; otherwise start at one). If a flake appears, do NOT re-run it away: record it,
reproduce it in isolation 5×, and either fix it (if it is a test bug — in this branch) or
file it with the failure output (if it is product) and say the criterion is not met. The
2026-08-02 row's `phase-3:43` flake should be gone after the e2e-gate-hardening prompt;
if it is not, that prompt's work was incomplete — say so.

Also run `BROWSERS=all ./infra/test.sh --e2e` once (the nightly cross-browser mode) and
record it; failures that are engine-specific get their own queue row.

## 3. `@smoke` against production, properly classified

    cd e2e && BASE_URL=https://zenpdf.up.railway.app npx playwright test --grep @smoke

Classify every failure exactly as docs/ops/railway-handoff-claude-cli.md H2 says: (a)
Mailpit/email-dependent — expected while SMTP is off (name the spec and the Mailpit call
that proves it), or (b) real. The 2026-08-21 run was 4 passed / 2 environmental; with
the new viewer smoke it should be 5 / 2. Re-run the (a) specs against the local stack to
prove the specs are sound. Record in PROGRESS and tick the checklist's "`@smoke` green
against the deployed host" note with the classification (the box itself is the owner's).

## 4. The p95 number

`infra/perf/` is profile-gated and turns throttles off for the run — read its README
before doing anything against production. Run it first on the local stack with a seeded
4-document library (the 3–76 ms shape from 2026-08-02); then, ONLY if `PERF_EMAIL`/an
account on production exists and the owner has confirmed it (ask — do not create an
account on the live service), run the smoke against production at a modest user count
and report the p95 per endpoint against the 150 ms budget. If no production account is
sanctioned, record the local figure and state plainly that the production p95 is still
owed and why.

## 5. Record and self-archive

- PROGRESS: Phase-10 criteria 2 (Lighthouse), 4 (three runs) and 6 (p95) updated from
  `[~]` to whatever the evidence supports — `[x]` only if the criterion's own words are
  met; otherwise `[~]` with the measured numbers and the exact gap. Close or update the
  four queue rows with the evidence. Session-log entry with every command and result.
- docs/10-launch-checklist.md: add dated evidence notes under "Final" (the owner ticks).
- docs/ops/release.md: record that the nightly cadence has now been run once manually
  and what it costs in minutes.
- `docs/reviews/evidence/` holds the Lighthouse JSON and the three run summaries
  (text, not screenshots of terminals).

    git mv docs/reviews/handoffs/handoff-to-cli-launch-gate-evidence.md docs/archived/$(date +%F)-handoff-to-cli-launch-gate-evidence.md

prepend the "Executed <date>" banner.

TRACKING: after the merge and the `git pull --ff-only` below, set row 8 of
docs/reviews/handoffs/TRACKING.md to `✅ merged — PR #<n> (<merge sha>), <date>, archived at
docs/archived/<date>-handoff-to-cli-launch-gate-evidence.md`, fill the PR/merge column, and put the PROGRESS anchor
(your session-log heading and the queue rows you closed) in the Evidence column. Commit that
one edit directly on `main` as `docs(tracking): prompt 8 merged` and push — docs only, no
deploy, the same way `f34800f` recorded Phase 12. This is the last commit of the run — do it
before you report. (The README carries no status; the board does.)

## 6. UI testing via the Chrome MCP tools

Evidence, not features: with the Chrome MCP tools open https://zenpdf.up.railway.app/ at
1280 and 390 px in both themes and capture what Lighthouse measured — the first-paint
screenshot, the console (zero errors), and the network panel's bundle sizes; then open
the landing Lighthouse HTML report from `docs/reviews/evidence/` in a tab and screenshot
the score ring so the PR carries it. Record in PROGRESS.

## 7. Ship

    git add -A && git status
    git commit -m "docs(launch): Lighthouse, three recorded full runs, @smoke vs production, the p95 shape"
    git push -u origin docs/launch-gate-evidence
    gh pr create --base main --head docs/launch-gate-evidence --title "docs(launch): gate evidence — Lighthouse, three full runs, @smoke vs production, p95" --body "<Scores / Run table / Smoke classification / p95 and what is still owed / Chrome screenshots>"

Self-review: *honesty* — every `[x]` you wrote is met by the criterion's literal words;
every `[~]` names the gap; no number rounded. `gh pr merge --merge --delete-branch &&
git switch main && git pull --ff-only origin main`. Report, ending with the exact list of
checklist boxes the owner can now tick with evidence, and the ones that remain theirs
(domain, mail, legal, certificate decision, restore and recycle drills, screen reader,
real phone, tag).
```
