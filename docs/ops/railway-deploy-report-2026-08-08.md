# ZenPDF → Railway — execution report

**Executed:** 2026-08-08, by a Claude Cowork cloud session following
`docs/ops/railway-deploy-plan.md` (v2).
**Live:** **https://zenpdf.up.railway.app**
**Deployed tree:** working-tree snapshot of `main` @ `d315b83` (+2 files dirty at
snapshot time) — `railway up`, not GitHub.
**Outcome:** all 10 services healthy; every dependency check green; the full
guest job path verified end-to-end. **Two verifications could not be performed in
the cloud sandbox and are handed off** — see
`docs/ops/railway-handoff-claude-cli.md`. **One is launch-blocking (H1).**

---

## 1. Services

| # | Service | Status | Region | Notes |
|---|---|---|---|---|
| 1 | `web` | SUCCESS | europe-west4-drams3a | public, `zenpdf.up.railway.app`, targetPort 80 |
| 2 | `api` | SUCCESS | europe-west4-drams3a | gunicorn 4 workers on `[::]:8000`, private only |
| 3 | `worker-default` | SUCCESS | europe-west4-drams3a | `-Q default -c 2` |
| 4 | `worker-heavy` | SUCCESS | europe-west4-drams3a | `-Q heavy -c 1` |
| 5 | `worker-render` | SUCCESS | europe-west4-drams3a | `-Q render -c 2` |
| 6 | `beat` | SUCCESS | europe-west4-drams3a | **replicas = 1** (asserted) |
| 7 | `gotenberg` | SUCCESS | europe-west4-drams3a | 8.35.0, `[::]:3000`, JS disabled + SSRF deny-list |
| 8 | `storage` | SUCCESS | europe-west4-drams3a | SeaweedFS 3.97 S3 on 8333, 50 GB volume at `/data` |
| 9 | `Postgres` | SUCCESS | europe-west4-drams3a | **PostgreSQL 18** (`postgres-ssl:18`; Django 6 floor is 14) |
| 10 | `Redis` | SUCCESS | europe-west4-drams3a | **Redis 8.2.1** |

Workspace is **Pro**, not Hobby — so volumes cap at **50 GB**, not 5. Plan risk
**R6** (storage volume fills) is materially relaxed. Workspace preferred region
was set to EU West (Amsterdam) first, so every service defaulted to
`europe-west4-drams3a` without per-service moves.

## 2. Verification results (E1–E12)

| Step | Result | Evidence |
|---|---|---|
| **E1** service states | ✅ | 10/10 SUCCESS, all in `europe-west4-drams3a`, beat replicas = 1 |
| **E2** `/health` | ✅ | `ok` — nginx + edge + TLS |
| **E3** `/api/health/live` | ✅ | `{"status":"ok"}` — nginx→api over the private mesh; the `fd12::10` resolver in `nginx.railway.conf` is correct as written (plan risk **R1** closed empirically) |
| **E4** readiness | ✅ | `{"db":true,"redis":true,"storage":true,"gotenberg":true,"workers":true}` on the **first** poll. `storage:true` proves SeaweedFS + bucket + creds; `redis:true` proves the `/0`–`/1` split; `workers:true` proves beat heartbeats |
| **E5** static + headers | ✅ | `/ads.txt` → 200 `text/plain`, rendered by the API through the rewrite-based proxy. `/` → 200 with CSP, HSTS, `cache-control: no-cache`, `x-frame-options: DENY`, Permissions-Policy. Prerender spot-checks: `/merge-pdf`, `/split-pdf`, `/compress-pdf` all return their own `<title>` |
| **E6** guest job E2E | ✅ | guest mint (201) → upload 2-page PDF (201, `page_count:2`) → `rotate_pages` queued → **succeeded in 168 ms** on the default lane → document streamed back 743 B `application/pdf`. Byte-verified: page 1 `/Rotate == 90`, page 2 untouched. Proves upload → storage write → worker → storage read → API stream across the private mesh |
| **E7** signing cert on disk | ⚠️ **partial** | `railway ssh` cannot establish from this sandbox. Indirect proof: the start command is `… \| base64 -d > /tmp/certs/zenpdf.p12 && exec …`, so gunicorn and all three workers running means the decode exited 0 and the file was written; `SIGNING_CERT_B64` round-trips byte-exact. **Sealing itself is unexercised → handoff H1** |
| **E8** throttle identity | ✅ **`NUM_PROXIES=3`** | See §3 — the most consequential finding of this run |
| **E9** e2e `@smoke` suite | ❌ **not run** | Chromium has **zero** outbound network in this sandbox (`example.com` and `registry.npmjs.org` reset too). All 6 specs died at `page.goto` with `ERR_CONNECTION_RESET` — **no product assertion ever evaluated**, so this is not evidence either way. Partial manual coverage in §4 → handoff **H2** |
| **E10** SMTP probe | ⏭️ skipped | Owner decision (§5) |
| **E11** error-log sweep | ✅ | api / 3 workers / beat / web / gotenberg: **zero** error, exception, traceback or panic lines over the deploy window. `storage` shows SeaweedFS's own start-up chatter at 09:38 (volume server waiting for the master inside the same container) which stopped once it settled — the "one-off startup noise" the plan permits. Every subsequent S3 PUT succeeded |
| **E12** cost | ✅ | §6 |

## 3. `NUM_PROXIES` — measured, and it is **3**

This supersedes **both** `docs/ops/railway.md` gotcha 4 (`=1`) **and this plan's
own `=2`.** It was found because E8 probe 1 produced no `429` at all.

A temporary nginx probe location (added, measured, removed — not in the committed
config) reported what actually arrives:

```
remote_addr=100.64.0.3
xff_in=77.137.23.100, 89.222.123.193      <- Railway's edge already sets TWO entries
xff_out=77.137.23.100, 89.222.123.193, 100.64.0.3   <- nginx appends its own peer
```

So Django sees a **three-hop** chain, and only `N=3` resolves the real client:

| N | Ident DRF picks | Consequence |
|---|---|---|
| 1 | `100.64.0.x` — **varies every request** | every per-IP throttle silently never fires |
| 2 | `89.222.123.193` — a constant Railway-internal address | all clients collapse into one global bucket |
| **3** | `77.137.23.100` — the real client | **correct** |

Two further facts fell out of the same measurement:

* **Railway's edge strips client-supplied `X-Forwarded-For` outright.** A request
  sent with `X-Forwarded-For: 203.0.113.7` arrived at nginx with `xff_in`
  unchanged. Clients cannot influence their bucket at all — stronger than the
  plan's "immune to a spoofed prefix" reasoning.
* The `89.222.123.193` hop is constant *per edge region* (US requests showed
  `152.233.30.104`), which is why `N=2` collapses buckets rather than randomising
  them.

With `NUM_PROXIES=3` all three plan probes pass:

1. **Fires per IP** — 13 logins from a real browser: `401×10` then **`429` at #11**, exactly the `auth` 10/min scope.
2. **Not spoofable** — the container, forging `X-Forwarded-For: 77.137.23.100` (a bucket that was full at that moment), got `401`, not `429`.
3. **Not collapsed** — at the same instant the browser was `429` and a different-IP caller was `401`.

`apps/core/authentication.py:client_ip` uses the same count-back arithmetic as
DRF's `get_ident`, so one value fixes both the custom guest-IP path and the DRF
scopes. **Do not "simplify" this back to 2.**

*Diagnostic aside:* the first probes were also masked by the cloud container's
own egress IP rotating across `160.79.106.0/24`, which makes per-IP throttling
untestable from here. The token-keyed guest scope was used to prove the throttle
machinery and cache were healthy first (`429` at exactly request #41 against the
40/min guest scope) before concluding the fault was in IP identity. Note that
`/api/health/`'s `redis` check pings `REDIS_URL` (db 0, the broker) and says
nothing about the Django cache on db 1 where throttle buckets live — worth
knowing next time throttling looks wrong.

## 4. Manual browser coverage (partial substitute for E9)

Driven through a real Chrome on a real network:

* `/` — renders correctly in the "Zen ink & paper" design; self-hosted Shippori
  Mincho and Zen Kaku Gothic New report `document.fonts.status === "loaded"`;
  tool groups and type-to-filter present; **zero console errors**.
* `/sign-pdf` — `[data-test=tool-h1]` is `"Sign a PDF"`, `[data-test=file-input]`
  and `[data-test=tool-run]` present, and **`[data-test=login-form]` count is 0** —
  the anonymous-first assertion at the top of the phase-8 smoke.
* Prerendered `<title>`s served correctly on tool routes.

## 5. Deviations from the plan, and why

| # | Deviation | Reason |
|---|---|---|
| 1 | **`NUM_PROXIES=3`, not 2** | Measured (§3). The plan's §E8 mandated deciding this empirically |
| 2 | **`absolute_redirect off;` added to `nginx.railway.conf`** (a 5th delta from `frontend/nginx.conf`) | Not anticipated by the plan. nginx builds its own redirects from `$scheme`, which is `http` behind Railway's TLS-terminating edge, so `/merge-pdf` → `/merge-pdf/` was answering `location: http://zenpdf.up.railway.app/merge-pdf/` — a plaintext downgrade on the first visit to **every** directory-style prerendered route. Now emits the relative `location: /merge-pdf/` |
| 3 | **Gotenberg's deny-list regex passed via the `GOTENBERG_DENY_LIST` service variable** rather than inlined into the start command | Railway's exec-form tokenizer **strips backslashes inside a double-quoted segment**: the regex arrived as `127.d+` instead of `127\.\d+` and Gotenberg panicked at boot (`[r-d] range in reverse order`). Variable values round-trip byte-exact; the start command now references `"$GOTENBERG_DENY_LIST"` inside outer single quotes. The file `infra/railway/gotenberg-deny-list.txt` is byte-verified against the `base.py` default and is the source for the variable |
| 4 | `serviceInstanceDeployV2` used instead of `railway redeploy` | `railway redeploy` re-runs the deployment's **frozen** `serviceManifest`, so it ignored the start commands just written by `serviceInstanceUpdate`. The plan listed this as a fallback; it is in fact required |
| 5 | `railway up -d -s <svc>` **without** the trailing `.` | CLI 5.33 crashes with `prefix not found` when given an explicit path argument. Same upload, `.railwayignore` still applied |
| 6 | Deploy gates poll `deployment(id){status}` for a specific deployment id | `railway status`'s `latestDeployment` lags and reports the *previous* deploy's SUCCESS, which would wave a running build through |
| 7 | `web` built concurrently with `api` | No deploy-time dependency (nginx resolves `api.railway.internal` per request). The ordering that matters — api → workers → beat — was preserved with hard gates |
| 8 | Daily volume backups set on **all three** volumes | Plan asked for storage; Postgres and Redis were free to include |

## 6. Cost

Workspace is on **Pro**: $20/month fee including $20 of usage. Billing period
Aug 6 → Sep 6 currently reads **$4.39** across eight projects, of which **`zenpdf`
is $0.0109** after roughly 50 minutes of runtime (including five cold builds).

Extrapolating the idle rate, the ZenPDF stack lands around **$10–15/month** —
below the plan's conservative $25–50, mostly because the whole stack idles at
launch. Real traffic (OCR and Office conversions are the expensive lanes) will
push it up. Note the $20 included allowance is shared with the other seven
projects, which are already consuming most of it.

## 7. New files added to the repo (additive; no existing file changed)

* `infra/railway/api.Dockerfile`
* `infra/railway/web.Dockerfile`
* `infra/railway/nginx.railway.conf` — includes the `absolute_redirect off` fix
* `infra/railway/gotenberg-deny-list.txt` — byte-equal to the `base.py` default
* `.railwayignore` (repo root)
* `docs/ops/railway-handoff-claude-cli.md`, this report
* `infra/certs/prod/{zenpdf-prod.p12, RAILWAY-SECRETS.md}` — **gitignored**

`e2e/playwright.config.ts` was patched **in the cloud copy only** (Chromium
`executablePath` + proxy) and deliberately **not** written back — the committed
config stays clean.

## 8. What is still open

**Blocking:** H1 — the production signing certificate has never actually sealed a
document. See the handoff.

**Not blocking:** H2 (e2e smoke), H3 (`infra/test.sh --e2e` pre-ship gate), SMTP,
correcting `docs/ops/railway.md` gotcha 4 to `NUM_PROXIES=3`, custom domain,
AdSense, Sentry, admin, AATL cert, GitHub auto-deploys, first restore drill, and
the `v1.0.0` tag.

**Accepted risks confirmed unchanged:** R4 (Mailpit-dependent specs will fail
against prod), R5 (Gmail SMTP limits — moot while off), R7 (the pre-ship gate did
not run in the cloud), R8 (no rollback target existed for deploy 1; from now on
rollback = redeploy the prior SUCCESS deployment), R9 (admin stays off), R10
(well under the 1,000 req/h API limit).

**Risks closed:** R1 (resolver — E3 proves `fd12::10` works), R2 (already
downgraded), R3 (XFF behaviour — now measured, §3), R6 (volume cap is 50 GB on
Pro), R12 (`railway status` JSON shape pinned).
