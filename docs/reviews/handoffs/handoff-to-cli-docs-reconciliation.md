# Handoff — Record reconciliation: make the docs say what the code does (2026-08-21)

**For:** Claude CLI, run locally on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `docs/reconcile-2026-08-21`. **Depends on:** nothing — run this first.
**Source of truth:** `docs/reviews/status-review-2026-08-21.md` §3 (discrepancies) and §6 (document catalogue + contradictions).
**Deploys on merge?** No — `docs/**` is outside every Railway watch pattern.

Paste everything in the block below into `claude`.

---

```text
You are reconciling ZenPDF's written record with its verified state. Read, in this order:
AGENTS.md; docs/reviews/status-review-2026-08-21.md (all of it — it is the spec for this
work, and §3/§6 list every statement you will change with a line number); the newest three
session-log entries of development-plans/PROGRESS.md. Do not change application code,
tests, templates, styles or infra in this prompt — if you find a code defect, file a Human
review queue row instead.

## 0. Preflight — commit what the review left uncommitted

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain

The Cowork session that wrote the review could not push, so it left these in the working
tree, uncommitted: the folder rename `docs/review/` → `docs/reviews/` (git sees deletes +
adds), `docs/reviews/status-review-2026-08-21.md`, `docs/reviews/handoffs/*.md` (this
prompt among them), and edited references in `AGENTS.md` and
`development-plans/PROGRESS.md`. If `git status` shows anything ELSE, stop and tell me.

    git switch main && git pull --ff-only origin main
    git switch -c docs/reconcile-2026-08-21
    git add -A
    git status            # only docs/review→docs/reviews renames, docs/reviews/**, AGENTS.md, PROGRESS.md
    git commit -m "docs(reviews): rename docs/review → docs/reviews; add the 2026-08-21 status review and CLI handoff prompts"

Confirm git recorded the three old files as renames (`git show --stat HEAD` shows
`docs/{review => reviews}/…`). Do NOT touch `docs/archived/2026-08-21-followups.patch` —
its four `docs/review/` strings are historical.

## 1. Start the record for this session

Append a session-log entry to PROGRESS.md ("2026-MM-DD — Record reconciliation") stating
what this branch does and that it changes no code. Keep it updated as you go.

## 2. PROGRESS.md — fix every self-contradiction the review lists (§3.1)

Work through §3.1 items 1–10 and §3.2 items 11–18 as a checklist; for each, edit the
statement at the cited line and leave a one-clause inline note where a reader could be
misled by history (e.g. "*(corrected 2026-MM-DD: a host exists — see §…)*"):

 1. Phase-10 section :61/:63/:64 — rewrite the four `[~]` criteria against the Railway host
    that has existed since 2026-08-08. Lighthouse and the p95 run are now *runnable*
    (owed, not blocked); "clean-VM compose deploy … performed" → "production deploy
    performed on Railway 2026-08-08 (`docs/ops/railway-deploy-report-2026-08-08.md`);
    a compose deploy on a clean VM was never performed and is no longer the target;
    the restore drill is still owed". Update the DoD row 1 counts to match the list
    (1 ticked, 5 `[~]`, 1 GATE) and the Phase-8 DoD row to match its list (6/1).
 2. :93 DoD row 3 — replace 988/178/58 with the current figures and date them: backend
    1061 passed / 4 skipped on the full stack (2026-08-21 morning); frontend 258;
    e2e 60 tests, 59/60 on two consecutive local runs (2026-08-21); note that the evening
    "1051 / 14 skipped" run had Gotenberg down (10 conversion tests skipped, not passed).
 3. :1129 — mark the Playwright-`check()` verdict as superseded inline, pointing at the
    stale-worker root cause in the same row.
 4. :1135/:1137 — add "*(superseded: PR #19 merged 2026-08-21 14:49 +03:00 and
    auto-deployed; both fixes verified on the live site the same day — status review L9)*".
    Add the same addendum at the top of docs/reviews/2026-08-21-post-deploy-verification.md
    (a dated "Addendum" block; do not rewrite the report body) covering :339–341 and
    Finding 3's mechanism.
 5. :1105 — qualify "green first time" with the ten Gotenberg skips.
 6. Human review queue "Self-serve account deletion" (:1065) → ✔ Resolved 2026-08-02
    (Phase 10): `DELETE /api/users/me/delete/`, `GET /api/users/me/export/`,
    Settings → Your data, `apps/users/tests/test_privacy.py` (10), legal copy already says so.
 7. Human review queue `base_version_seq` row (:1088) — correct the mechanism: the mode
    components emit `output<Job>()`; the workspace bindings
    (`workspace.html:109–161`) drop `$event` and every handler calls `viewer.reload()`.
    Leave it OPEN — the fix belongs to `handoff-to-cli-e2e-gate-hardening.md`.
 8. :1009 (L8 row) — add the caveat: bare job subscriptions remain at `tool-page.ts:320`,
    `dashboard.ts:181,190,201`, `workspace.ts:637`; fold them into the open five-panels
    row (:1028) so one row owns the whole sweep.
 9–10. Cosmetic line numbers/counts/test names exactly as §3.1 item 9–10 list them.
 11–18. Add ONE new Human review queue row per §3.2 item that is not already tracked:
    `NUM_PROXIES` three-values (owner: backend debt batch), `@api_unavailable` header set
    (backend debt batch), esign suite coupled to `/certs/…` (e2e gate hardening), gate
    passes with Gotenberg down (e2e gate hardening), design-contract grounding sentence
    (fix it in step 4 below and mark the row ✔ in the same change). Items 15–16 are
    disclosures — one sentence each in the session log, no row.

## 3. The other plan documents

- development-plans/README.md — header line: "**Status:** Phases 0–9 complete, Phase 10
  awaiting owner sign-off, Phase 11 not started; production live on Railway since
  2026-08-08 (auto-deploy from `main`). See PROGRESS.md." Fix the index rows: prompt-2b
  and prompt-2 are "executed/superseded — historical"; add a row for
  prompt-3-phases-03-10.md (historical); add `docs/reviews/` to "How to use this plan".
- development-plans/prompt-1-phases-00-02.md, prompt-2b-phase-02b.md,
  prompt-3-phases-03-10.md — prepend a one-paragraph banner: "**Executed <date> — kept
  as history. Do not run.**" (prompt-2 already has one; soften its "Unblocked … add §21"
  line so it does not read as an instruction).
- development-plans/01-architecture.md — §2: note reportlab is pinned 4.4.4 and
  `signature_pad` is not used (plain canvas); §4: add `infra/railway/` (Dockerfiles,
  `nginx.railway.conf`, deny-list) and `docs/` (`ops/`, `design/`, `reviews/`,
  `archived/`) and remove `worker.Dockerfile`/`infra/docker/nginx.conf` (never existed);
  §17: retire the "page cap ⚠ not implemented" aside (2B added it); §19: add
  `NUM_PROXIES` (1 behind no proxy, 2 for compose TLS-terminator→nginx→gunicorn, **3 on
  Railway — measured**), `CACHE_URL`, `SIGNING_CERT_B64`, `API_BASE_URL`; add a one-line
  "Deployment target" note pointing at `docs/ops/railway.md`. Architecture edits go in
  their own commit ("docs(architecture): …").
- development-plans/02-feature-matrix.md :105 repair = PyMuPDF; :128 no `signature_pad`.
- Phase docs 00–09: append a two-line footer "**Executed** (see PROGRESS.md §Phase N).
  Known drifts between this work order and what shipped are recorded in PROGRESS's
  Decisions log; this file is the plan, not the record." Do not rewrite their bodies.
- phase-10-hardening-release.md — mark the clean-VM criterion as re-scoped (see step 2.1)
  and `@full` as "the untagged whole suite".
- phase-11-adsense-review.md :28–31 — "exactly two sanctioned additions" → "four (theme
  toggle, landing filter, version-level Undo, annotate Undo/Redo)".

## 4. Design contract hygiene (text only — no UI change)

docs/design/design-instructions.md: grounding :5 and §10 :295 — the sanctioned additions
are now four (theme toggle, landing filter, version Undo 2026-08-20, annotate Undo/Redo
2026-08-20). Date the 2026-08-21 "In-pane toolbars wrap" amendment at :203. Add a short
"Amendment log" section at the end listing every dated amendment (08-10, 08-18, 08-20,
08-21) with the section it touched. This is text about already-shipped UI; it does not
need a browser check — say so in your PR.

## 5. `docs/ops` and the other docs (§6.2)

- AGENTS.md — `PROGRESS.md` → `development-plans/PROGRESS.md`; `docs/review/` →
  `docs/reviews/` (already done by the review — verify); remove the obsolete bootstrap note
  at :13 (it declares itself obsolete once the contract exists) — keep the sentence that
  the contract is law.
- docs/ops/README.md — index the four Railway docs; add a "Railway equivalents" column
  (`railway logs -s <svc>`, dashboard restart, `railway run`) to the commands block.
- docs/ops/rollback.md, restore-drill.md, queue-stuck.md, storage-full.md — add a
  "**On Railway (production)**" section at the top of each with the real procedure
  (rollback = redeploy the prior SUCCESS deployment, with the frozen-manifest trap from
  the deploy report; restore = Railway volume snapshot + managed-Postgres restore, keeping
  the audit-chain re-verification step; queue-stuck = `railway logs`/restart the worker
  service; storage-full = 50 GB Pro volume, growth check). Keep the compose sections,
  labelled "Local / compose".
- docs/ops/railway.md — :73 storage row: production is SeaweedFS 3.97 on a 50 GB volume
  with daily snapshots (external S3 is an option, not the current state); :81
  `ALLOWED_HOSTS` must include `healthcheck.railway.app`; worker command carries
  `--max-memory-per-child 1500000`.
- docs/ops/railway-handoff-claude-cli.md — strike H2 and H3 as done (2026-08-21, with the
  PROGRESS line references); :122–124 deployed tree → "`main` via auto-deploy"; keep H1
  verbatim (it is the prompt `handoff-to-cli-h1-production-seal-proof.md` reuses).
- docs/ops/launch-handoff-owner.md — add a dated "Update 2026-08-21" block at the top:
  viewer finding fixed and verified live; H2/H3 done; what remains is §5.2 of the status
  review (copy that list in).
- docs/ops/railway-deploy-plan.md and railway-deploy-report-2026-08-08.md — "**Executed
  2026-08-08 — historical.** `NUM_PROXIES` measured 3, auto-deploy live since 08-10; see
  railway.md" banner on each; §8 of the report: tick gotcha 4, auto-deploy, H2, H3.
- docs/ops/release.md — remove "what CI runs" (there is no CI; say "what `infra/test.sh
  --e2e` runs"); the `@quarantine` sentence must describe what the gate actually does
  today (nothing excludes it) and point at `handoff-to-cli-e2e-gate-hardening.md`.
- docs/10-launch-checklist.md — do NOT tick anything (owner-executed), but add a
  "Status as of 2026-08-21" note under each section naming what is de facto satisfied
  with evidence (env vars set per the deploy report; CSP verified 08-10; fresh
  `SECRET_KEY`; seed admin rotated; `@smoke` run 08-21 4 passed / 2 environmental) so the
  owner ticks with evidence rather than from memory; :20 the production policy is
  `infra/railway/nginx.railway.conf`.
- docs/09-adsense-readiness.md — tick the two done items (:35–39, :51–53) with evidence;
  :75–76 CSP is on; production's policy file.
- docs/09-storage-hygiene.md — state that admin is OFF in production (`/admin/` 404) so
  ban/trash are unreachable until `ADMIN_ENABLED`+allowlist are set; give the
  `railway run python manage.py oversized_accounts` equivalent (check the command's real
  name in `apps/core/management/commands/` before writing it).
- docs/10-accessibility-screen-reader-script.md — first line: run against the local stack
  (Mailpit) because production has SMTP off.
- docs/user-guide.md — add the guest caps (25 MB, 300 pages, 200 MB, 1 concurrent job,
  5 metered ops/hour, 50 OCR pages/day; 24 h sliding / 72 h cap) and a one-line note that
  sending signature requests is not yet enabled on the hosted service; mention page
  selection on extract/delete, the text box and Undo. Check every number against
  `backend/config/settings/base.py` TIERS before writing it.
- docs/reviews/ZenPDF-QA-Report.md and IMPLEMENT-FINDINGS-PROMPT.md — prepend
  "**Historical — findings implemented 2026-08-04 (PROGRESS §'Session log — QA findings');
  only M6 remains open (Human review queue).**"; in the QA report add a short "Design
  items D1–D7 — where they landed" list pointing at the design-contract sections.
- docs/design/2026-08-10-compact-landing.md :78 — the mockup file named does not exist;
  say the implementation is the reference.

## 6. Verify

- `git diff --stat` touches only `*.md` files under development-plans/, docs/, and
  AGENTS.md (plus the renames from step 0).
- Every path you wrote exists: run
  `grep -rhoE '`(docs|development-plans|backend|frontend|infra|e2e)/[^` ]+`' development-plans docs AGENTS.md | sort -u | tr -d '`' | while read p; do [ -e "$p" ] || echo "MISSING $p"; done`
  and fix every MISSING (excluding paths inside `docs/archived/*.patch`).
- `grep -rn "docs/review/" --include=*.md . | grep -v docs/archived | grep -v status-review-2026-08-21` → no hits.
- Re-read the status review's §3.1/§3.2 and §6 tables and tick each item off in your
  session-log entry with the commit that fixed it.

## 7. UI testing via the Chrome MCP tools (docs-only PR — minimal, but do it)

1. After pushing the branch, open the PR URL in Chrome with the Chrome MCP tools and
   confirm the "Files changed" tab lists only markdown files and the renames; screenshot.
2. Open https://zenpdf.up.railway.app/ and https://zenpdf.up.railway.app/api/health/ in a
   fresh tab: confirm the site is unaffected (no deploy was triggered — the health JSON
   still says `status: ok` and the bundle name in the page source is unchanged before and
   after merge). Record both in the PROGRESS entry.

## 8. Self-archive

    git mv docs/reviews/handoffs/handoff-to-cli-docs-reconciliation.md \
           docs/archived/$(date +%F)-handoff-to-cli-docs-reconciliation.md

Prepend "**Executed <date> — see PROGRESS.md session log. Historical.**" to the archived
copy, and update the table in docs/reviews/handoffs/README.md (row 1 → "done <date>,
archived").

## 9. Ship

    git add -A && git status     # nothing stray: no .env, no build output, no lock files
    git commit -m "docs: reconcile the record with the verified 2026-08-21 state"
    git push -u origin docs/reconcile-2026-08-21
    gh pr create --base main --head docs/reconcile-2026-08-21 \
      --title "docs: reconcile PROGRESS, plans and runbooks with the verified 2026-08-21 state" \
      --body "<What / Why (status review §3, §6) / Verification (the grep checks above, the Chrome screenshots) / No code changes>"

Review it yourself properly: `gh pr diff`, then two independent passes — (a) *accuracy*:
every sentence you changed is supported by the status review or by the code (spot-check
ten at random against the files they describe); (b) *loss*: nothing historical was
deleted that a future reader needs (banners, not deletions). Fix what is real, push,
re-run the grep checks. Then:

    gh pr merge --merge --delete-branch
    git switch main && git pull --ff-only origin main
    git log --oneline -3 && git status

Report back: the list of §3/§6 items closed (with commit), any queue rows added, and
anything you deliberately left as-is with the reason.
```
