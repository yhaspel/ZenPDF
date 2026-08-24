**Executed 2026-08-24 — type-aware linting is on and in the gate, `core/api-error.ts` owns the §6 envelope at all 28 call sites, and the 17 promise findings were decided one at a time. Its two headline numbers were wrong on today's tree and its two throwaway ones exact: **344** findings under `recommendedTypeChecked` and **894** under `strictTypeChecked`, not 198 — but `no-floating-promises` was 14 and `no-misused-promises` 3, to the finding. The root cause it names is no longer the largest: 246 of the 344 are in spec files, and 199 of those trace to Angular typing its own test surfaces `any`. **Two of its instructions were not followed, both with the measurement written down.** It said `void` is not the answer for the floating navigations; it is here, because `provideBrowserGlobalErrorListeners()` already routes `unhandledrejection` to `ClientErrorHandler`, so a `.catch()` would have suppressed the only report that exists — the exception is `accountGuard`, where the result genuinely mattered and which returns a `UrlTree` now. And its §5 step 1 asked for the 429 countdown to be confirmed: it renders on the **first** refusal and not on later ones, which is DRF's doing and pre-existing, filed as its own queue row. See PROGRESS "2026-08-24 (last, part four) — Type-aware ESLint: the number was wrong, and so was its root cause", with browser evidence in `docs/reviews/evidence/type-aware-eslint/`. Historical.**

# Handoff — Type-aware ESLint: the 198 findings, the `apiError()` helper, and a gate that keeps it clean (2026-08-21, revision 2 after Phase 12)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `chore/type-aware-eslint`. **Depends on:** `handoff-to-cli-workspace-debt-batch.md` and `handoff-to-cli-mobile-workspace.md` merged (fewer moving files; the sweep touches ~28 call sites).
**Source of truth:** PROGRESS Human review queue row "Type-aware ESLint" (2026-08-02: 198 findings, 129 from `HttpErrorResponse.error: any`, 14 `no-floating-promises` on `router.navigate`, 3 `no-misused-promises`); Decisions log 2026-08-02 "Type-aware ESLint is deliberately not in this change"; `docs/reviews/status-review-2026-08-21.md` §3.3, §5.1 item 7.
**Deploys on merge?** Yes (frontend rebuild) — but the intent is **zero behaviour change**; the PR's job is to prove that.

---

```text
You are adopting type-aware linting in the Angular app. Read AGENTS.md, the two PROGRESS
entries named above (they already contain the measurement and the reasoning — do not
redo the analysis, re-measure it), frontend/eslint.config.js, frontend/tsconfig*.json,
and frontend/src/app/core/services/api.service.ts (or wherever HTTP errors are shaped
today — find the §6 error envelope type if one exists).

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    git switch -c chore/type-aware-eslint

TRACKING: in docs/reviews/handoffs/TRACKING.md set row 7 to
`🔵 in progress — `chore/type-aware-eslint`, <today>` (Status column) and put the branch name in
the next column; include that edit in your FIRST commit on the branch. Touch no other row.

PROGRESS session-log entry; the row → 🔵.

## 1. Measure, then decide the rule set

Enable `typescript-eslint`'s type-checked config (`recommendedTypeChecked` or the stricter
`strictTypeChecked` — try both, report both counts) with `parserOptions.projectService`
and run `npx ng lint`. Paste the count by rule into PROGRESS. The row predicted 198 with
one root cause (`HttpErrorResponse.error: any`) — measured before Phase 12 added ~5 000
lines of frontend; confirm or correct it on today's tree.

Rules that stay on (non-negotiable): `no-floating-promises`, `no-misused-promises`,
`no-unsafe-member-access`/`no-unsafe-assignment` (the `error: any` family),
`await-thenable`, `no-unnecessary-type-assertion`, `restrict-template-expressions`
(with the sensible allowances), `prefer-nullish-coalescing`/`prefer-optional-chain` as
warnings if the count is unmanageable. Each rule you turn OFF gets a one-line reason in
`eslint.config.js` and in the Decisions log — "too many findings" is not a reason; "the
rule misfires on signals/inputs in this pattern" is.

## 2. The typed error helper

`core/api-error.ts`: `apiError(err: unknown): ApiError` that narrows `HttpErrorResponse`
into the §6 envelope (`{code, message, details}`) with honest fallbacks (network error,
non-JSON body, a 429 with `Retry-After`), plus `isApiError()`. Replace every
`err.error?.error?.code` / `(err as any)` spelling at the ~28 call sites with it — the
facades and the interceptor first. Unit tests: every branch of `apiError` (envelope,
plain string body, blob body as the viewer returns, `status 0`, `Retry-After` parsing).

## 3. Floating and misused promises

The 14 `router.navigate(...)` calls: `void` is not the answer — handle or deliberately
discard with a comment per site; where a navigation result matters (guards, claim
flow), await it. The 3 `no-misused-promises` (async handlers in templates/subscribes)
get sync wrappers.

## 4. Nothing changed — prove it

- `npm test` green (396 + yours); `ng lint` clean under the new config; `npm run build` produces a
  bundle — compare `dist/zenpdf-web/browser/main-*.js` size before/after (±2 %) and
  `verify:prerender` green.
- `./infra/test.sh --e2e` fully green on the restarted stack.
- `ng lint` now runs type-aware in `infra/test.sh` (it already calls `ng lint`; confirm
  the config applies there and time it — if it adds more than ~60 s, document it, do not
  drop it).

## 5. UI testing via the Chrome MCP tools (behaviour-neutral change — smoke the error paths you touched)

On http://localhost:4200, both themes, 1280 px and 390 px, console read after each:
1. A guest hits a 429: lower `THROTTLE_GUEST` in `infra/.env` temporarily (restore
   after), hammer `/api/config/` by reloading, confirm the workspace's throttled state
   renders the countdown (`workspace-throttled`) — the `apiError` path for `Retry-After`.
2. Open `/app/doc/00000000-0000-0000-0000-000000000000`: the 404 copy renders unchanged.
3. Upload a non-PDF to `/merge-pdf`: the 415 message renders as before.
4. Log in with a wrong password: the inline error is unchanged.
5. Claim flow: guest uploads, registers (Mailpit), documents appear — the awaited
   navigation did not change the order of events.
Screenshot each; one line per finding in PROGRESS. After merge, repeat 2 and 3 on
https://zenpdf.up.railway.app once the deploy is live.

## 6. Record, self-archive, ship

PROGRESS: close the row ✔ with the before/after counts; Decisions log for every rule
turned off and for the `router.navigate` policy; `01-architecture.md` §18 CI note gains
"eslint (type-aware)". Then:

    git mv docs/reviews/handoffs/handoff-to-cli-type-aware-eslint.md docs/archived/$(date +%F)-handoff-to-cli-type-aware-eslint.md

prepend the "Executed <date>" banner.

TRACKING: after the merge and the `git pull --ff-only` below, set row 7 of
docs/reviews/handoffs/TRACKING.md to `✅ merged — PR #<n> (<merge sha>), <date>, archived at
docs/archived/<date>-handoff-to-cli-type-aware-eslint.md`, fill the PR/merge column, and put the PROGRESS anchor
(your session-log heading and the queue rows you closed) in the Evidence column. Commit that
one edit directly on `main` as `docs(tracking): prompt 7 merged` and push — docs only, no
deploy, the same way `f34800f` recorded Phase 12. This is the last commit of the run — do it
before you report. (The README carries no status; the board does.)

Commit in chunks (`build(lint): type-aware config`, `refactor(core): apiError()`,
`refactor: navigate results handled`, `docs(progress): …`); push;
`gh pr create --base main --head chore/type-aware-eslint --title "chore(lint): type-aware ESLint, the apiError() helper, promises handled" --body "<What / Rule set and the ones off, with reasons / Proof of no behaviour change: bundle size, suites, Chrome evidence>"`.

Self-review — *regression* is the only lens that matters here: read the full diff as a
reviewer hunting for a changed branch (an `?? ` that used to be `|| `, a narrowed error
that now hides a message, a navigation that used to be fire-and-forget and now awaits
inside a signal effect). Fix; re-run the gate; `gh pr merge --merge --delete-branch &&
git switch main && git pull --ff-only origin main`; production check; revert on `main`
if production regresses. Report.
```
