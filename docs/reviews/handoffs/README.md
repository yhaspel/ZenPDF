# Handoff prompts for Claude CLI — written by the 2026-08-21 status review

Each file here is a **one-shot prompt** to paste into `claude` in the repo root on the Mac
(`~/Documents/Claude/Projects/ZenPDF`). They were derived from
`docs/reviews/status-review-2026-08-21.md` §5.1 — the remaining engineering work, as
verified against the code rather than the plan. Owner-only items (§5.2: SMTP, the domain,
legal reviews, Railway dashboard actions, viewer eyeballs) are deliberately **not** here.

Every prompt follows the same contract:

1. starts from a clean `main`, brings the local stack up and **restarts the Celery
   workers** (they do not hot-reload — the 2026-08-21 stale-worker finding);
2. implements one feature plan with **full test coverage** (unit + backend + e2e where the
   surface allows) and the repo's gate `./infra/test.sh --e2e` (+ `--pg` when the backend
   changes);
3. **UI-tests the result in a real browser through the Chrome MCP tools** (both themes,
   1280 px and 390 px, console clean) and records the evidence in `PROGRESS.md`;
4. obeys `AGENTS.md` — the design contract is law for any UI change, `data-test`
   parity, anonymous-first, ownership through `principals.py`, Decisions-log rationale;
5. **self-archives**: the prompt file moves to `docs/archived/<date>-<name>.md` with an
   "Executed" banner, in the same PR as the work;
6. commits, pushes, opens the PR, **reviews it autonomously** with independent lenses,
   fixes what is real, merges to `main`, then `git switch main && git pull --ff-only` —
   and, because a push to `main` is the deploy, checks the live site afterwards.

Run them **one at a time**, in this order (later ones assume earlier ones are on `main`):

| # | File | What it lands | Touches prod on merge? |
|---|---|---|---|
| 1 | `handoff-to-cli-docs-reconciliation.md` | Commits the `docs/review`→`docs/reviews` rename + this review; reconciles PROGRESS/README/AGENTS/ops docs with reality | No (`docs/**` is outside the Railway watch patterns) |
| 2 | `handoff-to-cli-e2e-gate-hardening.md` | Page-actually-drew assertion; stale-worker restart in the gate; Gotenberg-skip guard; `@quarantine` exclusion; repo-relative signing cert in tests; the `version_conflict` flake fixed at the source | Yes (frontend) |
| 3 | `handoff-to-cli-workspace-debt-batch.md` | `takeUntilDestroyed` sweep, thumbnail backoff, `image_stamp` palette state, compare copy | Yes (frontend) |
| 4 | `handoff-to-cli-backend-debt-batch.md` | Password-meter race, finalize append notice, `usage_recompute`, account asset sweeper, `--pg` concurrency proof, nginx 503 headers, `NUM_PROXIES` in `infra/railway` + §19 | Yes (backend + nginx) |
| 5 | `handoff-to-cli-phase-11-adsense-review.md` | Phase 11B + 11C (contact, identity, twelve guides, floors, contract amendment); 11A parameterised for the day the domain exists | Yes (frontend) |
| 6 | `handoff-to-cli-mobile-workspace.md` | A designed phone workspace (drawers + bottom bar) replacing the stacked rescue; contract amended first | Yes (frontend) |
| 7 | `handoff-to-cli-type-aware-eslint.md` | Type-aware linting adopted; the typed `apiError()` helper | Yes (frontend, no behaviour change intended) |
| 8 | `handoff-to-cli-launch-gate-evidence.md` | Lighthouse on the deployed build, three recorded full e2e runs, `@smoke` vs production, the p95 number; checklist ticks with evidence | No (docs + `infra/perf`) |
| 9 | `handoff-to-cli-h1-production-seal-proof.md` | Proves the production signing certificate seals (local stack + prod `.p12`), the launch-gating H1 | No (docs) |

Prompts 2–7 each finish by driving the live site with the Chrome MCP tools after the
Railway deploy completes; if the deploy regresses anything, the prompt's own instructions
say to revert on `main` rather than "fix forward" into a broken production.
