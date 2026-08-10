# Railway deploy — remaining work, as a Claude CLI handoff

**Context:** `docs/ops/railway-deploy-plan.md` was executed on **2026-08-08** by a
Cowork cloud session. The stack is **live at https://zenpdf.up.railway.app** with
all 10 services healthy — see `docs/ops/railway-deploy-report-2026-08-08.md` for
the full evidence log.

Three items could **not** be completed from the cloud container, for reasons that
are environmental rather than product defects. Each is written below as a
self-contained prompt to paste into `claude` in the repo root on your Mac, where
the full local stack (docker, Mailpit, a real network) exists.

Do **H1 first** — it is the only one that gates launch.

---

## H1 — Verify the production signing certificate actually seals (BLOCKING)

**Why it is still open.** The platform seal (`apps/pdf_engine/engine/seal.py`,
invoked from `apps/esign/tasks.py`) only runs at multi-party *finalize*. Reaching
finalize needs a signer to open a tokenised link, and that token is deliberately
never exposed API-side (`apps/esign/serializers.py`: "No token — that is the
recipient's capability"). With SMTP switched off, no invitation is delivered, so
the seal path is unreachable from outside. `EMAIL_BACKEND` is hardcoded to SMTP
in `base.py`, so it cannot be redirected to the console backend by env var
either.

What *is* already established: the `.p12` was verified with
`openssl pkcs12 -in … -passin` at generation; `SIGNING_CERT_B64` round-trips into
Railway at exactly the expected length; and because every Django service's start
command is `… | base64 -d > /tmp/certs/zenpdf.p12 && exec …`, the fact that
gunicorn and all three celery workers are running proves the decode exited 0 and
the file was written. What is **not** established is that pyHanko can load it and
produce a verifiable seal.

> **Prompt to paste:**
>
> The ZenPDF production deployment at https://zenpdf.up.railway.app uses a
> self-signed production signing cert whose *sealing* path has never been
> exercised. The cert is at `infra/certs/prod/zenpdf-prod.p12`; its password is
> `SIGNING_CERT_PASSWORD` in `infra/certs/prod/RAILWAY-SECRETS.md`.
>
> Prove the cert can actually seal, locally, before we rely on it in production:
>
> 1. Bring up the local stack (`infra/up.sh`).
> 2. Write a throwaway script or Django shell snippet that points
>    `SIGNING_CERT_PATH` / `SIGNING_CERT_PASSWORD` at the **production** p12 and
>    calls `apps.pdf_engine.engine.seal.seal(...)` on a fixture PDF, then
>    `seal.verify(...)` on the result. Assert the seal verifies, the common name
>    is `ZenPDF Document Sealing`, and a timestamp from `TSA_URL`
>    (`http://timestamp.digicert.com`) is embedded.
> 3. Then run the real thing: a full two-signer ceremony through the local stack
>    with the production p12 mounted, reading invitation links out of Mailpit —
>    i.e. `e2e/tests/phase-8.spec.ts`'s
>    `@smoke @mobile phase 8: two signers in order, sealed, certified and
>    verifiable`, but with the prod cert.
> 4. Finally, take the sealed PDF that test produces and POST it to the **live**
>    `https://zenpdf.up.railway.app/api/verify/` — production must verify its own
>    seal.
>
> Report pass/fail per step. If the cert cannot seal, say so plainly and do not
> soften it: it means production sealing is broken and launch must wait.

---

## H2 — Run the e2e smoke suite (`@smoke`) against production

**Why it is still open.** Chromium has **no outbound network whatsoever** in the
Cowork cloud sandbox — `example.com` and `registry.npmjs.org` are reset just as
readily as the ZenPDF host, with or without the sandbox's CONNECT proxy. So
Playwright cannot reach anything and all six `@smoke` specs failed at
`page.goto` with `net::ERR_CONNECTION_RESET`. **No spec ever evaluated a product
assertion**, so this is not evidence of anything either way.

Two of the six specs are additionally mail-dependent and are *expected* to fail
against production while SMTP is off (`phase-8` two-signer calls `clearMail()`
against Mailpit; `phase-0`/`phase-2b` confirm addresses through it) — that is
the plan's accepted risk R4, not a regression.

Partial coverage was obtained by hand through a real browser and is recorded in
the report: the landing page and `/sign-pdf` render correctly, fonts load, zero
console errors, and `/sign-pdf` shows **no login form** (the anonymous-first
assertion at the top of the phase-8 smoke).

> **Prompt to paste:**
>
> Run the ZenPDF e2e smoke suite against the live production deployment and
> triage every failure honestly.
>
> ```bash
> cd e2e && npm ci
> BASE_URL=https://zenpdf.up.railway.app npx playwright test --grep @smoke
> ```
>
> Note: `e2e/playwright.config.ts` in git is the clean original — a cloud-only
> patch (Chromium `executablePath` + proxy) was deliberately **not** committed,
> so you should need no changes.
>
> Classify each failure into exactly one of:
> (a) **email-infrastructure-dependent** — the spec reads mail from Mailpit,
>     which production does not have (SMTP is off). Expected; note and move on.
> (b) **a real regression** — anything else. Investigate before declaring the
>     deployment good.
>
> Never wave a failure through as "probably (a)" without checking that the spec
> actually touches Mailpit. Then re-run the mail-dependent ones against the
> local stack (`BASE_URL=http://localhost:4200`) to confirm they still pass
> there, so we know the specs themselves are sound.

---

## H3 — Run the pre-ship gate that needs docker

**Why it is still open.** `docs/ops/deploy.md`'s gate is `infra/test.sh --e2e`,
which needs docker; the cloud container has none. The tree deployed is the one
QA'd locally on 2026-08-06 (211/211 unit tests, build + 29 prerendered routes
green) — but its **e2e suite had never been run**, and per H2 it still hasn't.

> **Prompt to paste:**
>
> Run the full pre-ship gate for ZenPDF on this machine: `infra/test.sh --e2e`.
> The tree currently deployed to production is commit `d315b83` on `main` plus
> two uncommitted files, and the five additive Railway files under
> `infra/railway/` (+ root `.railwayignore`) that the deploy session added.
>
> Report the results, and separately confirm the working tree still matches what
> is live — `git status --porcelain` should show only the Railway files and the
> two files that were already dirty at deploy time. If anything else has drifted,
> production is running something that is not in git and I need to know.

---

## Not blocking, but queued (from the plan's deferred list)

| Item | Note |
|---|---|
| SMTP | Owner decision to skip. Re-enable recipe in `RAILWAY-SECRETS.md`. **Blocks multi-party signing.** |
| ~~Correct `docs/ops/railway.md` gotcha 4~~ | **Done 2026-08-10.** Gotcha 4 now reads `NUM_PROXIES=3` with the chain spelled out, and the `$((2*nproc+1))` formula is replaced by the fixed `--workers 4` the service actually runs, with the Railway Metal `nproc` trap explained. |
| Custom domain | Currently `zenpdf.up.railway.app`. |
| AdSense | `ADS_ENABLED` off. CSP additions are pre-written at the foot of `frontend/nginx.conf`; mirror them into `infra/railway/nginx.railway.conf` when switching on. |
| Sentry | Unset, inert. |
| Admin | Stays off — no collectstatic/whitenoise exists and nginx 404s `/static/` (plan R9). |
| AATL signing cert | Post-launch upgrade; self-signed until then. |
| ~~GitHub auto-deploys~~ | **Done 2026-08-10.** All six app services (`api`, three workers, `beat`, `web`) build from `yhaspel/ZenPDF@main`; the four image-sourced services are unchanged. A push to `main` is the deploy. Before flipping, a `git archive HEAD` checkout was built with both Dockerfiles and produced the byte-identical CSS bundle production was serving, which is what proved a commit-sourced build reproduces the snapshot. **Watch patterns are still unset** — one commit currently rebuilds all six. See `docs/ops/railway.md`. |
| First restore drill | Per `docs/ops/restore-drill.md`. Postgres has template backups; a daily schedule on the storage volume still needs confirming in the dashboard. |
| `v1.0.0` tag | Phase 10 still open in `PROGRESS.md`. |
