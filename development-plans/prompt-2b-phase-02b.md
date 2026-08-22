> **Executed 2026-08-01 — kept as history. Do not run.** Phase 2B is ✅ in `PROGRESS.md`; ownership flows through `apps/core/principals.py` and a grep test enforces it. Note that this file's own preconditions have gone stale in the way such files do — the `.git/index.lock` it says is "present right now" was a condition of one machine on one day in July 2026.

# One-Shot Prompt 2B — Execute Phase 2B (Anonymous Access) and ship it to `main`

**Usage:** start a Claude Code session with its working directory at the **ZenPDF repo root**, Docker daemon running, and `gh` authenticated (`gh auth status`). The session needs permission to run `git`, `gh`, `docker` and to delete files. Paste everything below the line as the prompt.

**Precondition:** Phases 0–2 are ✅ in `PROGRESS.md`. This prompt supersedes `prompt-2-phases-03-07.md` as the next thing to run — do **not** run Prompt 2 until this one has landed.

---

You are an expert full-stack engineer executing a pre-approved, pre-reviewed development plan **autonomously, start to finish, without asking for permission at each step**. Your mission: fully implement **Phase 2B — Anonymous Access**, then ship it to `main` through a reviewed pull request.

Work in this order. Do not skip steps. Do not ask me to confirm between steps.

---

## Step 0 — Preflight and housekeeping

Do this first; it takes two minutes and prevents silent failures later.

1. **Clear planning-session leftovers.** A previous tool ran without unlink permission and left two artifacts that must not reach the PR:
   - `.git/index.lock` — **present in the repo right now.** Every git write will fail with `Unable to create '.git/index.lock': File exists` until it is gone. Verify no git process is actually running first (`pgrep -x git` returns nothing), then `rm -f .git/index.lock`.
   - `development-plans/_to_delete/` — an empty scratch directory. `rm -rf development-plans/_to_delete`.
2. **Confirm the starting state:** on `main`, and `git fetch origin && git status -sb` shows no divergence from `origin/main`.

   **⚠ The working tree is NOT clean, and that is expected.** The planning session that produced this phase left ~16 modified/new files under `development-plans/` uncommitted:
   ```
   M  development-plans/01-architecture.md          (§21 added — normative)
   M  development-plans/02-feature-matrix.md
   M  development-plans/PROGRESS.md
   M  development-plans/README.md
   M  development-plans/phase-00 … phase-10, prompt-2-phases-03-07.md
   ?? development-plans/phase-02b-anonymous-access.md   (new — your work order)
   ?? development-plans/prompt-2b-phase-02b.md          (new — this file)
   ```
   Run `git status --porcelain` and confirm **every** uncommitted path is under `development-plans/`. If anything outside that directory is modified, stop and report it — that is someone else's work and this prompt does not own it. You will commit the plan docs as the first commit on your branch in Step 2.
3. **Toolchain:** `docker version`, `gh auth status`, `git --version`. If `gh` is not authenticated, stop and say so — Steps 7–9 cannot run without it.
4. **Baseline must be green BEFORE you change anything:**
   ```bash
   ./infra/up.sh && ./infra/test.sh --e2e
   ```
   Expected: backend **125 passed**, frontend **9 passed**, e2e **3 passed**. **If the baseline is red, STOP.** Record a Blocker in `PROGRESS.md` and report. Never start a phase on a red base, and never "fix" a pre-existing failure as part of this phase without recording it as a separate decision.

> **Note there is no CI in this repo** (no `.github/workflows`). Your own local run of `./infra/test.sh --e2e` **is** the merge gate. `gh pr merge` will not block on checks, so a green local run is the only thing standing between a bug and `main`. Treat it accordingly.

---

## Step 1 — Read the plan (in this exact order, fully)

1. `development-plans/PROGRESS.md` — the canonical tracker. Read its **Update protocol** and follow it for the whole session.
2. `development-plans/README.md` — locked decisions, dependency graph.
3. `development-plans/01-architecture.md` — **normative**. Read all of it, but §21 (Access model) is the spec for this phase and **wins over any phase doc that contradicts it**. Pay closest attention to: **§21** (all of it), **§16** (tiers/quotas/`METERED_OPS`), **§17** (security + anonymous hardening), **§9** (data model), **§10** (operation registry), **§13** (storage keys), **§11–12** (job pipeline/queues), **§6–7** (API + frontend conventions), **§20** (Definition of Done — note item 9).
4. `development-plans/phase-02b-anonymous-access.md` — **your work order.** Everything in it is in scope.
5. `development-plans/phase-00-foundation.md` and `phase-01-documents-and-viewer.md` — read the retrofit banners at the top; they tell you which already-ticked criteria this phase deliberately supersedes.

---

## Step 2 — Branch

```bash
git switch -c feat/phase-2b-anonymous-access
```

**First commit = the plan amendments** from Step 0.2, so the PR carries the spec alongside the code:

```bash
git add development-plans/
git status                     # confirm: only development-plans/ paths staged
git commit -m "docs(phase-2b): anonymous-first access model — architecture §21, phase 2B plan, doc amendments"
```

Then set Phase 2B to 🔵 in `PROGRESS.md` with today's date, copy its Acceptance criteria checklist verbatim into a new phase section (protocol step 2), and commit that too. The tracker should reflect work-in-progress from the start.

---

## Step 3 — Implement

`phase-02b-anonymous-access.md` + `01-architecture.md` §21 are authoritative. Suggested order — models first, the choke point second, then migrate call sites onto it:

1. **Models & migrations** — `core.GuestSession`; `Document.owner`/`Job.user` → nullable + `guest_session` FK + exactly-one-of `CheckConstraint`; `Document.expires_at`; `UsageCounter` repointed to principal + `heavy_ops`; `User.plan` (default `free`, admin-settable only). Migrations must be idempotent from zero **and** apply cleanly forward over existing dev data (every existing row has an owner, so the constraint holds on day one — prove it, don't assume it).
2. **`apps/core/principals.py`** — `owned_by`, `assert_owned`, `principal_of(job)`, `owner_kwargs(principal)`. This is the only place ownership may be expressed.
3. **`apps/core/limits.py`** — `for_principal(principal) -> Limits` backed by `settings.TIERS` (guest/free/pro per §16).
4. **Auth & permissions** — `PrincipalAuthentication` (JWT → `X-Guest-Token` → none), `IsPrincipal` default, `IsAccount` for account-only endpoints, new error codes `account_required` (403), `guest_expired` (410), `captcha_required` (403). Lazy mint on first **write**; return the token in the `X-Guest-Token` response header.
5. **Migrate every ownership call site** onto `principals.py` — views, services, **and the worker layer** (see traps below).
6. **Storage accounting** → principal (`documents/services.py`, `documents/tasks.py::_bump_storage` and its callers, `documents/views.py` quota read + purge decrement).
7. **Limits that don't exist yet** — add `MAX_PAGES` enforcement at ingest (tier-resolved); make `_check_concurrency` tier-resolved.
8. **Guest endpoints** — `POST /api/guest/session/`, `POST /api/guest/claim/`; guest-token acceptance on `POST /api/users/register/` and `POST /api/auth/login`.
9. **Throttles & abuse** — guest throttle keyed `(guest_token, ip_hash)`, stricter wins; `METERED_OPS` set; Turnstile adapter behind `CAPTCHA_ENABLED` (off in dev).
10. **`guest_purge`** beat task (hourly) — hard-delete expired sessions' rows **and** blobs.
11. **Frontend** — `GuestFacade`, interceptor credential branch, **the viewer's `httpHeaders` and `pdf-thumbnail.ts`** (both bypass the interceptor), guards narrowed to `accountGuard`, guest-aware 401 handling, session banner, token discard after claim.
12. **SSR + tool pages** — `@angular/ssr`, the seven Phase-2 slugs, generated `sitemap.xml`, `robots.txt`.
13. **Tests** — everything in the phase doc's Tests section, including the rewritten superseded tests.
14. **`e2e/phase-2b.spec.ts`** — the cold-browser journey through registration and claim.

### The five traps that will bite you

These came out of an adversarial review of the plan against this codebase. They are already written into the docs; they are repeated here because each one silently produces a *passing build with a real bug*.

1. **Ownership in workers flows through `job.user`, not `request.user`.** `documents/tasks.py` does `Document.objects.get(id=…, owner=job.user)` and `_create_document_from_bytes(owner=job.user, …)`. For a guest job `job.user is None`, so (a) document creation violates the exactly-one-of constraint, and (b) `filter(owner=None)` compiles to `owner_id IS NULL` — a lookup matching **any guest's** document. Route both through `principal_of(job)` / `owner_kwargs(...)`. **Your grep test must cover `request.user`, `job.user` AND `owner=`** — scoped to `request.user` alone it passes while both bugs are live.
2. **`METERED_OPS` is not the `heavy` queue.** The queue also holds `merge`, `alternate_mix`, `compress`, `repair` — flagship tool pages. Deriving the guest rate cap or the Turnstile challenge from `op.queue` puts a CAPTCHA in front of a guest's first merge, which defeats the entire phase. `METERED_OPS = {ocr, convert_from, convert_to, compare}`, full stop.
3. **`MAX_PAGES` is not enforced anywhere today** despite §17 describing it in the upload chain. You are **adding** it, not re-routing it. Same for tier-resolved concurrency.
4. **Claim must move documents, jobs AND usage counters.** Jobs left behind mean a user who registers mid-operation loses the poll on the exact file they signed up to keep. Counters left behind let a monthly quota be reset by laundering work through a guest session. Expire the session server-side after claim so `guest_purge` can never cascade into rows the user now owns, and make the client discard its guest token.
5. **The viewer and thumbnails bypass the HTTP interceptor.** `features/workspace/workspace.ts` feeds an `authHeaders` object to ngx-extended-pdf-viewer's `httpHeaders` (it fetches outside `HttpClient`), and `shared/pdf-thumbnail.ts` exists because `<img>` cannot carry a JWT. Miss these and guests get a working workspace with a blank viewer and no thumbnails.

### Rules while implementing

- **`01-architecture.md` is normative.** If a phase doc contradicts it, the architecture doc wins — and you fix the conflict in the same commit.
- **Every deviation or non-obvious choice goes in the `PROGRESS.md` Decisions log with a written rationale.** A decision without a rationale is a bug.
- **Blocked?** Set 🟡, fill a Blockers entry (symptom, what you tried, the smallest human decision needed), and stop work on that item — do not guess your way past an ambiguity in the plan.
- Commit in logical chunks with conventional-commit messages (`feat(phase-2b): …`, `refactor(core): …`, `test(documents): …`), matching the existing history style.
- Do not leave `TODO`s, dead code, commented-out blocks, or skipped tests.

---

## Step 4 — Definition of Done (01-architecture §20)

Do not proceed to the PR until **all** of these hold:

1. Every Phase 2B acceptance criterion is ticked in `PROGRESS.md` **with one line of evidence each** (test name + count, command output, or e2e spec name). Unproven ticks are forbidden.
2. Fresh-stack proof: `./infra/reset.sh --yes && ./infra/up.sh && ./infra/test.sh --e2e` — all green.
3. Migrations idempotent from zero.
4. Coverage gates hold: `apps` ≥ 85%, `pdf_engine` ≥ 90%.
5. `ruff`, `mypy` (loose), `eslint` clean; `manage.py check` clean.
6. OpenAPI schema updated and accurate for the new endpoints.
7. **DoD item 9:** the seven Phase-2 tool pages are server-rendered, in the generated `sitemap.xml`, and usable end-to-end by a guest.
8. The two superseded tests/criteria (phase-00's `/app/**` guard criterion; `test_core.py::test_error_shape_on_unauthenticated`) are **rewritten deliberately**, not deleted or skipped, and the rewrite is noted in the Decisions log.

---

## Step 5 — Update the tracker

Set Phase 2B to ✅ with the date, update the status table, fill the phase section with evidence, add Decisions log entries, and write a **handoff note** for the next session pointing at Phase 3 (`phase-03-annotations.md`) and noting that `prompt-2-phases-03-07.md`'s precondition banner can now be updated to "Phases 0–2B are ✅".

---

## Step 6 — Commit and push

```bash
git add -A
git status            # review every file; nothing stray, no .env, no lock files, no build output
git commit -m "feat(phase-2b): anonymous access — guest sessions, principal model, tiered limits, SSR tool pages"
git push -u origin feat/phase-2b-anonymous-access
```

---

## Step 7 — Open the PR

```bash
gh pr create --base main --head feat/phase-2b-anonymous-access \
  --title "Phase 2B — Anonymous access (guest sessions, principal model, tiered limits, SSR tool pages)" \
  --body "$(cat <<'EOF'
## What

Implements Phase 2B: the product now works with no account. Guests get a session-scoped workspace; accounts become an upgrade.

The first commit carries the plan amendments (architecture §21 — normative — plus the Phase 2B work order and ripple edits across the other phase docs); the rest is the implementation.

- `core.GuestSession` + principal model; ownership funnelled through `apps/core/principals.py`
- Tier-resolved limits (`guest`/`free`/`pro`) via `core.limits.for_principal()` — `pro` is config-only, no billing
- Guest TTL (24h sliding / 72h cap) + hourly `guest_purge` hard-delete
- Claim-on-signup: documents, jobs and usage counters reparented in one transaction
- Guest abuse controls: token+IP throttle keying, `METERED_OPS` caps, Turnstile adapter
- `MAX_PAGES` now actually enforced (it never was); tier-resolved job concurrency
- SSR + seven public tool pages + generated sitemap/robots

Spec: `development-plans/01-architecture.md` §21 (normative) and `development-plans/phase-02b-anonymous-access.md`.

## Verification

<!-- paste the real numbers from the fresh-stack run -->
- `./infra/reset.sh --yes && ./infra/up.sh && ./infra/test.sh --e2e` — backend N passed, frontend N passed, e2e N passed
- Coverage: apps N%, pdf_engine N% (gates 85/90)
- ruff / mypy / eslint clean

## Superseded by design

- phase-00 acceptance "`/app/**` redirects unauthenticated users" — now only the three account-only routes redirect
- `test_core.py::test_error_shape_on_unauthenticated` — anonymous reads are no longer a 401 under `IsPrincipal`

## Notes

No CI configured in this repo — the local `test.sh --e2e` run above is the merge gate.
EOF
)"
```

Fill the verification section with the **real** numbers from your run. Do not paste the placeholder.

---

## Step 8 — Review the code, properly

Review your own PR against a real bar before merging. This is not a formality — you are the only reviewer, and there is no CI.

1. Run `gh pr diff` and read the **entire** diff as a reviewer, not as its author.
2. Use the `engineering:code-review` skill if available. Additionally spawn **parallel subagents** for independent passes, each with a distinct lens:
   - **Security / isolation:** can any principal reach another's data? Walk every endpoint. Check the worker paths specifically (trap 1). Check that `assert_owned` returns 404 and never 403.
   - **Correctness:** the claim transaction (partial failure, idempotency, quota overflow), the constraint under concurrent writes, `guest_purge` orphaning blobs or cascading into claimed rows, token rotation.
   - **Plan conformance:** does the diff actually satisfy §21 and every Phase 2B acceptance criterion, or does it satisfy the letter while missing the intent? Check DoD item 9 honestly.
   - **Regression:** did the ownership refactor change behaviour for authenticated users anywhere it shouldn't?
3. **Fix everything real that comes back.** Push follow-up commits to the same branch. Re-run `./infra/test.sh --e2e` after fixes.
4. **The bar for "satisfied":** zero unresolved findings from the security and correctness passes; all DoD items in Step 4 hold; full suite green on the final commit. If a finding is deliberately not fixed, it goes in the `PROGRESS.md` Human review queue with a reason — not silently dropped.

---

## Step 9 — Merge and return to main

Only when Step 8's bar is met:

```bash
gh pr merge --squash --delete-branch
git switch main
git pull origin main
git log --oneline -3          # confirm the squashed commit is on local main
git status                    # confirm clean
```

Then report back with: what shipped, the final test/coverage numbers, every entry you added to the Decisions log, anything you put in the Human review queue, and where Phase 3 picks up.

**Never** force-push to `main`, never merge with a red suite, and never bypass the DoD to "finish faster" — if something is incomplete, say so plainly and leave the PR open.
