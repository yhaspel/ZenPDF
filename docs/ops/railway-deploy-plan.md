# ZenPDF → Railway — execution plan (v2, post-adversarial-review)

**Written:** 2026-08-07 · decisions in §0 locked by Yuval; v2 incorporates all findings of an independent adversarial review (fixes marked ✦ where they changed v1 behavior).
**Executor:** a Claude Cowork cloud session with (a) the ZenPDF folder connected from `mac-home`, (b) the Claude-in-Chrome extension reachable, with the user logged into railway.com (and ideally Google) in that Chrome.
**Target:** `https://zenpdf.up.railway.app` (fallback labels §D4) serving the full production stack.
**Sources of truth:** repo working tree; `docs/ops/railway.md` (the project's own Railway ops doc); the `railway-deployment` skill; Railway docs/CLI/GraphQL verified live 2026-08-06/07 (CLI v5.6.x). Key mechanics re-verified hostile: start commands on Dockerfile/image deploys are **exec-form — no shell** unless you wrap them (docs.railway.com/deployments/start-command.md); `railway up --ci` exits at **build** completion, not deploy success; `.gitignore` only filters `railway up` uploads **inside a git repo**.

Self-contained: the executor needs no access to the planning conversation. Steps that rest on an unverifiable-in-advance platform detail say so and carry an explicit fallback — never guess past a failed step; use the fallback or stop and report.

---

## 0. Locked decisions (do not re-ask)

| Decision | Value | Decided by |
|---|---|---|
| Railway auth | **Mint an account token via Yuval's logged-in Chrome** at `railway.com/account/tokens` | Yuval |
| Object storage | **SeaweedFS as a Railway service + volume** (no external accounts) | Yuval |
| SMTP | **Gmail app password** for `yuval3000@gmail.com` — attempt to mint via Chrome; if blocked, deploy without SMTP and report (registration still returns 201; emails silently skipped — verified: `apps/core/mail.py` swallows send failures) | Yuval |
| Worker topology | **Full 4-lane** (`worker-default`, `worker-heavy`, `worker-render`, `beat`) per `docs/ops/railway.md` | Yuval |
| Region | `europe-west4-drams3a` (Amsterdam) for every service — Yuval is in Asia/Jerusalem; nearest Railway region | plan |
| Deploy source | `railway up` from a snapshot of the **working tree** (not GitHub) — ships exactly what is on Yuval's disk; optional GitHub auto-deploys are Appendix C | plan |
| Launch config | Anonymous-first defaults: `ADS_ENABLED` unset (off), `ADMIN_ENABLED` unset (off — also correct because collectstatic/whitenoise are absent, §R9), `CAPTCHA_ENABLED` unset (off), Sentry unset (inert), `SECURE_HSTS_PRELOAD` unset (false) | plan, per `.env.prod.example` |
| Signing cert | Fresh **self-signed** 3-year `.p12` generated at execution + public TSA (`TSA_URL=http://timestamp.digicert.com`) — `docs/ops/cert-renewal.md` allows "an explicit decision to stay self-signed"; this is that decision for v1. AATL cert is a post-launch upgrade. | plan |

**Scale:** 10 Railway services — 8 app services + 2 database services. ✦(count corrected throughout.) Cost expectation (usage-billed: $10/GB-RAM/mo, $20/vCPU/mo, volumes $0.15/GB/mo): mostly idle at launch ≈ **$25–50/month** on Hobby ($5/mo base incl. $5 usage). §A2 verifies the workspace is on **Hobby or Pro** before creating anything (Trial caps 5 services/project — this stack needs 10).

---

## 1. Final topology

One project `zenpdf`, one environment `production`, all services in `europe-west4-drams3a`:

| # | Service | Source | Public? | Listens | Purpose |
|---|---|---|---|---|---|
| 1 | `web` | repo → `infra/railway/web.Dockerfile` | **yes — `zenpdf.up.railway.app`**, targetPort 80 | :80 | nginx: SPA + proxies `/api/` and `/ads.txt` to `api` over **private networking** |
| 2 | `api` | repo → `infra/railway/api.Dockerfile` | no | :8000 (`PORT=8000`) | Django/gunicorn |
| 3 | `worker-default` | same image as api | no | — | Celery `-Q default` |
| 4 | `worker-heavy` | same image | no | — | Celery `-Q heavy` (OCR/convert) |
| 5 | `worker-render` | same image | no | — | Celery `-Q render` (thumbnails) |
| 6 | `beat` | same image | no | — | Celery beat — **exactly 1 replica, never scale** |
| 7 | `gotenberg` | image `gotenberg/gotenberg:8` | no | :3000 | Office conversions; hardened flags |
| 8 | `storage` | image `chrislusf/seaweedfs:3.97` + **volume at `/data`** | no | :8333 | S3-compatible blob store |
| 9 | `Postgres` | Railway template (deploys PG 18 as of 2026-08; any PG ≥ 14 is fine — Django 6 floor. Record the actual major in the report) | no | :5432 | DB |
| 10 | `Redis` | Railway template (Redis 8.x as of 2026-08) | no | :6379 | broker + cache |

Request path: browser → Railway edge (TLS) → nginx (`web`) → `api.railway.internal:8000` (private; the project is created fresh → post-Oct-2025 **dual-stack** environment). Therefore **`NUM_PROXIES=2`** (client hop, then the edge hop nginx appends) — the same reference reasoning as `infra/.env.prod.example`, and count-from-the-right is immune to a client-spoofed XFF *prefix*. ✦Caveat the review surfaced: Railway documents `X-Real-IP` and `X-Forwarded-Proto` at the edge but does **not** document `X-Forwarded-For` behavior — §E8 now proves the identity model empirically (distinct-client test + forged-XFF test) and Appendix B2 is the terminal fallback if the edge turns out not to set XFF at all. `api` gets **no public domain**: no direct-hit spoof surface, no egress fees, admin surface unreachable. (This deliberately supersedes `docs/ops/railway.md` gotcha 4's `NUM_PROXIES=1`, which assumed no nginx hop; E8's finding goes in the report so the ops doc can be corrected.)

Known deviation from the `railway-deployment` skill: the skill proxies nginx→api via the **public** URL because private DNS from nginx was unreliable. That experience predates dual-stack private networking (Oct 2025) and the resolver-variable pattern; this plan uses private networking with the Railway-staff-recommended nginx pattern (`resolver [fd12::10] valid=1s` + `proxy_pass` through a variable → per-request re-resolution; the historical 502/504s were nginx caching resolved IPs across api deploys). If §E still shows 502/504 on `/api/`, Appendix B1 switches to the skill's public-proxy topology.

Not deployed (dev-only): Mailpit, `infra/certs` dev certs, perf tooling.

---

## 2. Ground rules for every shell step

- Secrets live in `~/.zenpdf-deploy/secrets.env` (`chmod 600`). ✦**Source it in EVERY Bash call that touches a secret or runs `railway`** — shell state does not persist between calls:

  ```bash
  set -a; . ~/.zenpdf-deploy/secrets.env; set +a
  ```

- ✦Long-running commands: the executor's Bash tool caps at 10 min per call. Never rely on one call outlasting a Railway build — kick off with `--detach` and poll.
- After each `railway` call, check the exit code and `--json` output. On any failure: stop, read `railway logs -b -s <svc>` (build) / `railway logs -s <svc>` (deploy), consult Appendix A, use the listed fallback, or report.
- Single-quote **every** `K=V` argument to `railway variable set` (values contain `$`, spaces, `<`, `>`).

---

## 3. Phase A — access bootstrap (Chrome + CLI)

**A1. Mint the Railway account token.** Load Chrome tools; `tabs_context_mcp`; new tab → `https://railway.com/account/tokens`. If a login screen shows → STOP, ask Yuval to log in, then continue. Create token `cowork-deploy-2026-08`, **workspace = none/personal** (account token; a workspace token also works — a *project* token cannot create projects). Read the value off the page → `secrets.env` as `RAILWAY_API_TOKEN=…`. Close tab.

**A2. Verify plan tier.** In the dashboard (avatar menu → workspace settings/billing/usage), record the plan. **Trial or Free → STOP** and report: "Workspace is on <plan>; this stack needs 10 services (Trial caps 5/project). Upgrade to Hobby ($5/mo) and re-run." Create nothing partial.

**A3. Preferred region.** ✦In **Account Settings** (per Railway docs, the preferred-deploy-region control lives there; check workspace settings too), set preferred region to Europe/Amsterdam (`europe-west4`). This step is load-bearing for D1's database placement — spend up to 5 minutes. If truly not found, D2's per-service region moves are the fallback.

**A4. Gmail app password attempt.** New tab → `https://myaccount.google.com/apppasswords`. Password/2FA challenge → close tab, set `SMTP_SKIPPED=true` in `secrets.env`, continue (report at end). Else create `ZenPDF Railway`, save the 16-char value (strip spaces) as `GMAIL_APP_PASSWORD`.

**A5. Install + verify CLI; register an SSH key** ✦(so `railway ssh` steps are non-interactive later):

```bash
npm i -g @railway/cli
set -a; . ~/.zenpdf-deploy/secrets.env; set +a
railway whoami                                    # must print the account; abort on Unauthorized
ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519 -q <<< y || true
railway ssh keys add 2>&1 || echo "SSH-KEY-REGISTration failed — E7/E10/D8 degrade to their fallbacks"
```

(If `railway ssh keys add` has a different sub-syntax, `railway ssh keys --help` first; if key registration cannot be done non-interactively, note it and use the documented fallbacks in D8/E7/E10.)

**A6. Generate secrets** (✦note the sourcing preamble writes AND later reads this file):

```bash
mkdir -p ~/.zenpdf-deploy && chmod 700 ~/.zenpdf-deploy && cd ~/.zenpdf-deploy
python3 - >> secrets.env <<'EOF'
import secrets
print("SECRET_KEY=" + secrets.token_urlsafe(64))
print("GUEST_IP_HASH_SALT=" + secrets.token_urlsafe(32))
print("S3_ACCESS_KEY=zenpdf-prod")
print("S3_SECRET_KEY=" + secrets.token_urlsafe(40))
print("SIGNING_CERT_PASSWORD=" + secrets.token_urlsafe(24))
EOF
chmod 600 secrets.env
```

**A7. Generate the production signing cert.** ✦This block MUST source `secrets.env` first (v1 forgot → empty-password p12 that pyHanko would reject at the first sealing job) and MUST verify the export:

```bash
cd ~/.zenpdf-deploy
set -a; . ./secrets.env; set +a
openssl req -x509 -newkey rsa:3072 -sha256 -days 1095 -nodes \
  -keyout zenpdf-prod-key.pem -out zenpdf-prod-cert.pem \
  -subj "/CN=ZenPDF Document Sealing/O=ZenPDF"
openssl pkcs12 -export -out zenpdf-prod.p12 \
  -inkey zenpdf-prod-key.pem -in zenpdf-prod-cert.pem \
  -password "pass:$SIGNING_CERT_PASSWORD"
openssl pkcs12 -in zenpdf-prod.p12 -passin "pass:$SIGNING_CERT_PASSWORD" -noout \
  || { echo "P12 VERIFY FAILED"; exit 1; }
printf 'SIGNING_CERT_B64=%s\n' "$(base64 -w0 zenpdf-prod.p12)" >> secrets.env
```

(Cert loading is lazy per signing job — verified `apps/pdf_engine/engine/seal.py` `_signer()` → `SimpleSigner.load_pkcs12` — so the app boots regardless; E9's guest-sign smoke is the functional proof.)

---

## 4. Phase B — snapshot the repo into the cloud container

Ships Yuval's **current working tree** (`railway up` uploads files, not git history).

**B1.** Provenance via `device_bash` (tolerate git errors — record "unknown"):
`cd /Users/yuval3000/Documents/Claude/Projects/ZenPDF && git rev-parse --short HEAD; git status --porcelain | wc -l`

**B2.** Tar on the device (into `.stage/`, disposable per project memory). ✦Excludes hardened — the tarball must not carry dev secrets or heavyweight dirs (45 s device_bash cap; without node_modules this tree tars in seconds; if it times out, add more excludes and retry):

```bash
cd /Users/yuval3000/Documents/Claude/Projects/ZenPDF && mkdir -p .stage && \
tar --exclude='./node_modules' --exclude='./frontend/node_modules' \
    --exclude='./e2e/node_modules' --exclude='./.git' \
    --exclude='./frontend/.angular' --exclude='./frontend/dist' \
    --exclude='./backend/.mypy_cache' --exclude='./backend/.ruff_cache' \
    --exclude='./.stage' --exclude='./e2e/test-results' \
    --exclude='./e2e/playwright-report' --exclude='./infra/perf/results' \
    --exclude='./infra/.env' --exclude='./infra/certs' \
    --exclude='*.venv' --exclude='./backend/.venv' --exclude='__pycache__' \
    -czf .stage/zenpdf-deploy.tar.gz .
```

**B3.** `device_stage_files` the tarball → copy out of read-only uploads → extract to `~/zenpdf`. Sanity: `ls ~/zenpdf/backend/manage.py ~/zenpdf/frontend/angular.json ~/zenpdf/frontend/package-lock.json ~/zenpdf/infra` all exist (✦the lockfile check gates C2's `npm ci`; the planning session verified `frontend/package-lock.json` exists, 287 KB — if it's somehow gone, switch C2 to `COPY frontend/package*.json ./` + `npm install --no-audit --no-fund` and note the determinism loss); extracted tree < 100 MB; **`ls ~/zenpdf/infra/.env` must FAIL** (proves the secret didn't ride along).

✦Important correction vs v1: `.gitignore` does NOT filter `railway up` uploads here — the CLI's ignore machinery applies gitignore rules only inside a git repo, and the snapshot has no `.git`. `.railwayignore` (C4) is the sole upload filter and therefore must carry the security-relevant excludes itself (belt: B2 already kept secrets out of the tarball entirely; braces: C4).

---

## 5. Phase C — five new repo files (zero edits to existing files)

Create in `~/zenpdf`; written back to Yuval's repo in §F1. Additive only — local dev/prod compose stacks untouched.

**C1. `infra/railway/api.Dockerfile`** — the existing `infra/docker/api.Dockerfile` assumes build context = `backend/`; Railway's context here is the repo root, so same image, root-relative COPYs, prod deps only:

```dockerfile
# ZenPDF API/worker image for Railway. Build context = repo root.
# Mirrors infra/docker/api.Dockerfile (prod target) with root-relative paths.
ARG PYTHON_IMAGE=python:3.14-slim
FROM ${PYTHON_IMAGE}
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
ARG OCR_EXTRA_LANGS=""
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-heb tesseract-ocr-deu \
        tesseract-ocr-fra tesseract-ocr-spa ${OCR_EXTRA_LANGS} \
        ghostscript unpaper pngquant qpdf \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements/ requirements/
RUN pip install -r requirements/prod.txt
RUN useradd --create-home --uid 1000 appuser
COPY backend/ .
RUN chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
# Default = api. Railway start commands (§D6) override this per service.
CMD ["sh", "-c", "gunicorn config.wsgi:application --bind [::]:${PORT:-8000} --workers 4 --timeout 120"]
```

(Deliberate deltas from the compose file: no dev target; `--workers 4` fixed instead of `docs/ops/railway.md`'s `$((2 * $(nproc) + 1))` — on Railway Metal `nproc` reports the **host's** cores and would spawn dozens of workers; binds `[::]` for private-network reachability.)

**C2. `infra/railway/web.Dockerfile`** — context = repo root; `npm ci` against the verified lockfile; `npm run build` triggers the repo's `prebuild` (SEO gen) then the static prerender of 29 routes:

```dockerfile
# ZenPDF web image for Railway. Build context = repo root.
FROM node:24-slim AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

FROM nginx:1.29-alpine
COPY --from=build /app/dist/zenpdf-web/browser /usr/share/nginx/html
COPY infra/railway/nginx.railway.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

**C3. `infra/railway/nginx.railway.conf`** — byte-derived from `frontend/nginx.conf` with exactly four deltas, each mandated by Railway (everything else — CSP, cache policy, `@api_unavailable` JSON, 50x split, `Host $host` passthrough — stays verbatim so the audited config carries over):

1. `resolver [fd12::10] ipv6=on valid=1s;` + upstream in a **variable** → per-request re-resolution of `api.railway.internal` (kills the classic stale-DNS 502 across api deploys). *(§D8 verifies the resolver address empirically and regenerates if different.)*
2. `proxy_set_header X-Forwarded-Proto https;` (literal, replacing `$scheme`) — nginx receives plain HTTP from Railway's TLS-terminating edge; `$scheme` would be `http` and Django's `SECURE_SSL_REDIRECT=True` would loop. The edge serves HTTPS only (documented), so the literal is correct.
3. `location = /health` returning 200 — Railway's deploy-healthcheck target for `web` (exact-match location wins over the regex and SPA blocks).
4. `/ads.txt` via `rewrite … break` — with a variable in `proxy_pass`, nginx ignores a URI in the target; the path rewrite must be explicit.

Full file:

```nginx
# ZenPDF web on Railway — derived from frontend/nginx.conf (keep CSP/cache
# blocks in sync with it). Deltas: Railway private-DNS resolver + variable
# upstream, X-Forwarded-Proto pinned to https (edge terminates TLS),
# /health for Railway's deploy healthcheck, rewrite-based /ads.txt proxy.

server {
    listen 80;
    server_name _;
    client_max_body_size 120m;

    root /usr/share/nginx/html;
    index index.html;

    server_tokens off;

    resolver [fd12::10] ipv6=on valid=1s;
    set $api_upstream http://api.railway.internal:8000;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "same-origin" always;
    add_header X-Frame-Options "DENY" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;

    location = /health {
        default_type text/plain;
        return 200 'ok';
    }

    location /api/ {
        proxy_pass $api_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_request_buffering off;

        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
        add_header X-Frame-Options "DENY" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Content-Security-Policy "default-src 'none'; frame-ancestors 'none'; sandbox" always;
        add_header X-Download-Options "noopen" always;

        error_page 502 503 504 = @api_unavailable;
    }

    location @api_unavailable {
        default_type application/json;
        add_header Retry-After 30 always;
        return 503 '{"error":{"code":"upstream_unavailable","message":"ZenPDF is not answering right now. Nothing you have saved is affected.","details":{}}}';
    }

    location = /ads.txt {
        rewrite ^ /api/ads.txt break;
        proxy_pass $api_upstream;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location ~* \.(js|css|woff2?|png|jpg|jpeg|svg|ico)$ {
        expires 1y;
        add_header Cache-Control "public, immutable" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
        add_header X-Frame-Options "DENY" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
        try_files $uri =404;
    }

    error_page 502 503 504 /50x.html;
    location = /50x.html {
        internal;
        root /usr/share/nginx/html;
    }

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
        add_header X-Frame-Options "DENY" always;
        add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
        add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; child-src 'self' blob:; manifest-src 'self'" always;
        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
    }
}
```

**C4. `.railwayignore`** (repo root). ✦This is the **sole** upload filter (B3 correction) — it now carries the secret excludes itself, so it stays safe even for future `railway up` runs from a fuller tree:

```
.git/
docs/
development-plans/
e2e/
.claude/
.stage/
infra/perf/
backend/.mypy_cache/
backend/.ruff_cache/
backend/celerybeat-schedule*
backend/.coverage
backend/.venv/
.venv/
venv/
__pycache__/
node_modules/
frontend/dist/
frontend/.angular/
.env
*.env
!*.env.example
infra/certs/
*.p12
*.pem
*.key
.DS_Store
```

**C5. `infra/railway/gotenberg-deny-list.txt`** ✦(single source for the 700-char SSRF regex — no manual transcription at mutation-writing time). One line, byte-identical to the `GOTENBERG_DENY_LIST` **default in `backend/config/settings/base.py`** (single trailing `$` — NOT the `docker-compose.prod.yml` copy, whose `$$` is compose escaping; no commas anywhere — Gotenberg's flag parser splits on them):

```
^file:(?!//\/tmp/).*|^[a-z]+://(?:[^/@]*@)?(localhost|127\.\d+(\.\d+)?(\.\d+)?|0\.0\.0\.0|0x[0-9a-f]+|0\d+(\.\d+)?(\.\d+)?(\.\d+)?|\d\d\d\d\d\d\d\d\d?\d?|\[?::1\]?|\[?::ffff:.*|\[?0:0:0:0:0:(0|ffff):.*|\[?fd[0-9a-f][0-9a-f]:.*|\[?fe80:.*|169\.254\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(6[4-9]|7\d|8\d|9\d|1[01]\d|12[0-7])\.\d+\.\d+|198\.1[89]\.\d+\.\d+|192\.88\.99\.\d+|\[?64:ff9b:.*|100\.100\.200\.200|metadata\.google\.internal|metadata\.goog|.*\.internal|api|web|db|redis|storage|mailpit|gotenberg|beat|worker-default|worker-heavy|worker-render)\.?([:/].*)?$
```

After writing it, **verify byte-equality against the repo**: extract the default from `~/zenpdf/backend/config/settings/base.py` (python: read file, locate the `GOTENBERG_DENY_LIST` `default=r"…"` raw string, compare to the file's stripped content) — mismatch = STOP and reconcile before D6. Its `.*\.internal` alternative covers `*.railway.internal`, so the guard holds on Railway (layer 1, `apps/core/urlguard.py`, independently blocks `fd00::/8` after DNS resolution).

---

## 6. Phase D — build the Railway project

All from `~/zenpdf`, secrets sourced (§2). Sub-phases renumbered ✦so every value exists before first use: domain (D4) now precedes variables (D5).

**D1. Project + databases** (databases created only after A3's region default is confirmed — else create them here and rely on D2):

```bash
railway init --name zenpdf --json          # creates project + links cwd (production env)
railway add -d postgres --json
railway add -d redis --json
```

If `init` errors on workspace ambiguity: re-run with `-w "<workspace name from railway whoami>"`. From `railway status --json` capture: project id, environment id (`production`), each service's id, and the **actual DB service names** (expected `Postgres`/`Redis`; D5's `${{Postgres.…}}`/`${{Redis.…}}` references must match the real names — adjust if they differ).

**D2. Regions.** Confirm every service (incl. DBs) shows `europe-west4-drams3a` in `railway status --json`. For any that don't:

```bash
railway api 'mutation { serviceInstanceUpdate(serviceId: "<SID>", environmentId: "<EID>", input: { region: "europe-west4-drams3a" }) }'
```

DBs then need a redeploy to move (they are empty — cheap): `railway redeploy -s Postgres -y` (same for Redis). App services just carry the setting into their first deploy.

**D3. App services + volume**

```bash
railway add -s api
railway add -s worker-default
railway add -s worker-heavy
railway add -s worker-render
railway add -s beat
railway add -s web
railway add -s storage   -i chrislusf/seaweedfs:3.97
railway add -s gotenberg -i gotenberg/gotenberg:8
railway volume add -s storage -m /data
```

(One `railway add` per service — the CLI takes one `-s` at a time. The `-i` services may or may not auto-deploy with default commands; harmless — D7 deploys them properly.)

**D4. Claim the domain FIRST** ✦(so D5's `<PUBLIC_HOST>` is a real value):

```bash
railway domain -s web --port 80 --json        # generates <random>.up.railway.app, targetPort 80
railway domain update <generated>.up.railway.app --domain zenpdf -s web
```

✦Skip the v1 `serviceDomainAvailable` pre-check (that query isn't in Railway's documented API): attempt the rename directly; on "taken/unavailable" errors walk the fallbacks in order — `zenpdf-app`, `zen-pdf`, `zenpdf-web` — first success wins. Verify `railway domain list -s web --json` shows exactly one service domain with targetPort 80; record it as `PUBLIC_HOST=…` in `secrets.env`.

**D5. Variables.** `railway variable set 'K=V' … -s <service> --skip-deploys`, every `K=V` single-quoted (§2). Groups:

*(a) Django group — identical on `api`, `worker-default`, `worker-heavy`, `worker-render`, `beat`:*

```
DJANGO_SETTINGS_MODULE=config.settings.prod
SECRET_KEY=<A6>
ALLOWED_HOSTS=$PUBLIC_HOST,healthcheck.railway.app,api.railway.internal
CSRF_TRUSTED_ORIGINS=https://$PUBLIC_HOST
CORS_ALLOWED_ORIGINS=https://$PUBLIC_HOST
FRONTEND_BASE_URL=https://$PUBLIC_HOST
API_BASE_URL=https://$PUBLIC_HOST
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}/0
CACHE_URL=${{Redis.REDIS_URL}}/1
NUM_PROXIES=2
S3_ENDPOINT_URL=http://storage.railway.internal:8333
S3_PUBLIC_ENDPOINT=https://$PUBLIC_HOST
S3_ACCESS_KEY=zenpdf-prod
S3_SECRET_KEY=<A6>
S3_BUCKET=zenpdf
PRESIGNED_DELIVERY=false
GOTENBERG_URL=http://gotenberg.railway.internal:3000
SIGNING_CERT_PATH=/tmp/certs/zenpdf.p12
SIGNING_CERT_PASSWORD=<A6>
SIGNING_CERT_B64=<A7>
TSA_URL=http://timestamp.digicert.com
GUEST_IP_HASH_SALT=<A6>
ABUSE_CONTACT_EMAIL=yuval3000@gmail.com
LOG_FORMAT=json
```

plus, unless `SMTP_SKIPPED`:

```
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USE_TLS=true
EMAIL_HOST_USER=yuval3000@gmail.com
EMAIL_HOST_PASSWORD=<A4>
DEFAULT_FROM_EMAIL=ZenPDF <yuval3000@gmail.com>
```

Everything else stays on the audited prod defaults — notably `SECURE_SSL_REDIRECT=True` (safe behind C3's pinned `X-Forwarded-Proto https`, with `^api/health/` redirect-exempt), HSTS on / preload off, production throttle rates, `ADMIN_ENABLED` off (default `DEBUG`→false).

Three load-bearing lines — do not "simplify":
- `REDIS_URL=${{Redis.REDIS_URL}}/0` + `CACHE_URL=${{Redis.REDIS_URL}}/1`: Railway's `REDIS_URL` reference has **no path segment**, and `settings/base.py` derives `CACHE_URL` via `REDIS_URL.rsplit("/", 1)[0] + "/1"` — against a pathless URL that yields the garbage `redis://1` and every throttle/counter breaks at first request (review re-verified the string math). The `/0` suffix keeps the derivation harmless; explicit `CACHE_URL` bypasses it entirely.
- `S3_PUBLIC_ENDPOINT` must be a parseable URL even with presign off — `apps/pdf_engine/storage.py` eagerly builds the presign client in `__init__`.
- `ALLOWED_HOSTS` includes `healthcheck.railway.app` — Railway's healthcheck sends that Host header; without it every api deploy 400s its own healthcheck.

*(b) `api` only:* `PORT=8000` (nginx's upstream and the healthcheck probe agree on it).
*(c) Build selection:* `RAILWAY_DOCKERFILE_PATH=infra/railway/api.Dockerfile` on api + 3 workers + beat; `RAILWAY_DOCKERFILE_PATH=infra/railway/web.Dockerfile` + `PORT=80` on web. *(If the first build says "Dockerfile not found", retry once with a leading slash — both spellings appear in Railway docs.)*
*(d) `storage` only:* `S3_CONFIG_JSON` — single-line SeaweedFS identity file, same shape as `infra/seaweedfs/s3-config.json` with the generated prod creds:

```json
{"identities":[{"name":"zenpdf","credentials":[{"accessKey":"zenpdf-prod","secretKey":"<S3_SECRET_KEY>"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
```

*(e) `gotenberg` only:* `PORT=3000`.

**D6. Service settings** — `serviceInstanceUpdate` per service. ✦**Every startCommand is `/bin/sh -c "…"`**: Railway runs custom start commands on Dockerfile/image deploys in **exec form** (no shell, no `$VAR`, no `&&` — documented; v1's bare commands were the review's blocker). ✦Write each mutation to a file and run `railway api --file <f>` (flag verified) — avoids shell-escaping the escapes. Inside the GraphQL string: escape `"` as `\"`; prefer single quotes inside the sh command. Template (api, the most complex):

```graphql
mutation {
  serviceInstanceUpdate(
    serviceId: "<API_SID>", environmentId: "<EID>",
    input: {
      startCommand: "/bin/sh -c 'mkdir -p /tmp/certs && printf %s \"$SIGNING_CERT_B64\" | base64 -d > /tmp/certs/zenpdf.p12 && exec gunicorn config.wsgi:application --bind [::]:$PORT --workers 4 --timeout 120'",
      preDeployCommand: ["/bin/sh -c 'python manage.py migrate --noinput && python manage.py init_storage'"],
      healthcheckPath: "/api/health/live",
      region: "europe-west4-drams3a"
    }
  )
}
```

(✦`preDeployCommand` is a one-element array, itself sh-wrapped — config-as-code documents it as maxItems-1 array and its exec semantics are undocumented, so the wrapper is load-bearing. It runs post-build, pre-traffic, inside the private network, with the service's env vars; failure blocks the deploy.)

Per-service values (all wrapped `/bin/sh -c '…'`; *(cert prefix)* = `mkdir -p /tmp/certs && printf %s "$SIGNING_CERT_B64" | base64 -d > /tmp/certs/zenpdf.p12 && `):

| Service | startCommand (inside `/bin/sh -c '…'`) | preDeploy | healthcheckPath |
|---|---|---|---|
| `api` | *(cert prefix)* `exec gunicorn config.wsgi:application --bind [::]:$PORT --workers 4 --timeout 120` | migrate + init_storage (above) | `/api/health/live` |
| `worker-default` | *(cert prefix)* `exec celery -A config worker -Q default -c 2 --max-memory-per-child 1500000 --time-limit 300 --soft-time-limit 240` | — | — |
| `worker-heavy` | *(cert prefix)* `exec celery -A config worker -Q heavy -c 1 --max-memory-per-child 1500000 --time-limit 900 --soft-time-limit 600 --max-tasks-per-child 20` | — | — |
| `worker-render` | *(cert prefix)* `exec celery -A config worker -Q render -c 2 --max-memory-per-child 1500000 --time-limit 300 --soft-time-limit 240` | — | — |
| `beat` | `exec celery -A config beat -s /tmp/celerybeat-schedule` | — | — |
| `web` | *(none — image CMD)* | — | `/health` |
| `storage` | `mkdir -p /etc/seaweedfs && printf %s "$S3_CONFIG_JSON" > /etc/seaweedfs/s3-config.json && exec weed -logtostderr=true server -s3 -dir=/data -s3.config=/etc/seaweedfs/s3-config.json -ip.bind=0.0.0.0` | — | — |
| `gotenberg` | `exec gotenberg --chromium-disable-javascript=true '--chromium-deny-list=<C5 regex>'` — regex inlined programmatically from the C5 file, see below | — | `/health` |

Gotenberg's deny-list: build its mutation file by **inlining the C5 file's content** programmatically (python reads `infra/railway/gotenberg-deny-list.txt`, JSON-escapes it into the GraphQL string as `--chromium-deny-list=<regex>` inside the sh-wrapped command, single-quoted so sh passes it as one argv) — never hand-transcribe. Since `/bin/sh -c` bypasses the image ENTRYPOINT on Railway, `exec gotenberg …` invokes the binary directly (it's on PATH in the image). The same bypass applies to `storage` — SeaweedFS's entrypoint quirks are moot (✦resolves v1's R2).

Everything else per service: `sleepApplication` stays false (default — workers/beat must never sleep), `restartPolicyType` stays ON_FAILURE (default), `numReplicas` stays 1 — **beat must never exceed 1**.

Why `healthcheckPath=/api/health/live` (note: **no trailing slash** — verified route) rather than `/api/health/`: live is dependency-free 200 (verified `apps/core/views.py`); readiness's storage probe calls boto3 `list_buckets()` with **no timeout**, which can hang a deploy gate for minutes if storage misconfigures. Readiness is asserted explicitly in E4 instead.

**D7. Deploy, dependency-ordered, with real gates.** ✦`railway up --ci` exits at **build** completion and proves nothing about the deploy; and first builds (~8–12 min: apt + the PDF-engine pip stack; assume five cold builds — cross-service layer-cache sharing is undocumented) outlast the 10-min Bash cap. So: detach + poll. Define the gate as a poll loop:

```bash
gate () {  # gate <service-name> — poll until latest deployment SUCCESS (fail on FAILED/CRASHED)
  for i in $(seq 1 90); do
    S=$(railway status --json | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(s for s in <path-to-services> if s['name']=='$1')<path-to-latest-deploy-status>)" 2>/dev/null) || S=UNKNOWN
    case "$S" in SUCCESS) return 0;; FAILED|CRASHED) return 1;; esac
    sleep 20
  done; return 1
}
```

(The exact JSON paths aren't pinned here — on first run, dump `railway status --json` once and adapt the two `<path-…>` extractors; that's a 2-minute executor task, and `railway status`'s per-service deploy status is documented.)

```bash
railway redeploy -s storage -y  || railway api --file deploy-storage.graphql   # ✦fallback: serviceInstanceDeployV2(serviceId,environmentId) — redeploy fails if the image service never had a deployment
gate storage      # then: railway logs -s storage -n 50 → weed S3 listening on 8333
railway redeploy -s gotenberg -y || railway api --file deploy-gotenberg.graphql
gate gotenberg
railway up -d -s api .            # build+pre-deploy(migrate,init_storage)+healthcheck
gate api                          # ✦HARD GATE: nothing else deploys until api is SUCCESS — this is what guarantees migrate-before-beat
railway up -d -s worker-default . && railway up -d -s worker-heavy . && railway up -d -s worker-render .
gate worker-default; gate worker-heavy; gate worker-render
railway up -d -s beat .           # workers BEFORE beat — docs/ops/deploy.md ordering
gate beat
railway up -d -s web .
gate web
```

Any gate failure → `railway logs -b -s <svc> -n 200` (build) / `railway logs -s <svc> -n 200` (runtime), Appendix A, fix, redeploy. Storage-first matters: api's pre-deploy `init_storage` is the **only** bucket-creation path in the repo (verified) and needs SeaweedFS answering on the private network.

**D8. Private-DNS sanity check** (the one materially UNVERIFIED platform detail — the resolver IP inside new dual-stack environments):

```bash
railway ssh -s web -- cat /etc/resolv.conf
```

`fd12::10` present → done. Different resolver → regenerate `nginx.railway.conf` with it, `railway up -d -s web . && gate web`. `railway ssh` unavailable (key registration failed in A5) → rely on E3: if `/api/` proxies, the resolver works as written.

**D9. Backups.** Confirm the Postgres template's backup schedule; enable a daily schedule on the `storage` volume: `railway api describe volumeInstanceBackupScheduleUpdate`, then issue it for both volumes (kinds: DAILY). If the schema fights back, do it via Chrome (service → volume → Backups → Daily) — the one acceptable dashboard step. Report which path was taken. (RPO stance stays `docs/ops/restore-drill.md`'s 24 h.)

---

## 7. Phase E — verification (evidence, not vibes)

In order; each step names its pass condition. On failure: Appendix A + `railway logs -s <svc> -f '@level:error' -S 10m`.

- **E1** `railway status --json` — all 10 services SUCCESS, region `europe-west4-drams3a`, beat replicas = 1.
- **E2** `curl -fsS https://$PUBLIC_HOST/health` → `ok` (nginx, edge, TLS).
- **E3** `curl -fsS https://$PUBLIC_HOST/api/health/live` → `{"status":"ok"}` (nginx→api private mesh).
- **E4** `curl -fsS https://$PUBLIC_HOST/api/health/ | jq` — poll ≤ 5 min until `status:"ok"` and **every** check true: `db, redis, storage, gotenberg, workers` (workers flips after beat's first heartbeats, ~60–120 s). `storage:true` proves SeaweedFS+bucket+creds; `redis:true` proves the `/0`–`/1` split.
- **E5** `curl -fsS https://$PUBLIC_HOST/ads.txt` → 200 text. `curl -sI https://$PUBLIC_HOST/` → 200 + `content-security-policy` + `cache-control: no-cache`. Prerender spot-check: `curl -fsS https://$PUBLIC_HOST/merge-pdf | grep -qi '<title'`.
- **E6 End-to-end guest job:** make a tiny PDF (`pip install pypdf --break-system-packages; python3 -c "from pypdf import PdfWriter; w=PdfWriter(); [w.add_blank_page(200,200) for _ in range(2)]; w.write('/tmp/t.pdf')"`). Read exact endpoint shapes from `https://$PUBLIC_HOST/api/schema/`. Then: unauthenticated API call → capture `X-Guest-Token` from the response (lazy guest mint — verified middleware); upload the PDF; run a cheap page op (rotate/merge per schema); poll the job to success; download the artifact; assert size > 0. Proves upload → storage write → default-lane worker → storage read → API streaming across the private mesh.
- **E7 Signing cert present:** `railway ssh -s api -- ls -l /tmp/certs/zenpdf.p12`, same on `worker-heavy` (skip if ssh unavailable — E9's guest-sign smoke is the functional check).
- **E8 Throttle-identity, three probes** ✦(expanded per review):
  1. From the container: 12 rapid `POST https://$PUBLIC_HOST/api/auth/login/` (bogus creds) → expect 429 by #11–12 (auth scope 10/min).
  2. **Forged-XFF probe:** same, but with `-H 'X-Forwarded-For: 203.0.113.7'` → must **still** 429 in the same bucket (proves a client cannot pick its own bucket).
  3. **Distinct-client probe:** one attempt from Yuval's Chrome (`javascript_tool` fetch on a tab at the site) → expect 401, **not** 429 (proves buckets are per-IP, not collapsed).
  All three pass → `NUM_PROXIES=2` confirmed; record it. Failures: if (3) 429s, buckets collapsed → try `NUM_PROXIES=1` (redeploy the five Django services) and re-run all three; if no value passes both (2) and (3), apply Appendix B2 (nginx `real_ip` from `X-Real-IP` + `NUM_PROXIES=1`) — terminal fallback. Wait 1 min after for buckets to drain.
- **E9 Smoke suite** from the tarball's `e2e/`:
  ```bash
  cd ~/zenpdf/e2e && npm ci
  # container ships Chromium at /opt/pw-browsers; e2e pins its own Playwright — patch the CLOUD COPY of
  # playwright.config.ts: use.launchOptions.executablePath = process.env.CHROMIUM_BIN
  CHROMIUM_BIN=/opt/pw-browsers/chromium BASE_URL=https://$PUBLIC_HOST npx playwright test --grep @smoke
  ```
  (If the pinned Playwright rejects that binary: `npx playwright install chromium` **inside e2e/** — project-local, allowed since the preinstall doesn't match the pin.) Expect guest flows (phase-2b, phase-8 guest sign, a11y) green. Register/login specs may depend on reading verification mail from Mailpit — inspect `e2e/helpers.ts` first and classify every failure: (a) email-infrastructure-dependent → expected on prod, noted; (b) anything else → real regression, investigate before declaring success. Never wave failures through silently.
- **E10 SMTP probe** (unless skipped): `railway ssh -s api -- sh -c 'cd /app && python manage.py send_test_email --to yuval3000@gmail.com'` (command verified; ✦cwd pinned). Pass = exit 0 + log line `via smtp.gmail.com:587`. If ssh unavailable: register a real account and check the inbox via Gmail MCP if connected; else report "SMTP configured, delivery unverified".
- **E11** ✦Log sweep in bounded fetch mode (streaming mode never exits): `railway logs -s api -f '@level:error' -S 10m -n 200`, same for the three workers + beat. Pass = no recurring errors (one-off startup noise before dependencies settled is fine).
- **E12 Cost snapshot:** dashboard usage page via Chrome → extrapolate monthly into the report.

---

## 8. Phase F — wrap-up

- **F1. Write back to Yuval's repo** (`device_commit_files`): the five Phase C files at their repo paths. Report as "added, uncommitted — commit when happy" (no git operations on the device).
- **F2. Secrets to Yuval's disk**, under `infra/certs/prod/` (gitignored — verified `infra/certs/` + `*.p12` rules; ✦also excluded from future tarballs/uploads by B2+C4): `zenpdf-prod.p12` and `RAILWAY-SECRETS.md` (SECRET_KEY, signing-cert password, S3 keys, Gmail app password if minted, Railway token **name** with a pointer to revoke at railway.com/account/tokens). Include two warnings from `docs/ops/secrets.md`: **SECRET_KEY is a one-way door** (rotation breaks every envelope's audit-chain verification — back it up in a password manager), and the `.p12` must be backed up somewhere the deployment can't reach, then ideally removed from disk.
- **F3. Report** (SendUserMessage — the session may be unattended): final URL, 10-service table with statuses, E1–E12 results incl. smoke triage and the E8 NUM_PROXIES finding, monthly cost estimate, and the deferred list: custom domain; AdSense enablement (CSP additions pre-written in `frontend/nginx.conf` comments — mirror into `nginx.railway.conf` then); Sentry; admin enablement (needs whitenoise/collectstatic first — R9); AATL signing cert; GitHub auto-deploys (Appendix C); Pro-plan volume growth past 5 GB; first restore drill per `docs/ops/restore-drill.md`; correcting `docs/ops/railway.md` gotcha 4 with the measured NUM_PROXIES.
- **F4. Project memory**: update `zenpdf-project.md` (deployed URL, date, topology, E8 finding) and add `zenpdf-railway.md` (project/service ids, region, secrets location, redeploy runbook: fresh B1–B3 snapshot → `railway up -d -s <svc> . && gate <svc>`, api before workers before beat, per `docs/ops/deploy.md`).

---

## Appendix A — symptom → cause table (supplements the skill's)

| Symptom | Likely cause | Fix |
|---|---|---|
| Service exits instantly; logs show `mkdir: cannot …` or the raw command echoed | ✦startCommand not `/bin/sh -c`-wrapped (exec form: no `&&`, no `$VAR`) | D6 |
| api deploy stuck at healthcheck then FAILED | `healthcheck.railway.app` missing from ALLOWED_HOSTS; or trailing slash on `/api/health/live/` (404s); or PORT var ≠ gunicorn bind | D5(a)/(b), D6 |
| Every `/api/` request 502/504 | resolver wrong for this env (D8) or api not listening `[::]:8000` | D8; Appendix B1 last resort |
| `/api/` 400 from Django | web domain missing from ALLOWED_HOSTS (nginx forwards browser Host) | D5(a) |
| CSRF failures on POST | CSRF_TRUSTED_ORIGINS lacks scheme+final host | D5(a) |
| Redirect loop on `/api/` | X-Forwarded-Proto not pinned https (C3 delta 2) | C3 |
| 500s + "relation does not exist" | pre-deploy didn't run/failed — check its own log stream in the deploy logs | D6 api row |
| `checks.storage:false` | S3_CONFIG_JSON mangled vs S3 creds; volume unmounted; weed flags wrong | `railway logs -s storage`; creds must match D5(d)⇄(a) |
| `checks.redis:false` / throttle errors | missing `/0` `/1` suffixes (CACHE_URL derivation bug) | D5(a) |
| `checks.workers:false` > 3 min | beat not up, or beat deployed before workers | D7 order; redeploy beat |
| Sealing jobs fail `engine_error` cert missing/bad | SIGNING_CERT_B64 truncated or p12 password mismatch (A7 verify step catches at source) | A7, D5(a) |
| nginx 413 on big uploads | `client_max_body_size` 120m vs raised MAX_UPLOAD_MB | C3 |
| Downloads 404 only in prod (if presign ever enabled) | S3_ENDPOINT_URL vs S3_PUBLIC_ENDPOINT swapped (`docs/ops/railway.md` gotcha 7) | D5(a) |

## Appendix B — terminal fallbacks

**B1 — public-proxy topology (skill-verified):** only if private networking to api demonstrably fails E3 after D8's resolver fix: `railway domain -s api`; nginx upstream → `https://<api-domain>` with `proxy_ssl_server_name on;` + `proxy_set_header Host <api-domain>;` (per the railway-deployment skill); add the api domain to ALLOWED_HOSTS; `NUM_PROXIES=3` (client → web-edge → nginx-egress → api-edge each append); re-run all of E8; report the deviation + the direct-to-api spoof caveat.

**B2 — real-IP normalization (if E8 finds the edge doesn't set XFF):** in `nginx.railway.conf`, uncomment-equivalent of the pattern already documented in `frontend/nginx.conf`'s comments: `set_real_ip_from ::/0; set_real_ip_from 0.0.0.0/0; real_ip_header X-Real-IP;` + keep `X-Forwarded-For $proxy_add_x_forwarded_for`, and set `NUM_PROXIES=1`. Trusting all peers is sound **only** because web's :80 is reachable exclusively through Railway's edge (no direct ingress), which sets `X-Real-IP` authoritatively — state exactly this justification in the report. Re-run all three E8 probes.

## Appendix C — optional GitHub auto-deploys (post-launch, needs Yuval's nod)

Dockerfiles are root-context, so wiring is: install the Railway GitHub app (Chrome: project → service → Settings → Source), then per app service `railway service source connect --repo yhaspel/ZenPDF --branch main`, keep `RAILWAY_DOCKERFILE_PATH` vars, add `watchPatterns` (web: `frontend/**`+`infra/railway/**`; Django five: `backend/**`+`infra/railway/**`). Until then, redeploys = fresh snapshot + `railway up -d` + gate (F4 runbook).

## Appendix R — accepted risks & known limitations (report honestly)

- **R1** Resolver `[fd12::10]` in new dual-stack envs — unverifiable in advance; D8 measures, B1 is the escape hatch.
- **R2** ✦(downgraded) SeaweedFS/gotenberg entrypoint interplay — moot: `/bin/sh -c` start commands override ENTRYPOINT in exec form (documented), so the binary is invoked directly.
- **R3** Railway edge X-Forwarded-For behavior is undocumented — E8's three probes decide `NUM_PROXIES` empirically; B2 is the terminal fallback. The chain arithmetic itself was independently re-verified (custom `client_ip` and DRF `get_ident` both pick the client for `[client, edge]` at N=2, also under a spoofed prefix).
- **R4** Smoke specs that read verification mail from Mailpit will fail against prod — triage per E9, never mask.
- **R5** Gmail SMTP: ~500/day, personal from-address, no SPF/DKIM alignment; fine for launch, swap for a transactional provider before volume. `EMAIL_TIMEOUT` is not env-settable (absent from settings) — a black-holed SMTP host would block request threads; smtp.gmail.com fails fast; accepted.
- **R6** Storage volume: 5 GB cap on Hobby; a few heavy users fill it (`USER_STORAGE_QUOTA_MB=2048`). Watch `docs/ops/storage-full.md`; Pro grows the volume live to 50 GB+.
- **R7** The `infra/test.sh --e2e` pre-ship gate (`docs/ops/deploy.md`) can't run in the cloud container (no docker). The tree deployed is the one QA'd locally 2026-08-06 (211/211 unit, build+prerender green; e2e not yet run — E9 is its first run, against prod). Yuval may run the gate locally before "go"; the plan doesn't block on it.
- **R8** First deploy has no rollback target; from deploy 2 on, rollback = redeploy of the prior SUCCESS deployment (dashboard or `deploymentRollback`), per `docs/ops/rollback.md` spirit.
- **R9** `ADMIN_ENABLED` stays off: policy, plus **no collectstatic/whitenoise exists** (verified) and nginx 404s `/static/` — enabling admin later is a small deferred project.
- **R10** Public API rate limit 1,000 req/h on Hobby — this run uses well under 300 calls including gate polling (`railway status` counts; the gate polls ≤ every 20 s only while deploys are in flight).
- **R11** `docs/ops/railway.md` gotcha 4 (`NUM_PROXIES=1`) and its `$((2*nproc+1))` gunicorn formula are both superseded here (measured topology; fixed workers) — the report feeds corrections back so the ops doc stays true.
- **R12** ✦`railway status --json`'s exact JSON shape for the gate loop is pinned at execution (dump once, adapt two extractors) — documented CLI surface, undocumented schema; a 2-minute executor task, not a research gap.
