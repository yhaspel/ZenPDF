# Phase 10 — Hardening & Release

**Goal:** production readiness: security hardening, performance, accessibility, observability, full regression suite, prod deployment. No new features.

Depends on: Phases 0–9 complete.

## 10.1 Security hardening (execute as a review with fixes, checklist-driven)

- **Threat pass over inputs:** re-test upload validation chain (§17) with a hostile corpus: PDF bombs (page/object explosion — enforce `MAX_PAGES`, pikepdf object-count cap, decompression byte budget), zip-of-images bombs on convert_from, malformed TIFFs, recursion in outline trees. Worker resource limits verified under attack fixtures (§12: time/memory kill → job failed, worker recycles, queue drains).
- **AuthN/Z sweep:** the cross-user **and cross-guest** isolation fixtures (P1 + P2B, §21.2) re-run across EVERY endpoint added since (documents, jobs, operations, esign owner + public, exports, verify); public token state machine fuzzed (wrong states, replay after completion, canceled request tokens).
- **Headers/CSP (prod nginx):** CSP — self + configured ad/CMP domains, `worker-src blob:` for the PDF.js worker, `wasm-unsafe-eval` only if pdf.js requires it; HSTS; X-Content-Type-Options; Referrer-Policy; `frame-ancestors 'none'`; COOP/COEP evaluated (skip if it breaks ad iframes — document the decision).
- **Downloads:** `Content-Disposition: attachment` + `X-Content-Type-Options` on all user-content responses; SVG/HTML exports (P6 html) served as attachment only (no inline render of user HTML — XSS).
- **Dependency & image hygiene:** `pip-audit` + `npm audit` clean-or-triaged; Docker images rebuilt on base updates; engine libs (MuPDF/qpdf/Ghostscript CVE trackers) subscribed — documented update runbook (monthly cadence) since they parse hostile input.
- **Secrets:** prod env via platform secrets; `SECRET_KEY`/JWT rotation runbook; signing cert storage guidance (real CA cert for prod, file perms, backup).
- **Backups/DR:** nightly `pg_dump` + storage bucket replication/sync plan; restore drill documented and performed once; RPO 24 h stated in ops doc.
- **Privacy:** account deletion endpoint + flow (erases documents/blobs, anonymizes audit rows per retention note in legal pages — sign-request audit for OTHER parties' completed envelopes is retained (legal basis: contract evidence; stated in privacy policy)); data-export (zip of user docs) endpoint.

## 10.2 Performance

Budgets (measured, in CI-able scripts where possible): cold SPA load <2.5 s on Fast-3G-throttled Lighthouse (code-split routes: workspace, ceremony, dashboard as lazy chunks; viewer chunk isolated); 100-page doc open <2 s warm; thumbnail rail virtualized (CDK virtual scroll); dashboard 1000-doc list paginated+virtualized; API p95 <150 ms for metadata endpoints under `locust` smoke (200 concurrent light users, compose stack) — heavier realism deferred to real infra; job queue drain: 50 parallel mixed ops without starvation (heavy lane isolation §12 verified); Postgres: indexes audited via `EXPLAIN` on the 6 hottest queries (documents list, jobs poll, versions, sign lists, audit append, usage) — pg_stat_statements enabled in dev compose.

## 10.3 Accessibility (WCAG 2.1 AA — our UI)

Keyboard-complete flows: dashboard, viewer nav, ALL dialogs (focus trap via CDK), ceremony end-to-end (a signer using only keyboard + screen reader must succeed — this is the legally sensitive one); labels/roles/live-regions for job progress toasts; contrast pass on the design tokens; `prefers-reduced-motion` honored; axe-core automated pass in Playwright (zero serious/critical) + manual NVDA/VoiceOver script for ceremony. Note: accessibility of *user PDFs* is out of scope (02-matrix) — ours isn't.

## 10.4 Observability & ops

Structured JSON logs (request id, user id, job id correlation) → stdout (compose: `logs.sh`; prod: platform); Sentry wiring behind `SENTRY_DSN` (api + worker + Angular, release-tagged, PII-scrubbed); `/api/health/` deep vs `/api/health/live` split (fast liveness vs dependency checks); worker heartbeat metric (beat task writes; health surfaces staleness); minimal ops dashboard = admin + health + queue depths endpoint (flower optional in dev compose, off by default); runbooks in `docs/ops/`: deploy, rollback, restore drill, queue stuck, storage full, cert renewal (TLS + signing cert + TSA outage behavior).

## 10.5 Release engineering

- **E2E regression suite:** the per-phase Playwright specs consolidated into a tagged suite (`@smoke` ~10 min: auth, upload, one op, self-sign, ceremony happy path; `@full` nightly: everything incl. time-warped reminders); flake budget zero-tolerance policy (quarantine tag + fix-within-phase rule).
- **Cross-browser matrix:** Chromium/Firefox/WebKit via Playwright projects; mobile viewports for ceremony + dashboard.
- **Prod deploy:** `infra/docker-compose.prod.yml` verified on a clean VM (nginx TLS via reverse proxy of choice, gunicorn workers=2×CPU, worker/beat processes, real SMTP creds, S3-compatible bucket (cloud or SeaweedFS with backup discipline), managed Postgres recommended); **Railway path:** follow the `railway-deployment` skill (owner's deploy target) — service-per-process mapping table prepared (api, worker-default, worker-heavy, worker-render, beat, web/nginx, Postgres, Redis; storage = external S3-compatible, Gotenberg as its own service); env matrix (§19) translated to Railway variables; gotchas from the skill honored (ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS, nginx proxy, migrations on deploy).
- **Launch checklist:** DNS/TLS; SPF/DKIM/DMARC for notification mail; error pages (404/500, maintenance); seed removed/admin credentials rotated; legal pages final; ads flag per 9A readiness; monitoring alerts (health, error rate, queue depth); tag `v1.0.0`; `docs/` user guide (tool-by-tool, honest-limits sections from P4/P6/P7 copy).

## Acceptance criteria
- [ ] Hostile-corpus suite: zero worker crashes that don't recycle cleanly; zero cross-user leaks; all documented limits enforced.
- [ ] Lighthouse (landing + dashboard) ≥90 perf/a11y/best-practices/SEO on prod build.
- [ ] axe-core zero serious/critical across routes; keyboard-only ceremony pass recorded.
- [ ] `@full` suite green 3 consecutive nightly runs on the prod-shaped stack.
- [ ] Clean-VM prod compose deploy documented + performed; restore drill performed.
- [ ] p95 budgets met; queue-starvation test passes.
- [ ] Launch checklist 100% with owner sign-offs (legal content, ads readiness, domain).

## Release gate
When every box above is checked, tag v1.0.0. Post-v1 roadmap = 02-feature-matrix "BL" column (teams/sharing, templates & bulk send, batch pipelines, public API, PDF→Excel, booklet, threaded comments, ID-verification tiers).
