# Status review — ZenPDF vs `development-plans/PROGRESS.md` — 2026-08-21, 11:45–12:30 UTC (14:45–15:30 Asia/Jerusalem)

An adversarial validation of the project's recorded status against the code that exists, the tests that run, and the site that is live. Nothing below was taken from PROGRESS.md on trust: every status claim was re-derived from the repository, from a suite run in this session, or from the production host, and each one is labelled **Verified** (measured here), **Inferred** (read from code/config, not confirmed live) or **Unverified** (could not check, reason given). The checklist was written before any evidence was gathered (Appendix A) so that "pass" was not defined after seeing the numbers.

Reviewed tree: `yhaspel/ZenPDF` **`main` @ `df6afb9`** (merge of PR #19, 2026-08-21 14:49:05 +03:00). The working copy on the owner's Mac was re-read at the end of the session and is on `main` @ `df6afb9`, clean (`?? .claude/` only), in sync with `origin/main`. Production: `https://zenpdf.up.railway.app`.

> **The repo moved while this audit ran.** The snapshot was taken at 11:46 UTC from the Mac, which was then on branch `fix/followups-2026-08-21` @ `c9bed04`, three commits ahead of `origin/main` (`dacf623`). At 11:48–11:49 UTC a Claude CLI session on the Mac committed `250867e`, opened and merged PR #19, checked out `main` and pulled. Railway auto-deployed the merge. Every finding below was re-checked against `df6afb9`, which differs from the audited snapshot only in `PROGRESS.md` (+17 lines) and a new `docs/archived/2026-08-21-followups.patch` — **no application code differs**, so the suite and lint runs made on the snapshot stand for `main`.

---

## 1. Verdict

**The status table in PROGRESS.md is accurate: Phases 0–9 are complete in code, Phase 10 is engineering-complete and correctly held amber on owner-only items, Phase 11 has not started. The record around that table is not: the file contradicts itself in at least six places, two Human-review-queue rows are stale, and several companion documents still describe a world that ended on 2026-08-10 or 2026-08-20.**

Headline measurements (all **Verified** in this session unless marked):

| What PROGRESS claims | What was measured | Result |
|---|---|---|
| 24 public tool pages; 29 prerendered routes | `TOOL_PAGES` has 24 entries; `app.routes.server.ts` → 1 + 24 + 4 = 29; `npm run build` → "Prerendered 29 static routes."; `verify:prerender` → "24 tool pages server-rendered…"; production `sitemap.xml` has 29 `<loc>` | PASS |
| 258 frontend unit tests green | `ng test` → **38 files, 258 passed**, 5.4 s | PASS |
| backend 1061 passed / 4 skipped on the full stack (1051 / 14 on 08-21 evening) | 1065 collected here; **1043 pass** once `SIGNING_CERT_PATH` points at the dev `.p12`; the residual **7 failures are each a missing binary or service in this sandbox** (Ghostscript ×2, tesseract language packs/unpaper ×3, Redis/admin-gate environment ×2); 14 skipped = 4 Postgres-only + 10 Gotenberg-only | PASS (Inferred for the 7) |
| ruff, mypy, `ng lint` clean | ruff "All checks passed"; mypy "no issues found in 173 source files"; `ng lint` "All files pass linting" | PASS |
| 60 e2e tests; 59/60 on two local runs 08-21 | 60 `test(` declarations across 13 spec files; the runs themselves could not be repeated here (needs the Docker stack) | Count PASS; run Unverified |
| 47 registry ops incl. `separate`; `redact` on `heavy`; `finalize_sign_request` not an op | `apps/pdf_engine/registry.py`: 47 ops (38 default / 9 heavy), `extract_pages` schema carries `separate`, `redact` queue heavy | PASS |
| Every test name and path cited in PROGRESS exists | 172 pytest names: 169 exact, 2 truncated, 1 helper; 44 spec files: 44 found; 49 quoted titles: 49 found; 261 paths: none missing without an explanation in the file itself | PASS |
| `v1.0.0` not tagged | `git tag` empty; `git ls-remote --tags origin` empty | PASS |
| Production runs `main` | `main-5K2QWJDV.js` served by production hashes `320ea10e…c09d56`; a local `npm run build` of `df6afb9` produces the same file with the same hash — byte-identical | PASS |
| Two 08-21 follow-up fixes "not deployed" (PROGRESS :1135/:1137, report :339) | **Superseded during this audit.** Driven live through a transparent proxy: `/organize-pdf` lands on `?mode=organize` with 3 tiles and 0 `ngx-extended-pdf-viewer` elements; at a true 390 px viewport (emulation off) all nine workspace modes report `scrollWidth === 390` | PASS — the record is stale |
| The viewer draws in production | View mode canvas 1041×1473 with 7 distinct sampled colours; `/content/` 200; both `.mjs` 200; zero console errors | PASS |
| Phase 11 not started | `SITE_URL = 'https://zenpdf.up.railway.app'`; no `guide-pages.ts`; footer has exactly 5 links; `/contact` and `/guides` → 404 live | PASS |

What did **not** hold up is in §3 (discrepancies) and §6 (documents). The most consequential items:

1. **PROGRESS.md disagrees with itself** about whether a production host exists (Phase-10 DoD row, "live" by its own label, still says "there is no deployed host yet"), about test counts (988/178/58 vs 1061/250 vs 1051/258 in the same file), about the `separate`-extraction root cause (Playwright `check()` at :1129 vs stale Celery workers at :1111, both dated 08-21), and about whether the follow-ups are deployed (:1135 vs :1101). The status table is right; the narrative is layered, not reconciled.
2. **Two queue rows are stale:** "Self-serve account deletion" (⬜) was implemented in Phase 10 — `DELETE /api/users/me/delete/`, `GET /api/users/me/export/`, Settings → Your data, and the legal copy already describes it. The `base_version_seq` row blames the mode components for emitting "a bare `(saved)`"; they emit the `Job` — it is the workspace's handlers that discard it.
3. **L8 is overstated:** the five "done" files still contain bare job subscriptions outside their `track()` helper (`tool-page.ts:320`, `dashboard.ts:181,190,201`), on top of the five panels the open row names.
4. **`NUM_PROXIES` is three different numbers in the repo** (default 1, `.env.prod.example` 2, Railway docs 3) and nothing under `infra/railway/` sets it; the production value lives only in the Railway dashboard and in prose.
5. **The 08-21-evening gate ran with Gotenberg down:** "1051 passed, 14 skipped" means the ten Gotenberg conversion tests were skipped, not passed (the commit message itself records restarting the drifted container afterwards). The earlier full-stack figure, 1061/4, is the real baseline.
6. `frontend/nginx.conf` and `infra/railway/nginx.railway.conf` drop every security header on the `@api_unavailable` 503 (its own `add_header` replaces the inherited set) — the one location the "every location" claim misses. Low risk (JSON body), but the claim is not literally true.

---

## 2. Phase-by-phase validation

Method for each phase: read the phase doc's acceptance criteria and PROGRESS's ticks; locate the cited artefact in code; run what could be run here. "Criteria" counts ticked `[x]` / `[~]` as PROGRESS records them; the **verdict** is this audit's.

| Phase | PROGRESS status | Criteria (x/~) | What this audit checked | Verdict | Open gaps (real, not record) |
|---|---|---|---|---|---|
| 0 Foundation | ✅ 2026-07-19 | 7/0 | Stack files, `infra/*.sh` present; `noop_sleep` still defined (`apps/jobs/tasks.py:24`, routed `base.py:245`), enqueued by nothing since L1; ruff/mypy/`ng lint` gates now exist in `infra/test.sh`; no `.github/` CI | ✅ holds | `noop_sleep` dead-but-kept (queue row, deliberate); no CI of any kind |
| 1 Documents & viewer | ✅ 2026-07-19 | 6/0 | Ingest/content/thumbnail/versions code + tests present; versions endpoint paginated with "Show older"; viewer draws **live** (Verified, canvas sampled) | ✅ holds | Still **no e2e assertion that a page drew** (zero `getImageData`/`pageRendered` hits in `e2e/tests`) — queue row open |
| 2 Page organization | ✅ 2026-07-19 | 5/0 | 14 page ops in the registry; `extract_pages` `separate` (`engine/pages.py:248 extract_pages_each`, schema :45–49); `page-spec.ts` parser; `/organize-pdf` now lands on the grid (Verified live) | ✅ holds | — |
| 2B Anonymous access | ✅ 2026-08-01 | 12/0 | `principals.py` gate test, guest isolation tests, `MAX_PAGES` at ingest, tool pages; `POST /api/guest/session/` → 201 + `x-guest-token` header + `private, no-store` (Verified live); `/api/config/` advertises the guest tier (Verified live) | ✅ holds | — |
| 3 Annotations | ✅ 2026-08-01 | 5/1 | 14-type round-trip test, batch test, overlay + comments code; text box rework on `main`; live audit of 08-21 read all 14 types back from the file | ✅ holds | `image_stamp` has no active palette state (observation in the 08-21 report, untracked) |
| 4 Content editing | ✅ 2026-08-02 | 6/0 | 17 ops in registry; pixel-diff criterion replaced with property assertions, recorded; OCR CTA enabled by P6 (`onOcrRequested`) | ✅ holds | — |
| 5 Forms | ✅ 2026-08-02 | 5/0 | `engine/forms.py`, 6-type builder test, XFA fixture, `[(formData)]` fill path | ✅ holds | Unsaved form work not autosaved on navigation (queue row, open) |
| 6 OCR, conversion, compare | ✅ 2026-08-02 | 5/1 | `SUPPORTED_LANGUAGES = (eng, heb, deu, fra, spa)`; 6 export formats; urlguard 35 tests; 10 Gotenberg tests skip without the container | ✅ holds | DNS rebinding accepted (M6, open by decision); compare summary copy "4 of 2 page(s) differ"; veraPDF not implemented (recorded) |
| 7 Security & redaction | ✅ 2026-08-02 | 5/1 | AES-256/R6 path, `only: []` semantics, `raw_text_bytes()` grep, per-document password meter in 10 s buckets | ✅ holds | `record_password_failure` incr-then-set can lose a count (queue row, still present at `limits.py:376–383`) |
| 8 E-signatures | ✅ 2026-08-02 | 6/1 (its DoD row says 5/2) | All 62 esign + isolation-sweep tests pass here **once the dev `.p12` is reachable** (they fail in any environment where `/certs/zenpdf-dev.p12` is absent — a fixture-path coupling, not a product defect); `/verify` whole-file coverage; keyed audit chain | ✅ holds in code; **unusable in production** | **SMTP off ⇒ multi-party signing cannot run in production; the production certificate has never sealed a document (H1, launch-gating, still open).** `_append_to_source_document` still best-effort with only a log line |
| 9 Ads & abuse | ✅ 2026-08-02 | 6/1 | `ads.enabled:false` + no client id in live `/api/config/`; `/ads.txt` honest empty state live; consent tz rule; throttle matrix tests | ✅ holds | Consent decline = no ads, not NPA (recorded deviation); AdSense account/CMP/legal review are owner items |
| 10 Hardening & release | 🟠 since 2026-08-02 | 1/5 + 1 GATE (its DoD row says 2/4 + 1) | `logging.py` correlation middleware, `/api/health/live`, Sentry inert, admin deny-when-unconfigured, deletion + export endpoints, runbooks, `infra/perf/`, a11y spec (3 tests), hostile corpus; launch checklist has **zero ticked boxes**; `v1.0.0` untagged | 🟠 **correct** | Clean-VM compose deploy criterion is unmeetable as written (production is Railway); Lighthouse on the deployed build, p95 on the host, 3 nightly runs, restore drill, recycle drill, screen-reader pass, legal reviews ×3 — all still owed |
| 11 AdSense review | ⬜ | 0/12 | No `/contact`, no guides, `SITE_URL` still the Railway host, footer 5 links (code + live 404s) | ⬜ **correct** | Gated on the owner buying a domain (P1); 11B/11C are implementable before that |

**Retrofits and fix rounds since Phase 10** (each verified on `main`): UI redesign 2026-08-06 (design contract + tokens); compact landing 2026-08-10; extract/delete page selection + `separate` 2026-08-18/19 (PR #14, #15); UI audit 2026-08-20/21 — `ApiCacheControlMiddleware` (`apps/core/middleware.py:13`, registered `base.py:56`), `GUEST_RETRIED` replay (`auth.interceptor.ts:23,96,112`), `[useInlineScripts]="false"` (`workspace.html:254`, `forms.html:266`), `.mjs`/`.wasm` types in both nginx confs, annotate text box + undo/redo, version-level Undo (PR #17, #18); follow-ups 2026-08-21 — `flex-wrap` on seven pane toolbars, `organize: { mode: 'organize' }` in `tool-page.ts:368`, `view`/`organize` accepted by `workspace.ts:197` (PR #19, **live**).

---

## 3. Discrepancies between the record and reality

Ordered by how much they would mislead the next reader. "Record" = PROGRESS.md unless named.

### 3.1 PROGRESS.md contradicts itself

| # | Where | Says | But | Fix |
|---|---|---|---|---|
| 1 | Phase-10 section, :61, :63, :64 — labelled at :93 as "Phase 10's **live** DoD status" | "there is no deployed host yet"; "the prod-shaped stack needs the host"; "Performing them needs a VM and credentials" | Production has been live since 2026-08-08 (:1193–1216, `docs/ops/railway-deploy-report-2026-08-08.md`); auto-deploy since 08-10 | Rewrite the four `[~]` criteria against the Railway host: Lighthouse and p95 are *runnable now*; "clean-VM compose deploy" should be re-scoped to "Railway deploy performed 08-08; restore drill still owed" |
| 2 | :93 DoD row 3 | "backend **988 passed / 4 skipped**, frontend **178**, e2e **58**" | Same file: 1052/209 (:1019), 1061/250 (:1165), 1051/258 (:1105), e2e 60 (59/60 at :1109) | Put the current figures in the live row and date them |
| 3 | :1129 (queue row resolution) vs :1111 / :1093 (same day) | `separate` failure = Playwright `check()` not taking | Root cause = Celery workers 10 days stale; `check()` works | The row now says both; the earlier verdict should be struck or marked superseded inline |
| 4 | :1135, :1137 (08-21 post-deploy entry) and `docs/review/2026-08-21-post-deploy-verification.md:339–341` | "The two fixes … are **not deployed** … exist only as `.zen-followups-2026-08-21.patch` on the Mac" | PR #19 merged 14:49 +03:00, auto-deployed, both fixes **verified live in this audit** | Add an addendum to both; the evening entry records the merge but not a live re-check |
| 5 | :1105 vs :1165 | "1051 passed, **14 skipped**" called "green first time" | 14 − 4 = 10 skips are the Gotenberg conversion tests (`test_convert.py:247,267,293[×8]`); the container was down (the same entry says it was restarted afterwards) | Re-run the suite with Gotenberg up and record 1061/4, or say explicitly that ten tests were skipped |
| 6 | Human review queue :1065 "Self-serve account deletion … there is no route" ⬜ | No route | `apps/users/urls.py:18–19` (`me/export/`, `me/delete/`), `views.py:132–188`, Settings "Your data" card (`settings.ts:190–210`), legal copy already says "Settings → Your data" (`legal-page.html:119–124`, :183–187); `test_privacy.py` 10 tests | Mark ✔ resolved 2026-08-02 (Phase 10) |
| 7 | Human review queue :1088 (`base_version_seq` race) | "the mode components … emit a bare `(saved)` and would each need to carry it" | They all emit `output<Job>()` and pass the job (`convert.ts:159`, `sign.ts:146`, `protect.ts:370`…); `workspace.html:109–161` binds `(saved)="onXSaved()"` **without `$event`** and every handler just calls `viewer.reload()` (`workspace.ts:537–607`) | Re-point the row at the receiver; the fix is one file |
| 8 | :1009 (L8) "Job tracking piped through `takeUntilDestroyed` in workspace, tool-page, dashboard, edit and forms" | Done | Their `track()` paths are piped, but bare job subscriptions remain at `tool-page.ts:320`, `dashboard.ts:181,190,201`, `workspace.ts:637` — plus the five panels the open row at :1028 names (`convert.ts:105,116,148`, `annotate.ts:604,642,685`, `compare.ts:102`, `protect.ts:188,206,233,353,392`, `sign.ts:141`) | One sweep, one row |
| 9 | :511 "`tool-pages.ts:270,307,844`" | Line numbers | Now :274, :311, :848 | Cosmetic |
| 10 | :199 "`compare.facade.spec.ts` (9 tests)"; :1004 "`workspace-error.spec.ts` (3)"; :1014 L13 "(4)"; :267 `test_a_batch_of_thirty_is_one_pass`; :299 `..._boundary_accepts_exactly_the_limit`; Phase-8 DoD "5 ticked, 2 `[~]`" vs its own list (6/1); Phase-10 DoD "2 ticked, 4 `[~]`" vs its list (1/5) | Counts/names | 8 `it()`; 5 `it()`; 5 cases; real name `…_and_well_under_five_seconds`; real name `test_max_pages_boundary_accepts_exactly_the_limit`; the lists are right, the DoD rows were not updated when criteria were upgraded | Cosmetic |

### 3.2 Code-level findings that no row tracks

| # | Finding | Evidence | Severity |
|---|---|---|---|
| 11 | `NUM_PROXIES` inconsistency | `base.py:190` default 1; `infra/.env.prod.example:35` 2; `docs/ops/railway.md:101` 3 ("measured"); `infra/railway/*` sets nothing; `01-architecture.md` §19 never lists it | Medium — a redeploy from a fresh Railway project would get 1 (per-IP throttles collapse, the QA H1 failure) unless someone remembers the dashboard value |
| 12 | `@api_unavailable` drops the security-header set | `frontend/nginx.conf:87–91`, `infra/railway/nginx.railway.conf:59–63`: only `Retry-After` is added, so CSP/HSTS/nosniff/frame-ancestors are absent on the 503 | Low (JSON body; HSTS is cached from earlier responses) — but the "every location" claim at :75 is false for this one |
| 13 | The esign suite is coupled to the Docker mount path | 14 tests fail wherever `/certs/zenpdf-dev.p12` is absent (`base.py:399` default); `SIGNING_CERT_PATH=infra/certs/zenpdf-dev.p12` makes them pass | Low — but every sandbox/CI run outside compose reports 8 F + 6 E that look like seal breakage |
| 14 | Gate tooling silently passes with Gotenberg down | 10 `needs_gotenberg` skips (item 5) | Low-medium — same class as the stale-worker hazard the 08-21 row opened |
| 15 | e2e `phase-2b.spec.ts:130–159` unchanged; still drives the radio with `page.check()` | The row was closed on the stale-worker finding, which is right; the spec itself was never wrong | None — recorded so nobody "fixes" it |
| 16 | `tool-page.ts:616–627 reset()` keeps `extractMode` sticky across "Do another one" | Comment at :622–624 says it is intentional | None — disclosure |
| 17 | The design contract's grounding still says "exactly two sanctioned additions" (`design-instructions.md:5`, :295) | Undo and Undo/Redo were added 2026-08-20 (:185, :220); Phase 11's banner (phase-11 :28–31) repeats the stale count | Low — contract hygiene; Phase 11 must amend this sentence anyway |
| 18 | `AGENTS.md:3` names `PROGRESS.md` as if at the root and `docs/review/` (about to move); `AGENTS.md:13` points at `docs/design/claude-design-prompt.md`, which does not exist | Paths | Low — agent-facing; fixed by the rename commit |

### 3.3 Things PROGRESS says are open that are genuinely open (confirmed in code — nothing silently fixed)

`noop_sleep` dispatched by nothing · five panels + four stray bare subscriptions (items 8) · thumbnail retry without backoff (`pdf-thumbnail.ts:102–105`, `:132–135`) · `record_password_failure` race (`limits.py:376–383`) · DNS rebinding in `urlguard.py:151–157` → Gotenberg gets the hostname (`convert.py:273–276`) · deny-list drift check only in `infra/test.sh:15–45` · concurrency race unprovable on SQLite (`documents/views.py:106–128`; `--pg` runs only `test_performance.py`) · `usage_recompute` absent (zero hits; beat schedule `base.py:259–320` has eleven entries, none a reconciler) · `_append_to_source_document` best-effort (`esign/tasks.py:256–261`) · no page-drew assertion in e2e · phone workspace is a stack (`styles.scss:753–769`) · sign-request documents survive trash purge forever (`esign/models.py:129–130` PROTECT; `core/tasks.py:260–296` retries nightly) · account-side `uploads/…` assets have no sweeper (`purge_principal_assets` runs only on guest purge and account deletion) · `phase-3:43` known flake (`version_conflict` race) · type-aware ESLint not adopted.

---

## 4. Checks, as pre-registered

**R — Repo & deploy identity**

- **R1 `origin/main` identity — PASS (Verified).** Criterion: HEAD of `refs/heads/main` on GitHub equals the commit the record calls deployed. Evidence: `git ls-remote origin` at 11:50 UTC → `dacf623`; at 12:04 UTC → `df6afb9` (PR #19). The record's "deployed" commit changed under the audit; the later one is what was audited.
- **R2 Local tree — PASS (Verified).** Mac `.git/HEAD` → `refs/heads/main` = `df6afb9` = `origin/main`; reflog: `am` at 11:30, `commit` 11:48:40, `checkout main` + `pull --ff-only` 11:49:07 UTC; no `index.lock`; the local `fix/followups-2026-08-21` branch was deleted after merge; `.zen-followups-2026-08-21.patch` is gone from the root and archived at `docs/archived/2026-08-21-followups.patch`.
- **R3 No `v1.0.0` — PASS (Verified).** `git tag` → none; `git ls-remote --tags origin` → none.
- **R4 Production serves `main` — PASS (Verified).** `curl https://zenpdf.up.railway.app/` → `main-5K2QWJDV.js`, `styles-PJ5P6VJ3.css`, `last-modified: Fri, 21 Aug 2026 11:49:22 GMT`; `sha256(main-5K2QWJDV.js)` from production = `320ea10e1dc4b15e6d877222b1ee3f136d6d4d3b09bf0ee4a6091fdf09c09d56` = sha256 of `dist/zenpdf-web/browser/main-5K2QWJDV.js` from `npm run build` at `df6afb9` in this sandbox.

**P — PROGRESS claims vs code**

- **P1 Cited tests exist — PASS (Verified).** 172 pytest names (169 exact, 2 truncated citations, 1 helper), 44 spec files, 49 quoted titles — all found; no MISSING. Systematic shorthand: e2e files cited as `e2e/phase-N.spec.ts` live at `e2e/tests/phase-N.spec.ts`; titles are cited without their `phase N:` / `@smoke` prefixes.
- **P2 Cited paths exist — PASS (Verified).** 261 paths resolved; the only non-resolving ones are explained in the file itself (deleted by design, off-repo, build output) or are not paths (MIME types, npm packages, branch names). One stale line-number citation (item 9).
- **P3 Registry — PASS (Verified).** 47 ops; `extract_pages` schema has `separate`; `redact` and `compress/merge/alternate_mix/ocr/convert_*/compare/repair` on `heavy`; `METERED_OPS = {ocr, convert_from, convert_to, compare}` at `core/limits.py:26`.
- **P4 Tool pages / routes — PASS (Verified).** 24 slugs; 29 prerendered routes; sitemap 29 (repo) and 29 (live); `verify:prerender` green.
- **P5 Backend suite — PASS with environment caveats (Verified run; Inferred full-stack figure).** First run: `16 failed, 1029 passed, 14 skipped, 6 errors in 105 s`. With `SIGNING_CERT_PATH=infra/certs/zenpdf-dev.p12`: the 14 esign/isolation failures pass (`test_sign_api.py` + `test_finalize_resume.py` + `test_isolation_sweep.py` → 62 passed). Residual 7: `test_pdfa_export_claims_conformance`, `test_pdfa_output_probes_clean_and_claims_conformance` (`Could not find program 'gs'`), `test_the_worker_image_ships_the_five_language_packs`, `test_hebrew_is_recognised_and_comes_back_readable`, `test_deskew_and_clean_are_accepted` (tesseract here has `eng`+`osd` only, no unpaper), `test_the_operational_detail_is_for_operators` (`KeyError: 'queues'` — no Redis), `test_the_admin_gate_cannot_be_opened_with_a_header` (admin URLconf environment). Each is an absence in this sandbox, not in the code; the 08-21 CLI run on the full stack reports 1061/4 and the 08-21 report's sandbox baseline was the same 1029 — consistent.
- **P6 Frontend suite — PASS (Verified).** 258/258 in 38 files.
- **P7 Lint — PASS (Verified).** ruff, mypy (173 files), `ng lint` all clean.
- **P8 e2e count — PASS (Verified count; runs Unverified).** 60 tests: phase-0 2 · 1 1 · 2 1 · 2b 4 · 3 5 · 4 6 · 5 4 · 6 8 · 7 9 · 8 5 · 9 10 · 10-a11y 3 · 10-debt 2. `retries: 0`, `workers: 1`.
- **P9 Migrations — PASS (Verified).** 22 project migrations: core 4 (→`0004_emailsuppression_email_hash`), documents 5 (→`0005_partial_library_indexes`), esign 6 (→`0006_finalize_is_resumable`, with the `RunPython` backfill M4 promised), jobs 5, users 2.
- **P10 Beat schedule — PASS (Verified).** Eleven entries (3 heartbeats, reap-stalled-jobs, guest-purge, exports-purge, sign-reminders, sign-expirations, job-params-purge, jobs-purge, trash-purge); **no `usage_recompute`**, as the record says.
- **P11 Open queue rows still open — PASS with two stale rows (Verified).** §3.3 for the confirmed-open list; items 6–7 for the stale ones.
- **P12 QA findings H1–L14 — PASS (Verified).** Every "Change" and "Test" artefact in the 2026-08-04 table exists at the named place (e.g. `test_client_ip_topology.py` 6 tests; `_save_new_version` page cap + `_PAGES maxItems 10000`; `header_dimensions` before `fitz.Pixmap` in `engine/signatures.py:42–57`; `doc_lock` raises `locked`; `_finalize_tail`; `safe-next.ts`; `prod.py:18–20` refuses `ALLOWED_HOSTS=*`; no `DemoJobView`, no `debug_task`). M6 correctly recorded as not fixed.
- **P13 Phase-10 "What shipped" — PASS (Verified).** All artefacts present (§2, Phase 10 row). One qualification: item 12.
- **P14 Phase 11 not started — PASS (Verified, code + live).**
- **P15 `docs/review/` references — PASS (Verified).** Seven occurrences repo-wide: `AGENTS.md:3`, `PROGRESS.md:852`, `PROGRESS.md:1117`, and four inside the archived patch `docs/archived/2026-08-21-followups.patch` (historical, left as is). The first three are updated with the rename in this change.
- **P16 Page-tools + UI-audit changes on `main` — PASS (Verified).**
- **P17 Follow-ups — PASS, and now on `main` (Verified).** `git diff dacf623..df6afb9` touches exactly the seven pane templates, `tool-page.ts`, `workspace.ts`, the new `tool-page-order.spec.ts` (8 cases), the design contract, PROGRESS and the archived patch.

**L — Live production (all Verified, 12:00–12:27 UTC)**

- **L1 Health — PASS.** `{"status":"ok","checks":{"db":true,"redis":true,"storage":true,"gotenberg":true,"workers":true}}`.
- **L2 MIME — PASS.** `/assets/pdf.worker-6.0.1169.min.mjs`, `/assets/viewer-6.0.1169.min.mjs` → `text/javascript`; `/assets/wasm/openjpeg.wasm` → `application/wasm`.
- **L3 API caching — PASS.** `GET /api/config/` 200 `cache-control: private, no-store`; `GET /api/documents/<zero-uuid>/` 404 `cache-control: no-store`; `POST /api/guest/session/` 201 `private, no-store`.
- **L4 Security headers on `/` — PASS.** CSP (`default-src 'self'; … frame-ancestors 'none'; … script-src 'self' 'wasm-unsafe-eval'`), HSTS `max-age=63072000; includeSubDomains`, `nosniff`, `X-Frame-Options: DENY`, `referrer-policy: same-origin`, Permissions-Policy.
- **L5 SEO files — PASS.** `/ads.txt` renders the honest "No sellers are authorised yet" state; `robots.txt` allows `/` and disallows `/app/`, `/s/`, `/api/`, names the sitemap; `sitemap.xml` 29 `<loc>`.
- **L6 = R4 — PASS.**
- **L7 `/contact`, `/guides` — PASS (both 404).**
- **L8 Guest mint — PASS.** 201, `x-guest-token` header present, body carries `expires_at`, `seconds_remaining: 86399`, guest limits.
- **L9 Follow-ups live — PASS** (moved from Inferred to Verified by driving the site through a local transparent proxy with Chromium): `/organize-pdf` + upload → `/app/doc/<id>?mode=organize`, `[data-test=organize-page]` count 3, `ngx-extended-pdf-viewer` count 0, `aria-pressed=true` on "Organize"; at viewport 390×844 with device emulation **off**: `scrollWidth`/`visualViewport.width`/`innerWidth` = 390/390/390 in all nine modes. A first pass loaded nine modes in quick succession and tripped the guest throttle (429s in the console — the 40/min guest limit doing its job), so the canvas check was repeated in a fresh context: **1041×1473, 7 distinct colours, zero console errors**.

**D — Documents:** §6.

---

## 5. The real remaining work

Derived from the verified gaps, not from the plan's wish list. Engineering items are what the accompanying `handoff-to-cli-*.md` prompts implement; owner items cannot be done by an agent.

### 5.1 Engineering (agent-executable, in recommended order)

1. **Record reconciliation** — PROGRESS self-contradictions (§3.1), README status line and index, AGENTS.md paths, `docs/ops` H1–H3 closure and Railway-ization of the compose-only runbooks, QA report/remediation prompt marked historical, design-contract grounding sentence, `01-architecture.md` §4 (`infra/railway/`, `docs/`) and §19 (`NUM_PROXIES`, `CACHE_URL`, `SIGNING_CERT_B64`, `API_BASE_URL`).
2. **E2E and gate hardening** — the page-drew assertion (e2e + production smoke); `infra/test.sh --e2e` restarts the workers (stale-worker hazard); the gate refuses to call itself green while Gotenberg-dependent tests are skipped; `@quarantine` actually excluded; `SIGNING_CERT_PATH` resolved relative to the repo for non-compose runs; the `phase-3:43` `version_conflict` flake fixed at the source (item 7 — take the new `seq` from the job the `(saved)` already carries).
3. **Workspace debt batch (frontend)** — `takeUntilDestroyed` sweep (item 8); thumbnail backoff honouring `Retry-After`/429; `image_stamp` active-state in the palette; compare summary copy; `tool-page.ts` stray subscriptions.
4. **Backend debt batch** — `record_password_failure` with `cache.add` + `incr` (or Lua); surfaced notice when `_append_to_source_document` declines; `usage_recompute` reconciler agreeing with purge/claim semantics (§15); account-side `uploads/…` sweeper; the concurrency race proven under `--pg`; `@api_unavailable` header set; `NUM_PROXIES` written into `infra/railway/` and §19.
5. **Phase 11 (pre-domain half)** — 11B `/contact` + About identity + `SUPPORT_EMAIL`, 11C twelve guides + `/guides` index + SEO artefacts + floors + tool-page top-up, contract amendment at the four sites, `§21.6` amendment; 11A parameterised behind `SITE_URL`/env so the cutover is a one-line change when the domain exists.
6. **Mobile workspace design** — drawers + persistent bottom bar below `md`, specced into the contract first (gap rule), then built; replaces the "stacked" rescue.
7. **Type-aware ESLint** — the typed `apiError()` helper at ~28 call sites, `no-floating-promises`, `no-misused-promises`.
8. **Launch-gate evidence the agent can produce** — Lighthouse on the deployed build (landing; dashboard needs a session), three consecutive full e2e runs recorded, `@smoke` vs production on a schedule, `infra/perf/` against production once `PERF_EMAIL` exists.
9. **H1 — prove the production certificate seals** — the existing prompt in `docs/ops/railway-handoff-claude-cli.md`, run on the Mac with the prod `.p12`; record the verdict in PROGRESS and tick/untick the checklist line.

### 5.2 Owner-only (blocking launch or Phase 11)

- **SMTP on or off for launch** — multi-party signing is unreachable until on; H1 cannot be exercised in production without it (locally it can — item 9).
- **Custom root domain purchased** (Phase 11 P1) → Cloudflare session, Railway custom domains + TXT, Search Console.
- **Legal reviews ×3** (Privacy, Terms, e-sign disclosure — GATE rows) including the AdSense cookie-disclosure check.
- **Railway dashboard session:** `TSA_URL` (the docs disagree on whether it is set — Unverified here), storage-volume backup schedule, `SENTRY_DSN`, the worker recycle drill, the restore drill (needs a token).
- **Certificate decision** recorded in the checklist (stay self-signed for v1, or buy one).
- **Five-minute viewer checks** (Acrobat/Preview) for annotations, filled forms, permissions, a sealed envelope; ten minutes signing from a real phone; the twenty-minute screen-reader script.
- **Skim the twelve guides** before any AdSense submission; decide the ad-revenue sanity check.
- **Tag `v1.0.0`** only when the checklist has no unticked box.

---

## 6. Document catalogue

Every file under `development-plans/` and `docs/` was read. Status: **CURRENT** · **PARTLY-STALE** (true in substance, specific statements outdated) · **SUPERSEDED** (executed/replaced; should say so) · **STALE**.

### 6.1 `development-plans/`

| File | What it is | Last amended | Status | Specific stale statements |
|---|---|---|---|---|
| `PROGRESS.md` | Canonical tracker | 2026-08-21 (evening) | PARTLY-STALE | §3.1 above; runbook list at :79 omits `railway.md`, `secrets.md`, `dependencies.md`; :1078 clean-VM row ⬜ although a production deploy exists |
| `README.md` | Index + locked decisions | header says 2026-07-31; row added 2026-08-10 | **STALE** | :3 "Status: In implementation (Phases 0–2 complete)"; :25 prompt-2b "run this next"; :26 prompt-2 "blocked until 2B lands" (its own banner says superseded); no row for `prompt-3` |
| `00-research-findings.md` | Research digest | 2026-07-19 | PARTLY-STALE | :59 "B-T by default" (B-B unless `TSA_URL`); :73 reportlab 5.0.0 (4.4.4); :74 `signature_pad` (not used) |
| `01-architecture.md` | Normative reference | 2026-08-19 (§10) | PARTLY-STALE | :23 `signature_pad`, :43 reportlab 5.0.x; §4 names `infra/docker/{worker.Dockerfile,nginx.conf}` (absent) and omits `infra/railway/`, `docs/`; :308 "page cap not implemented" never retired; §19 lacks `NUM_PROXIES` and every Railway variable; no mention of the deploy target |
| `02-feature-matrix.md` | Feature → phase map | 2026-08-01 | CURRENT (as a map) | :105 repair = pikepdf (code: PyMuPDF `validate.py:78`); :128 `signature_pad` |
| `phase-00` … `phase-09` | Work orders | 2026-08-01 (banners) | SUPERSEDED (executed) | Only 00/01/02b/08/09 carry retrofit banners; none says "executed, see PROGRESS". Known drifts: phase-00 :37 `@angular/eslint` (never existed); phase-03 :46 PDF.js text layer (server `text-words` shipped); phase-04 :43 pixel-diff; phase-05 :14 "PyMuPDF cannot create Sig fields" (it can); phase-06 :26 repair via pikepdf, :29 compare as export; phase-07 :21 OCG flatten (deletes instead); phase-08 :33 B-LT, :42 flat `/verify` shape; phase-09 :19 `infra/docker/nginx.conf`, :22 NPA on decline, :35 admin IP-gated in prod (it is off) |
| `phase-10-hardening-release.md` | Work order | 2026-08-01 | PARTLY-STALE | :34/:42 clean-VM compose deploy unmeetable (Railway); :32 `@full` tag (none exists); :35 tag v1.0.0 (untagged) |
| `phase-11-adsense-review.md` | Work order | 2026-08-10 | CURRENT (not started) | :28–31 "exactly two sanctioned additions" (now four); :78–80 P3 satisfied; intro/FAQ counts "measured today" (08-10) unverified since |
| `prompt-1`, `prompt-2b`, `prompt-3` | One-shot agent prompts | 2026-07-19 / 08-01 | SUPERSEDED — **no banner** | prompt-3 :9 "Re-runnable by design: paste this same prompt into a fresh session" would now be harmful; prompt-2b :20 "`.git/index.lock` present right now" |
| `prompt-2-phases-03-07.md` | One-shot prompt | 2026-08-01 | SUPERSEDED — banner present | :7 "Unblocked … add §21 to the reading list" still reads as an instruction |

### 6.2 `docs/`

| File | What it is | Last amended | Status | Specific stale statements |
|---|---|---|---|---|
| `09-adsense-readiness.md` | Owner AdSense checklist + networks | 2026-08-10 | PARTLY-STALE | Done-but-unticked: :35–39 public content, :51–53 `/ads.txt`; :75–76 "phase 10 owns turning CSP on" (CSP is on; production policy is `infra/railway/nginx.railway.conf`) |
| `09-storage-hygiene.md` | Dormant/oversized policy + admin actions | 2026-08-02 | PARTLY-STALE | :30–40 ban / trash "in Django admin … IP-gated in production" — admin is **off** in production (`/admin/` 404), so neither action is reachable; compose-only command |
| `10-accessibility-screen-reader-script.md` | 16-step VoiceOver/NVDA script | 2026-08-02 | CURRENT | Needs the local stack + Mailpit (SMTP off in prod) and does not say so; never executed |
| `10-launch-checklist.md` | Owner GATE | 2026-08-02 | PARTLY-STALE | **Zero boxes ticked**, although several are de facto satisfied (env vars, CSP verified 08-10, fresh `SECRET_KEY`, seed admin rotated, platform secrets); :20 names `frontend/nginx.conf` as "the policy" (production's is the Railway conf); cert decision exists in `RAILWAY-SECRETS.md` but is unticked |
| `user-guide.md` | Tool-by-tool guide | 2026-08-02 | CURRENT | Every checked claim matches code (OCR languages, export formats, retention numbers, AES-256, compare grid). Gaps: describes sending sign requests without saying it is unreachable in production; never states the guest caps (25 MB / 300 pages / 200 MB / 5 metered ops/h); predates page selection, Undo, text box |
| `archived/2026-08-18-…patch`, `archived/2026-08-20-ui-audit.patch`, `archived/2026-08-21-followups.patch` | `format-patch` archives | — | SUPERSEDED (landed as PRs #14, #17, #19) | Archives; the last one carries four `docs/review/` strings (historical) |
| `archived/2026-08-20-ui-audit-prompt.md` | The prompt that landed PR #17 | 2026-08-21 | SUPERSEDED | :20 "`main` is at 00ccb52"; no executed banner inside the file |
| `design/design-instructions.md` | Design contract | 2026-08-21 (cf663e5: "In-pane toolbars wrap", :203, undated) | CURRENT, internally inconsistent | :5/:295 "exactly two additions" vs :185/:220 Undo; :193 five-link footer (Phase 11 will amend); no amendment log section |
| `design/2026-08-10-compact-landing.md` | Implemented proposal | 2026-08-10 | CURRENT | :78 references `compact-landing-mockup.html` (absent) |
| `design/mockups/*.html` (22) | Reference mockups | 2026-08-06 | PARTLY-STALE by design | Contract wins; 01/10 superseded by the compact landing; 04/05 predate Undo/panes |
| `ops/README.md` | Runbook index | 2026-08-02 | PARTLY-STALE | Omits the four Railway docs; compose-only commands |
| `ops/railway.md` | Railway ops | 2026-08-10 | PARTLY-STALE | :73 "Storage: external S3 … SeaweedFS on a volume works but you own the backups" — production **is** SeaweedFS on a 50 GB volume; :81 `ALLOWED_HOSTS` omits `healthcheck.railway.app`; worker command omits `--max-memory-per-child` |
| `ops/deploy.md` | Deploy runbook | 2026-08-10 | PARTLY-STALE | Railway section current; "After" steps are compose |
| `ops/release.md` | Suites & cadence | 2026-08-02 | PARTLY-STALE | "every commit to `main`" / "what CI runs" — there is no CI; `@quarantine` "excluded from the deploy gate" — nothing excludes it (`playwright.config.ts` has no `grepInvert`; `test.sh:106` runs bare) |
| `ops/rollback.md`, `ops/restore-drill.md`, `ops/queue-stuck.md`, `ops/storage-full.md` | Runbooks | 2026-08-02 | **STALE for the live target** | All compose-only; no Railway path (rollback = redeploy prior SUCCESS with the frozen-manifest trap; Postgres is managed; backups are volume snapshots); restore-drill RTO "_fill this in_" never filled |
| `ops/secrets.md`, `ops/cert-renewal.md`, `ops/dependencies.md` | Runbooks | 2026-08-02 | CURRENT | `.p12` is `SIGNING_CERT_B64` on Railway, not a file; next dependency pass due ~2026-09-02 |
| `ops/railway-deploy-plan.md` | Executed plan | 2026-08-07 | SUPERSEDED — no banner | `NUM_PROXIES=2` (measured 3); "`railway up`, not GitHub" (auto-deploy since 08-10); Hobby/$25–50/5 GB (Pro/$10–15/50 GB) |
| `ops/railway-deploy-report-2026-08-08.md` | Deploy evidence | 2026-08-10 | PARTLY-STALE | §8 lists H2/H3, gotcha 4 and auto-deploy as open — all since done |
| `ops/railway-handoff-claude-cli.md` | H1–H3 prompts | 2026-08-10 | PARTLY-STALE | :8 "three items could not be completed" — **H2 (`@smoke` vs prod: 4 passed, 2 environmental) and H3 (`test.sh --e2e`: 59/60 twice) were run on 2026-08-21**; only H1 is open; :122–124 "deployed tree is `d315b83`" |
| `ops/launch-handoff-owner.md` | Owner handoff 08-10 | 2026-08-11 | PARTLY-STALE | :50–72 viewer finding (fixed 08-20, confirmed live 08-21); :62–63 "e2e never run" (run 08-21); item list otherwise still the owner's |
| `review/ZenPDF-QA-Report.md` → `reviews/` | QA report 2026-08-03 | 2026-08-04 | SUPERSEDED — no banner | All findings but M6 implemented 2026-08-04; design items D1–D7 never tracked to resolution; `NUM_PROXIES` 1→2 framing |
| `review/IMPLEMENT-FINDINGS-PROMPT.md` → `reviews/` | Remediation prompt | 2026-08-04 | SUPERSEDED — no banner | Executed verbatim 2026-08-04 |
| `review/2026-08-21-post-deploy-verification.md` → `reviews/` | Production audit 26/28 | 2026-08-21 | PARTLY-STALE (same-day) | :339–341 "not deployed" and Finding 3's `check()` mechanism both superseded the same evening |

### 6.3 Cross-document contradictions (both sides quoted in the agent log; summarised)

1. Deployed host exists (PROGRESS :1193–, report) vs "no deployed host yet" (PROGRESS :61–64). 2. Test counts — six different figures across PROGRESS, QA report, deploy plan. 3. `NUM_PROXIES` 1 / 2 / 3. 4. Deploy model — `railway up` snapshot (plan, report) vs auto-deploy from `main` (railway.md, deploy.md, handoff). 5. Deployed commit `d315b83` (handoff, report) vs `dacf623` (08-21 report) vs `df6afb9` (now). 6. "H1–H3 open" vs H2/H3 done. 7. Viewer defect open (launch-handoff) vs fixed. 8. README status/index. 9. eslint "not configured" vs `angular-eslint` gated. 10. Admin IP-gated in prod (storage-hygiene, phase-09) vs admin off. 11. "Exactly two sanctioned additions" vs Undo. 12. CSP location / "phase 10 turns CSP on". 13. Storage "external S3" vs SeaweedFS volume. 14. `ALLOWED_HOSTS` healthcheck host. 15. Plan tier/cost/volume. 16. Rollback procedure compose vs Railway. 17. CI/cadence/quarantine. 18. Phase-10 deploy criterion. 19. `TSA_URL` set (plan) vs to be set (launch-handoff). 20. Follow-ups deployed or not. 21. `separate` mechanism. 22. Repair library. 23. `signature_pad`/reportlab pins. 24–26. QA report, remediation prompt and prompts 1/2b/3 executed but unmarked; AGENTS.md paths.

---

## 7. Scope limits

- **The e2e suite was not run here** (needs the Docker stack). Its 60-test count is verified; its pass rate is the CLI session's record (59/60 twice, different flake each time).
- **Backend tests needing Ghostscript, tesseract language packs, unpaper, Gotenberg or Redis** were not exercised (7 failures + 10 skips here). Their last full-stack evidence is the 08-21 CLI run (1061/4, morning) — the evening run skipped the Gotenberg ten.
- **Nothing requiring an account was tested on production** — library, folders, saved signatures, sign-request builder, settings, claim-on-signup, account deletion — and nothing that sends mail (SMTP is off). Multi-party signing and the production seal (H1) remain **unverified in production**; the seal path was verified only with the *dev* certificate in this sandbox.
- **Railway dashboard state** (`TSA_URL`, `NUM_PROXIES`, backups, volume size) could not be read: no token. All such statements are Inferred from the docs, which disagree on `TSA_URL`.
- **Per-IP throttling, Lighthouse, screen readers, print, PDF/A conformance, OCR accuracy, load behaviour** — out of scope.
- The live browser checks were made through a transparent reverse proxy (host header rewritten, body and headers otherwise untouched); MIME/cache assertions were made with direct `curl`, so they are not proxy artefacts. One throwaway document was uploaded as a guest and will expire with its session.
- This review was written by an agent in a cloud sandbox; the rename `docs/review` → `docs/reviews` and the new files were written to the owner's working tree **uncommitted** (see the first handoff prompt).

---

## Appendix A — checklist as pre-registered (verbatim)

R1 origin/main identity · R2 local tree vs record · R3 no v1.0.0 · R4 production bundle = `main` · P1 cited tests exist (≥98%) · P2 cited paths exist · P3 registry ops · P4 24 tool pages / 29 routes · P5 backend suite · P6 frontend suite · P7 ruff/mypy/ng lint · P8 e2e count · P9 migrations · P10 beat schedule, no `usage_recompute` · P11 open queue rows still open · P12 QA findings table · P13 Phase-10 artefacts · P14 Phase 11 not started · P15 `docs/review/` references · P16 page-tools + UI-audit on main · P17 follow-ups only on local branch (superseded mid-audit) · L1 health · L2 MIME · L3 cache headers · L4 security headers · L5 ads.txt/robots/sitemap · L6 = R4 · L7 /contact 404 · L8 guest mint · L9 follow-ups live at 390 px · D1 catalogue · D2 contradictions.

## Appendix B — commands that produced the evidence

```
git ls-remote origin; git fetch origin; git log --oneline origin/main -8; git tag; git ls-remote --tags origin
git diff --stat c9bed04 origin/main                       # docs-only delta between snapshot and main
cd backend && uv venv --python 3.13 .venv && uv pip install -r requirements/dev.txt
python -m pytest -q -o addopts=""                          # 16 F / 1029 P / 14 S / 6 E
SIGNING_CERT_PATH=$PWD/../infra/certs/zenpdf-dev.p12 python -m pytest -q -o addopts="" \
   apps/esign/tests/test_sign_api.py apps/esign/tests/test_finalize_resume.py apps/core/tests/test_isolation_sweep.py   # 62 passed
ruff check . ; mypy apps config                            # clean / 173 files
cd frontend && npm ci && npx ng test --watch=false         # 258 passed (38 files)
npx ng lint ; npm run build ; npm run verify:prerender     # clean / 29 routes / 24 tool pages
sha256sum dist/zenpdf-web/browser/main-5K2QWJDV.js ; curl -s https://zenpdf.up.railway.app/main-5K2QWJDV.js | sha256sum
curl -sI https://zenpdf.up.railway.app/{,api/config/,assets/viewer-6.0.1169.min.mjs,assets/wasm/openjpeg.wasm}
curl -s https://zenpdf.up.railway.app/{api/health/,ads.txt,robots.txt,sitemap.xml,contact,guides}
curl -s -D - -X POST https://zenpdf.up.railway.app/api/guest/session/ -H 'Content-Type: application/json' -d '{}'
node proxy.mjs (localhost:8787 → zenpdf.up.railway.app) ; node check.mjs ; node canvas.mjs   # playwright-core 1.58 + chromium-1194
```
