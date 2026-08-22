# Handoff programme — tracking board

**What this file is.** The single status record for the nine Claude CLI prompts written by the
2026-08-21 status review (`docs/reviews/status-review-2026-08-21.md`). It answers three
questions in one table: *which plan items does each prompt own*, *where does each prompt
stand*, and *where is the evidence*.

**What it is not.** `development-plans/PROGRESS.md` stays the canonical execution tracker —
phase status, acceptance evidence, the Decisions log and the Human review queue live there
and nowhere else. This board never restates that evidence; it points at it. The two do not
compete: PROGRESS says what is true of the product; this board says what each prompt is
doing about it.

**Rules (every prompt follows them; the prompts' own text says so):**

1. A prompt updates **its own row only**, twice: `🔵` in its first commit on the branch;
   `✅` after the merge, in one small `docs(tracking): …` commit made directly on `main`
   and pushed (docs only — `docs/**` never deploys). Never another prompt's row.
2. The row carries the branch, the PR number and merge sha, the archived prompt path, and
   the PROGRESS anchor (section heading or queue-row date + title) where the evidence is.
3. A prompt that stops early sets `⛔` with what remains, so the next session does not
   re-derive it.
4. If a prompt's "Related plan items" column turns out to be wrong while executing, fix
   the column in the same commit — the column is the contract for what "done" means.

**Status values:** ⬜ not started · 🔵 in progress — `<branch>`, `<date>` · ✅ merged — PR #n
(`<sha>`), `<date>`, archived at `<path>` · ⛔ stopped — `<reason>`, remaining: `<items>`

## Recommended order

1 → 2 → **9** → 3 → 4 → 5 → 6 → 7 → 8. Prompt 9 (the H1 seal proof) depends only on 2, changes
no product code and gates launch, so it is pulled forward. 3 and 4 are frontend and backend
respectively and *could* run in parallel on two branches, but both edit `PROGRESS.md` and
share the one local stack — run them one after the other. Never start a prompt while another
one's branch is unmerged.

## The board

| # | Prompt | Related plan items it owns (PROGRESS anchors unless stated) | Status | Branch · PR / merge · archived at | Evidence |
|---|---|---|---|---|---|
| 1 | `handoff-to-cli-docs-reconciliation.md` | Status review §3.1 items 1–10, 19–23 and §3.2 11–18 (record-only fixes); `development-plans/README.md` status line + Phase-12 row; phase docs 00–09/12 executed footers; prompts 1/2b/3 banners; `01-architecture.md` §2/§4/§17/§19; design contract grounding (:5/:314) + amendment log; `docs/ops/*` Railway-ization + H2/H3 closure; QA report / remediation prompt historical banners; `10-launch-checklist.md` evidence notes; `user-guide.md` guest caps; **commits the untracked `2026-08-21-phase-12-production-audit.md`**; adds the queue rows for §3.2 #11–14 and #24 | 🔵 in progress — `docs/reconcile-2026-08-21`, 2026-08-22 | `docs/reconcile-2026-08-21` | — |
| 2 | `handoff-to-cli-e2e-gate-hardening.md` | Queue rows: "`typeof localStorage === 'undefined'` is no longer a safe test" (2026-08-21); "Nothing still asserts that a page actually drew" (2026-08-20); "The e2e suite can silently test stale backend code" (2026-08-21); "A stale `base_version_seq` after every save" (2026-08-02); "The suites are memory-sensitive… `phase-3`/`phase-4`" (2026-08-02); review §3.2 #13 (esign cert path) and #14 (gate passes with Gotenberg skipped); Phase 10 §10.5 `@quarantine`; `01-architecture.md` §18 amendment | ⬜ | — | — |
| 3 | `handoff-to-cli-workspace-debt-batch.md` | Queue rows: "The five remaining workspace panels' job subscriptions…" (2026-08-04, widened to the strays in `tool-page.ts`/`dashboard.ts`); "L9 gives thumbnails a manual retry but no backoff" (2026-08-04); the version-Undo/Redo-cursor row added by prompt 1 (review §3.2 #24); the 2026-08-21 report's `image_stamp` palette and "4 of 2 page(s) differ" observations; Phase 12 D11 hardening | ⬜ | — | — |
| 4 | `handoff-to-cli-backend-debt-batch.md` | Queue rows: "`record_password_failure`'s incr-then-set fallback" (2026-08-04); "The concurrency-slot race is closed on Postgres and unprovable on SQLite" (2026-08-04); "`usage_recompute` has never existed" (2026-08-02); "A completed signature can silently fail to land on the source document" (2026-08-02); "Account-side cleanup of `uploads/…` image assets" (2026-08-01); "A document under a signature request outlives the 30-day trash promise" (2026-08-02, the UI half); `NUM_PROXIES` and `@api_unavailable` rows added by prompt 1 (review §3.2 #11–12); `01-architecture.md` §9/§15/§19 | ⬜ | — | — |
| 5 | `handoff-to-cli-phase-11-adsense-review.md` | **Phase 11** status-table row (→ 🔵/🟠 "awaiting owner: domain", never ✅ from this prompt); `phase-11-adsense-review.md` 11B, 11C, the floors, the tool-page top-up, 11A parameterised; design contract at four sites; `01-architecture.md` §21.6; `docs/09-adsense-readiness.md` content item; `docs/ops/domain-cutover.md` (new) | ⬜ | — | — |
| 6 | `handoff-to-cli-mobile-workspace.md` | Queue row "The workspace on a phone is stacked, not designed" (2026-08-20); design contract §3/§4 phone-workspace spec (new); Phase 12 D8 rail-reachability on touch | ⬜ | — | — |
| 7 | `handoff-to-cli-type-aware-eslint.md` | Queue row "Type-aware ESLint" (2026-08-02); Decisions-log follow-through of "Type-aware ESLint is deliberately not in this change" (2026-08-02); `01-architecture.md` §18 CI note | ⬜ | — | — |
| 8 | `handoff-to-cli-launch-gate-evidence.md` | Phase 10 acceptance criteria 2 (Lighthouse), 4 (three consecutive full runs), 6 (p95) — `[~]` → evidenced; queue rows "Lighthouse on the deployed prod build", "`@full` suite, three consecutive nightly runs", "Load test (`locust`) and p95 budgets", "The p95 number itself" (all 2026-08-02); `docs/10-launch-checklist.md` "Final" evidence notes; `docs/ops/release.md` | ⬜ | — | — |
| 9 | `handoff-to-cli-h1-production-seal-proof.md` | **GATE** queue row "Production signing certificate" (2026-08-02); `docs/ops/railway-handoff-claude-cli.md` H1; `docs/10-launch-checklist.md` "Signing" (certificate + `TSA_URL` evidence notes); Phase 8 criterion "Completed PDF opens in any validator…" on the production certificate | ⬜ | — | — |

## Landed before the programme (for orientation — not tracked here)

| What | Where it is recorded |
|---|---|
| UI audit (PRs #17, #18, `dacf623`) — cache-control middleware, viewer `.mjs`/CSP, text box, version Undo | PROGRESS session log 2026-08-20/21 |
| Follow-ups (PR #19, `df6afb9`) — pane toolbars wrap, `/organize-pdf` lands on the grid | PROGRESS session log 2026-08-21 (evening) |
| Status review revision 1 (`f8743ac`) | `docs/reviews/status-review-2026-08-21.md` |
| **Phase 12** — usability add-ons (PR #20, `ec8a33e`; record `f34800f`) | PROGRESS §Phase 12 + session log; `docs/archived/2026-08-21-phase-12-cli-handoff.md`; `docs/reviews/2026-08-21-phase-12-production-audit.md` |

## Owner-only items (not prompts)

Listed in `docs/reviews/status-review-2026-08-21.md` §5.2 and `docs/ops/launch-handoff-owner.md`:
SMTP on/off, the custom domain (Phase 11 P1), the three legal reviews (GATE), the Railway
dashboard session (`TSA_URL`, backups, `SENTRY_DSN`, recycle + restore drills), the
certificate decision, the viewer/phone/screen-reader checks, the guide skim, the `v1.0.0` tag.
Track those in `docs/10-launch-checklist.md`, which is where the owner ticks.

## How a prompt edits its row (copy this)

Start (first commit on the branch):

```
| 2 | … | … | 🔵 in progress — `fix/e2e-gate-hardening`, 2026-08-22 | `fix/e2e-gate-hardening` | — |
```

Finish (one commit on `main` after the merge, `docs(tracking): prompt 2 merged`):

```
| 2 | … | … | ✅ merged — PR #21 (`abc1234`), 2026-08-22, archived at `docs/archived/2026-08-22-handoff-to-cli-e2e-gate-hardening.md` | `fix/e2e-gate-hardening` · PR #21 · `abc1234` | PROGRESS session log "2026-08-22 — E2E and gate hardening"; queue rows ✔ |
```
