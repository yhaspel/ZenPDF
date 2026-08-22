# Handoff prompts for Claude CLI — written by the 2026-08-21 status review (revision 2)

Each file here is a **one-shot prompt** to paste into `claude` in the repo root on the Mac
(`~/Documents/Claude/Projects/ZenPDF`). They were derived from
`docs/reviews/status-review-2026-08-21.md` §5.1 — the remaining engineering work, as
verified against the code rather than the plan — and **revised after Phase 12 landed**
(PR #20, `ec8a33e`; record `f34800f`). Owner-only items (§5.2: SMTP, the domain, legal
reviews, Railway dashboard actions, viewer eyeballs) are deliberately **not** here.

> **Read before running anything — two facts from 2026-08-21 evening.**
> 1. **The Mac's node is 25.2.1, and a host `ng test` / `npm run build` fails there** (108
>    unit failures, every prerendered route) because node 25 ships a `localStorage` global
>    without `getItem` and `token.service.ts:35` existence-checks it. Production and the
>    containers run node 24 and are fine. Until prompt 2 lands the guard, run every
>    frontend gate **inside the container** (`./infra/test.sh`, which runs lint + unit
>    tests there) or on node 24 (`nvm use 24`). Each prompt's preflight says so.
> 2. **Celery workers do not hot-reload.** `./infra/up.sh` may or may not recreate them
>    after a code change; every prompt restarts them explicitly before testing.

Every prompt follows the same contract:

1. starts from a clean `main`, brings the local stack up and restarts the Celery workers;
2. implements one feature plan with **full test coverage** (unit + backend + e2e where the
   surface allows) and the repo's gate `./infra/test.sh --e2e` (+ `--pg` when the backend
   changes);
3. **UI-tests the result in a real browser through the Chrome MCP tools** (both themes,
   1280 px and 390 px, console clean) and records the evidence in `PROGRESS.md`;
4. obeys `AGENTS.md` — the design contract is law for any UI change (Phase 12 added a
   context-menu spec, per-mode Undo/Redo and a no-single-character-shortcut rule that new
   UI must respect), `data-test` parity, anonymous-first, ownership through
   `principals.py`, Decisions-log rationale;
5. **self-archives and self-tracks**: the prompt file moves to `docs/archived/<date>-<name>.md`
   with an "Executed" banner (the model is `docs/archived/2026-08-21-phase-12-cli-handoff.md`)
   in the same PR as the work, and the prompt's row in `TRACKING.md` goes 🔵 at the start
   and ✅ (PR, merge sha, archived path, PROGRESS anchor) after the merge;
6. commits, pushes, opens the PR, **reviews it autonomously** with independent lenses,
   fixes what is real, merges to `main`, then `git switch main && git pull --ff-only` —
   and, because a push to `main` is the deploy, checks the live site afterwards.

Baselines as of `f34800f`: **396 unit tests / 47 files · 63 e2e tests · backend 1061
passed / 4 skipped on the full stack · 29 prerendered routes · 24 tool pages.**

**Status is tracked in one place: [`TRACKING.md`](TRACKING.md)** — one row per prompt with
the plan items it owns, its branch/PR/merge, where it was archived and where the evidence
is. Each prompt sets its row to 🔵 in its first commit and to ✅ after the merge; this README
carries no status. `development-plans/PROGRESS.md` remains the canonical tracker for phase
status, acceptance evidence, decisions and the Human review queue — the prompts write
there too, and the board points at those entries rather than repeating them.

Run them **one at a time**, in this order — **1 → 2 → 9 → 3 → 4 → 5 → 6 → 7 → 8** (9 is
pulled forward because it depends only on 2, changes no product code and gates launch).
Later ones assume earlier ones are on `main`; never start a prompt while another one's
branch is unmerged:

| # | File | What it lands | Touches prod on merge? |
|---|---|---|---|
| 1 | `handoff-to-cli-docs-reconciliation.md` | Commits the revision-2 review edits, this board and the untracked Phase-12 production audit; reconciles PROGRESS/README/AGENTS/contract/ops docs with reality (incl. the Phase-12 README row and the contract's sanctioned-additions sentence); adds a "Handoff programme" pointer in PROGRESS.md to `TRACKING.md` | No (`docs/**` is outside the Railway watch patterns) |
| 2 | `handoff-to-cli-e2e-gate-hardening.md` | **The node-25 `localStorage` guard first**; page-actually-drew assertion; stale-worker restart in the gate; Gotenberg-skip guard; `@quarantine` exclusion; repo-relative signing cert in tests; the `version_conflict` flake fixed at the source | Yes (frontend + test settings) |
| 3 | `handoff-to-cli-workspace-debt-batch.md` | `takeUntilDestroyed` sweep, thumbnail backoff, `image_stamp` palette state, compare copy, **the version-Undo/Redo cursor committed on success / restored on failure** (found live in rev 2) | Yes (frontend) |
| 4 | `handoff-to-cli-backend-debt-batch.md` | Password-meter race, finalize append notice, `usage_recompute`, account asset sweeper, `--pg` concurrency proof, nginx 503 headers, `NUM_PROXIES` in `infra/railway` + §19 | Yes (backend + nginx) |
| 5 | `handoff-to-cli-phase-11-adsense-review.md` | Phase 11B + 11C (contact, identity, twelve guides, floors, contract amendment); 11A parameterised for the day the domain exists | Yes (frontend) |
| 6 | `handoff-to-cli-mobile-workspace.md` | A designed phone workspace (drawers + bottom bar) replacing the stacked rescue — now including Phase 12's per-mode Undo/Redo and rail lists; contract amended first | Yes (frontend) |
| 7 | `handoff-to-cli-type-aware-eslint.md` | Type-aware linting adopted; the typed `apiError()` helper | Yes (frontend, no behaviour change intended) |
| 8 | `handoff-to-cli-launch-gate-evidence.md` | Lighthouse on the deployed build, three recorded full e2e runs (63 tests), `@smoke` vs production, the p95 number; checklist ticks with evidence | No (docs + `infra/perf`) |
| 9 | `handoff-to-cli-h1-production-seal-proof.md` | Proves the production signing certificate seals (local stack + prod `.p12`), the launch-gating H1 — **run right after 2** | No (docs) |

Done since revision 1 and therefore **not** a prompt: Phase 12 (usability add-ons) —
planned, adversarially reviewed, implemented, gated, merged and verified live on
2026-08-21; its own handoff is archived.

Prompts 2–7 each finish by driving the live site with the Chrome MCP tools after the
Railway deploy completes; if the deploy regresses anything, the prompt's own instructions
say to revert on `main` rather than "fix forward" into a broken production.
