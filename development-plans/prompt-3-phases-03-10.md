> **Executed 2026-08-01/02 — kept as history. Do not run.** Phases 3–9 are ✅ and Phase 10 is 🟠 awaiting owner sign-off in `PROGRESS.md`. **In particular, ignore the "Re-runnable by design" line below** — it was true while the phases were being executed and is now the most dangerous sentence in this directory: a fresh session pasting this prompt today would find every phase already ✅, and the value of re-running is zero against the cost of an agent deciding otherwise. Resumption is what PROGRESS.md is for.

# One-Shot Prompt 3 — Execute Phases 3–10 (everything remaining) and ship each phase to `main`

**Usage:** start a Claude Code session with its working directory at the **ZenPDF repo root**, Docker daemon running, and `gh` authenticated (`gh auth status`). The session needs permission to run `git`, `gh`, `docker`, and to create/delete files. Paste everything below the line as the prompt (or run `claude "$(cat development-plans/prompt-3-phases-03-10.md)"`).

**Precondition:** Phases 0, 1, 2 and **2B** are ✅ in `development-plans/PROGRESS.md` (true as of 2026-08-01; baseline backend 232 / frontend 40 / e2e 7).

**This prompt supersedes `prompt-2-phases-03-07.md`** — it contains that prompt's phases 3–7 plus 8–10 and the per-phase PR workflow. Do not run both.

**Re-runnable by design:** if the session dies, hits limits, or halts on a blocker, paste this same prompt into a fresh session. The PROGRESS.md Update protocol guarantees resumption from the first non-✅ phase with zero re-done work — which also means you must keep PROGRESS.md and commits current *continuously*, not at the end.

---

You are an expert full-stack engineer executing a pre-approved, pre-reviewed development plan **autonomously, start to finish, without asking permission between steps**. Your mission: implement **Phases 3, 4, 5, 6, 7, 8, 9 and 10** of ZenPDF — annotations, content editing, forms, OCR/conversion/compare, security & redaction, e-signatures, ads & abuse controls, hardening & release — shipping each phase to `main` through its own reviewed pull request.

Work in this order. Do not skip steps. Do not ask me to confirm between steps.

---

## Step 0 — Preflight (once, before Phase 3)

1. **Starting state:** on `main`; `git fetch origin && git status -sb` shows no divergence. The working tree should be clean **except possibly this prompt file** (`development-plans/prompt-3-phases-03-10.md`, likely untracked — expected; item 5 commits it). `docker version` works; `gh auth status` authenticated. If `gh` is not authenticated, STOP and say so — the PR workflow cannot run without it.
2. **Read `development-plans/PROGRESS.md` top to bottom** before anything else. Hard precondition: Phases 0–2B are ✅. If they are not, or the tree contains half-finished work outside `development-plans/`, STOP and report — never re-implement completed phases, never start on someone else's uncommitted work.
3. **Baseline must be green before you change anything:**
   ```bash
   ./infra/up.sh && ./infra/test.sh --e2e
   ```
   Expected: backend **232 passed**, frontend **40 passed**, e2e **7 passed**. If the ONLY failure is the known `e2e/tests/phase-2.spec.ts` flake (next item), fix it and re-run; any other red = 🟡 Blocker in PROGRESS.md, STOP.
4. **Kill the known flake first (pre-approved fix).** The Human review queue (2026-08-01) documents it: `phase-2.spec.ts`'s delete step races `viewer.reload()` → `pages.clear()`, which can wipe the page selection between the rotate toast and the `op-delete` click, so `[data-test=confirm-ok]` never appears. The sanctioned fix is in the queue entry: re-assert the selection after the preceding toast (or wait for the reloaded organize grid) — a spec-only change. This suite is the merge gate for eight more phases; a known flake in it is unacceptable. Branch `fix/phase-2-e2e-flake`, fix, prove with 3 consecutive green runs of that spec, PR, merge, mark the queue item ✔ resolved.
5. **Housekeeping:** add a one-line banner at the top of `development-plans/prompt-2-phases-03-07.md`: "⚠ Superseded by `prompt-3-phases-03-10.md` (2026-08-01) — do not run." Commit that banner **and this prompt file itself** (untracked until now) directly on `main` with a `docs:` message, so the plan folder is coherent before Phase 3 branches off.
6. **Known environment facts** (from the Decisions log — honor them, never re-litigate):
   - This machine's `.env` overrides `API_PORT=8010`, `DB_PORT=15432` (an unrelated app holds 8000/5432). Do not "fix" ports; a clean machine gets the defaults.
   - `ng build` (browser + server bundles) can OOM-kill (exit 137) on the ~8 GB Docker VM while all 11 containers run. Workaround already recorded: stop `worker`/`gotenberg` containers during heavy builds, restart after.
   - Prerendering is a build artifact (`outputMode: static`): `ng serve` returns the SPA shell. "Is it server-rendered?" is asked of the build output — `npm run verify:prerender` asks it mechanically.
   - **There is no CI in this repo.** Your local `./infra/test.sh --e2e` run IS the merge gate; `gh pr merge` blocks on nothing. Treat it accordingly.

---

## Step 1 — Read the plan (in this exact order, fully)

1. `development-plans/PROGRESS.md` — canonical tracker. Follow its **Update protocol** literally for the whole session. Read the **Decisions log** (prior decisions bind you) and the **Human review queue** — note the GATE: *two Phase-2B acceptance criteria are carried into Phase 8* (guest `self_sign`; guest sign-request → `account_required`) and must be demonstrated there.
2. `development-plans/README.md` — locked decisions, dependency graph, phase order.
3. `development-plans/01-architecture.md` — **normative; wins every conflict** (fix the conflicting text in the same commit + Decisions entry). Closest attention: §6 API conventions/error shape, §7 frontend conventions, §8 coordinates, §9 data model (fields added only by amending it), §10 operation registry (signatures are law), §11–12 job pipeline/queues, §13 storage keys, §14 versioning, §15 email/beat, §16 tiers/quotas/`METERED_OPS`, §17 security, §18 testing, §20 Definition of Done (note item 9), **§21 access model (anonymous-first)**.
4. Work orders, in execution order: `phase-03-annotations.md` → `phase-04-content-editing.md` → `phase-05-forms.md` → `phase-06-ocr-conversion-compare.md` → `phase-07-security-redaction.md` → `phase-08-esignatures.md` → `phase-09-ads-and-abuse-controls.md` → `phase-10-hardening-release.md`.
5. `02-feature-matrix.md` for scope boundaries only: **BL/OUT items stay out.** No AI assistant. No billing/checkout code (`pro` stays config-only, admin-settable).

---

## Step 2 — Invariants from the 2B refactor (every phase, non-negotiable)

- **Ownership goes through `apps/core/principals.py` and nowhere else** — `owned_by(qs, principal)`, `owner_kwargs(...)`, `job_owner_kwargs(...)`, `principal_of(job)`, `created_by_user(job)`. A grep-based test fails the build on `request.user`, `job.user`, `owner=` or `context["request"].user` outside that module — including in *your new code*. Extend the allowlist only for genuinely non-ownership reads, with a comment; `test_allowlist_has_no_dead_entries` will delete stale exemptions.
- **`IsPrincipal` is the default permission.** Every new endpoint is guest-accessible unless it declares `IsAccount` — and anything account-only must carry a written reason in §21.3 (amend the doc in the same commit).
- **Limits live in `settings.TIERS`, resolved via `core.limits.for_principal()`.** Never hardcode a limit at a call site. In tests, override `TIERS` (helper: `test_ingest.tiers_with`), not the loose env constants.
- **`METERED_OPS` = {ocr, convert_from, convert_to, compare} and is NOT the `heavy` queue.** Never meter or CAPTCHA merge/compress/repair/alternate_mix — flagship tool pages stay frictionless (§16).
- **Every phase ships its public tool page(s)** by appending to `TOOL_PAGES` in `frontend/src/app/core/tool-pages.ts` — routes, prerendering and `sitemap.xml` are generated from that table and tests fail on drift. Copy: ~220–290 words of honest task copy + FAQ, unique title/meta/H1 (per the 2B precedent in the Decisions log). §20 DoD item 9: a tool that works only when logged in is an incomplete phase.
- **All geometry through `pdf_engine/geometry.py` (§8)** — never inline coordinate math. All ops match the §10 registry signatures exactly, with param JSON Schemas in `pdf_engine/schemas/`. Every mutation runs as a Job producing a new immutable version (§11, §14) — no in-place edits, ever.
- New beat tasks register per §15; new error codes use the §6 shape; new fixtures come with committed generation scripts.

---

## Step 3 — Per-phase delivery loop

For each phase N in **3 → 4 → 5 → 6 → 7 → 8 → 9 → 10**, strictly:

1. `git switch main && git pull`, then `git switch -c feat/phase-NN-<short-slug>`.
2. PROGRESS.md: set the phase 🔵 with date; copy its **Acceptance criteria** verbatim into a new phase section (protocol step 2). Commit.
3. Implement per the phase doc + the directives in Step 4. Small conventional commits (`feat(phase-N): …`, `test: …`) at green milestones. No TODOs, dead code, or skipped tests.
4. **Gate (all of it, before the PR):** every acceptance criterion ticked in PROGRESS.md **with one line of evidence each** (test name + count, command output, or e2e spec) — unproven ticks are forbidden; §20 DoD holds; fresh-stack proof `./infra/reset.sh --yes && ./infra/up.sh && ./infra/test.sh --e2e` fully green **including this phase's new `e2e/tests/phase-N.spec.ts`**; coverage gates hold (apps ≥85%, pdf_engine ≥90%); OpenAPI schema updated (`manage.py spectacular` — keep it at 0 warnings/0 errors); `ruff` + `manage.py check` clean. (`mypy`/`eslint` are known-unmet repo-wide per the Decisions log — Phase 10 owns them; until then don't burn time on them, but don't add *new* mypy errors beyond the pre-existing model-field class.)
5. PROGRESS.md: set ✅ with date, update the status table, record Decisions and Human-review items. Commit.
6. Push; open the PR with `gh pr create` — body sections: **What** (scope + spec pointers), **Verification** (the *real* fresh-stack numbers — never placeholders), **Notes** (decisions, queue items, "no CI — local run is the gate").
7. **Self-review before merging** (you are the only reviewer): read the entire `gh pr diff` as a reviewer, then spawn parallel subagents with distinct lenses — **security/isolation** (can any principal reach another's data? walk every new endpoint, worker paths, and public-token state machines; `assert_owned` 404s, never 403s), **correctness** (concurrency, idempotency, partial-failure paths), **plan conformance** (letter AND intent of the acceptance criteria; DoD item 9 honestly), **regression** (authenticated *and* guest behavior unchanged elsewhere). Fix everything real; re-run the suite; deliberately-unfixed findings go to the Human review queue with a reason.
8. `gh pr merge --squash --delete-branch && git switch main && git pull` — confirm the squashed commit landed and the tree is clean. Only then start the next phase.

**Never** merge red, force-push `main`, or weaken a test/criterion to pass a gate.

---

## Step 4 — Phase directives (execute with the phase doc open; these are reminders and traps, not the spec)

### Phase 3 — Annotations (`/annotate-pdf`)
- Build **`PageOverlayComponent` once, generically** — phases 4/5/7/8 extend it; never fork it. Production-quality interactions: selection handles, text-layer quads, ink smoothing, ESC/delete, zoom-independent normalized geometry.
- PDF-native annotations (real annots, Acrobat-interoperable); session batching → ONE `annotate_batch` job per Save/autosave; `NM` = client UUID; author = display name or **"Guest"** (never leak session id/IP into a shareable file).
- `flatten` via `Document.bake()`; custom image stamps: dual-path (appearance stream vs "flattened stamp") — **the golden test decides on day one**; record in Decisions log.
- Add the **RTL/Hebrew fixture** to the corpus (committed generator) with an explicit quads test.
- Also resolve the 2026-07-19 queue item: **migrate the crop tool from the margin dialog onto the overlay** (this is the "revisit in P3" it names); mark it resolved.

### Phase 4 — Content editing (`/edit-pdf` `/watermark-pdf` `/add-page-numbers`)
- Text edit = redact-annot + `insert_htmlbox` + `subset_fonts`, block-scoped, with the `text_overflow` error contract (`details.fits_at_size` → shrink/enlarge/cancel UI). Honest fidelity constraints shown on first use.
- **Scanned-page gate:** editor blocked with "run OCR first" CTA — CTA ships *disabled* with tooltip "coming with OCR tool" until Phase 6 flips it on.
- `find_replace` is two-step: `dry_run: true` → review with checkboxes → execute with `only: [ids]`.
- Whiteout ≠ redaction — the UI copy states the difference (whiteout hides visually; Redact removes content).

### Phase 5 — Forms (`/fill-pdf-form`)
- Fill via ngx-extended-pdf-viewer `[(formData)]`; the sanctioned fallback (our overlay inputs from the read model) is decided **per field type** by test, recorded in Decisions.
- **Signature fields: PyMuPDF cannot create them** — route `type=signature` through pyHanko `fields.append_signature_field(SigFieldSpec(...))`.
- Add an XFA sample to the corpus: detected → warning banner, no crash. One `edit_form_fields_batch` job per builder Save.

### Phase 6 — OCR, conversion & compare (`/ocr-pdf` `/pdf-to-word` `/word-to-pdf` `/jpg-to-pdf` `/pdf-to-jpg` `/html-to-pdf` `/compare-pdf` `/repair-pdf`)
- These are the **`METERED_OPS`** — guest hourly caps + the Turnstile challenge apply here and *only* here (`CAPTCHA_ENABLED=false` in dev; tests exercise the adapter with a mock).
- Worker image ships tesseract language packs **eng+heb+deu+fra+spa**; Hebrew OCR is an acceptance criterion (owner locale).
- URL→PDF **layered SSRF guard**: API-side scheme allowlist + DNS-resolve-then-reject private/link-local/metadata ranges, AND Gotenberg `--chromium-deny-list` covering IP literals + internal hostnames (api, db, redis, storage, mailpit). The three refusal cases in the acceptance criteria must be proven by tests.
- Exports land in `exports/{job_id}/…` with the 24 h purge beat; flip the Phase-4 scanned-gate CTA to enabled; craft the compare fixture pair with a known injected change.

### Phase 7 — Security & redaction (`/protect-pdf` `/unlock-pdf` `/redact-pdf`)
- `encrypt`/`decrypt`/`set_permissions` via pikepdf AES-256 R6; accessibility permission **always true**; wrong password → `invalid_password`, throttled 5/min/doc.
- Session-password handling exactly as speced: `document_password` accepted by mutation ops, **redacted from API job-param responses and purged on completion** — prove it with a test.
- `redact`: dry-run review UI; per-preset regex unit table; post-verification re-extract step in the engine; `fork_clean_copy` **default ON** in the UI (the version-history leak is real); image-pixel redaction proven by pixmap test + raw-bytes grep.
- Fixtures: PII fixture (one string per preset: SSN/email/phone/credit-card/IBAN) + booby-trapped fixture (JS + attachment + metadata) for `sanitize`'s counted report.
- This completes the Phase-1 encrypted-document story: 423 → unlock flow, session password feeding subsequent ops without re-prompting.

### Phase 8 — E-signatures (`/sign-pdf` + public `/verify`) — **carries the 2B GATE**
- **Before this phase can be ✅, demonstrate the two carried 2B criteria** and tick them where they're tracked (2B phase section + Human review queue GATE): (a) a guest completes `self_sign` end-to-end from `/sign-pdf` using **`signature_upload_ref`** (ephemeral blob at `sigs/guest/{session}/{ref}.png`, purged with the session) — e2e-proven with zero login prompts; (b) `POST /api/sign-requests/` as a guest → 403 `account_required` (the send path is account-only, §21.3).
- 8A: saved signatures (draw/type/upload; 4 cursive fonts **vendored in the repo**, rendered server-side) are account-only; guests sign with the ephemeral path. Self-sign in <4 clicks.
- 8B: request builder → frozen `source_version`; sequential/parallel/mixed routing; ceremony at `/s/:token` (AllowAny + tight throttle) with **unskippable consent** before any field write; decline/cancel/remind; reminders + expiry via beat (time-warped tests). **Viewer role: opening the document = completion** (pre-made decision — implement, don't re-debate).
- Finalize: burn fields → stamp envelope-code footer → **PAdES seal via pyHanko** (B-B without `TSA_URL`, B-T with) → `final_sha256` computed on the **sealed** bytes → reportlab certificate of completion → store, version "Signed", notify all. Idempotent (double-dispatch → one seal, proven).
- Dev signing cert: `infra/certs/` is gitignored — commit a **generation script** for a self-signed `zenpdf-dev.p12` (paths/password per §19) and wire it into `up.sh` when absent; never commit key material. `/verify` copy is honest about untrusted dev certs. Revisit the reportlab 4.4.4 pin here per the 2026-07-19 Decisions entry (keep or bump, with rationale).
- **ESIGN disclosure/legal text is a human gate:** write `/legal/esign-disclosure` yourself as a clearly-marked draft (versioned in repo; its hash recorded in audit metadata), and file a GATE queue item — **"owner must review ESIGN disclosure + legal text before public launch"**. The gate blocks *launch* (Phase 10 checklist), not this phase's engineering ✅.
- Monthly sign-request quota enforced via §16. Full Mailpit-driven e2e: 2 sequential signers + cc, tamper test flips `/verify` to invalid.

### Phase 9 — Ads & abuse controls
- **Read the rescope banner first** — throttles/Turnstile/TTL/tool pages already shipped in 2B; do not rebuild them. §16 is authoritative for tier numbers; the phase doc's old inline figures are marked superseded.
- Ads: `ADS_ENABLED=false` is the shipped default — the product must be fully launchable with zero ad code loaded (acceptance criterion). `AdSlotComponent` abstraction configured from `/api/config/`; three allowed surfaces only; **provably ad-free**: editor/viewer canvas, `/s/:token` ceremony, `/verify` (route-level tests). Reserved-height containers (CLS-safe), lazy script only when enabled AND consented, `ads.txt` from env.
- CMP: consent wiring + Consent Mode behind config; the consent flow must complete **for a guest** (primary audience). AdSense/CMP **account onboarding is owner-executed** — implement config-driven, document the readiness checklist, keep ads dark; do not block the phase on network approval.
- Legal pages (`legal/`): write real drafts (Privacy incl. actual retention numbers cross-checked against beat config **in a test**, ToS, E-sign Disclosure from P8); footer links everywhere incl. ceremony; signup ToS checkbox → `accepted_tos_at`. File one GATE queue item: **owner review of all legal content before launch**.
- Abuse (accounts only — **never guests, never uploads**): email verification before *sending sign requests*; remaining throttles per the phase doc's list (auth/upload/public-sign/verify) with `Retry-After`; `core.EmailSuppression` + `List-Unsubscribe` honored by every sender; report-abuse endpoint → 3 distinct reports auto-pause + owner notified; admin ban/soft-delete actions; usage panel in settings from `/api/users/me/usage/`.

### Phase 10 — Hardening & release — **ends 🟠, not ✅, unless the owner completes their items**
- No new features. Also owns the two queued repo-wide debts (2026-08-01): **enable the django-stubs mypy plugin** in `pyproject.toml` and fix the fallout (98 pre-existing errors), and **add `@angular/eslint`** (`ng add`) with a first cleanup pass — after this, §20's "lint clean" is finally real; keep both green in `test.sh`.
- Security: hostile corpus (PDF bombs, zip bombs, malformed TIFFs, outline recursion) with committed generators — workers must fail the job and recycle, never wedge; **isolation sweep re-run router-wide** (cross-user AND cross-guest) over every endpoint added since P1/2B, public sign tokens fuzzed (wrong state, replay, canceled); prod nginx CSP + headers per the doc; all user-content downloads `Content-Disposition: attachment` (HTML exports never render inline); `pip-audit`/`npm audit` clean-or-triaged with a written update runbook; account deletion + data-export endpoints.
- Performance budgets measured with committed scripts (Lighthouse targets, 100-page open, virtualized lists, locust smoke, `EXPLAIN` on the 6 hottest queries). Accessibility: WCAG 2.1 AA on OUR UI; axe-core in Playwright zero serious/critical; **keyboard-only + screen-reader ceremony pass** (the legally sensitive one) — script the manual check and record the run.
- Observability: structured JSON logs with request/user/job correlation, Sentry wiring behind `SENTRY_DSN` (api/worker/Angular, PII-scrubbed), `/api/health/` live-vs-deep split, worker heartbeat, runbooks in `docs/ops/`.
- Release: consolidate per-phase specs into tagged `@smoke` / `@full` suites; Playwright cross-browser projects (Chromium/Firefox/WebKit + mobile viewports for ceremony/dashboard); verify `infra/docker-compose.prod.yml` boots and passes `@smoke` locally; prepare the **Railway service mapping** (api, worker-default, worker-heavy, worker-render, beat, web, Postgres, Redis, Gotenberg; external S3) per the `railway-deployment` skill if it is available to you, as documentation + config — actual deploy is owner-executed.
- **Honest end-state:** everything above that a single local machine can prove gets evidenced and ticked. The rest — domain/DNS/TLS, SPF/DKIM/DMARC, real CA signing cert + TSA, AdSense/CMP onboarding, legal sign-offs, clean-VM/Railway production deploy, restore drill on real infra, 3 consecutive nightly `@full` runs — goes into a **Launch checklist (owner)** GATE entry in the Human review queue. If owner items remain (they will), set Phase 10 to **🟠 Awaiting human review**, do **not** tag `v1.0.0`, and say so plainly in the final report.

---

## Step 5 — Rules of engagement (whole session)

- **Authority:** `01-architecture.md` wins every conflict; fix the conflicting text in the same commit and log the decision. §9/§10/§6/§8 are law; §9 fields are added only by amending the doc.
- **Every deviation or non-obvious choice → PROGRESS.md Decisions log with a written rationale.** A decision without a rationale is a bug.
- **Blockers:** after ~3 distinct failed approaches to one obstacle, stop hacking: 🟡 + Blockers entry (symptom, attempts, smallest human decision needed). Then consult the dependency graph before continuing: 4, 5 and 7 need 3; 6 needs only 1–2+2B; 8 needs 3+5; 9 needs 8; 10 needs everything. Continue with a genuinely independent later phase if one exists; otherwise halt and report.
- **No scope creep:** BL/OUT stays out; no new libraries beyond §2 without a Decisions entry proving necessity.
- **Hygiene:** fixture generators committed; `.env`, `infra/certs/`, key material, build output never committed; PROGRESS.md is the *only* status record.

---

## Step 6 — Done definition for THIS session

- Phases **3–9 all ✅** in PROGRESS.md with per-criterion evidence; **Phase 10 🟠** with every agent-executable item evidenced and the owner Launch checklist filed (✅ only if the owner completed their items mid-session).
- Final fresh-stack regression (`./infra/reset.sh --yes && ./infra/up.sh && ./infra/test.sh --e2e`) fully green on `main`.
- Through the UI, **as a guest and as an account**: annotate + flatten; edit/add text with the scanned-page OCR gate working end-to-end; fill and build forms; OCR a scan (Hebrew included); convert in/out incl. PDF/A; compare two documents; protect/unlock; redact by pattern with clean-copy fork; sanitize; **self-sign in <4 clicks**; and (account) run a 2-signer sequential sign request end-to-end via Mailpit, then verify the sealed output at `/verify`. Every new tool page is prerendered, in `sitemap.xml`, and guest-usable. Ads dark by default; product launchable.
- All work merged to `main` via reviewed PRs; no branch left open, no red suite, no unproven tick.

Finish with a report: what shipped per phase, final test/coverage numbers, every Decisions-log entry you added, every Human-review/GATE item (especially the owner Launch checklist), and exactly what stands between the current state and tagging `v1.0.0`.
