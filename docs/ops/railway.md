# Deploying to Railway

The owner's deploy target. Railway runs one process per service, so the compose
stack maps to eight services plus two managed add-ons.

## How a deploy happens

**Push to `main`.** Since 2026-08-10 the six app services — `api`, the three
workers, `beat` and `web` — build from `yhaspel/ZenPDF@main` through Railway's
GitHub integration, so a merged commit is the deploy and the running image is
always attributable to a SHA.

It was not always so, and the reason matters. Until then every deploy was
`railway up`, which uploads a snapshot of **whatever is in the working tree** —
committed or not. That shipped two defects nobody could see in git: fonts and
favicons baked in at mode 0600 because one laptop's umask had left them
unreadable (git records 0644, so a clean checkout was fine), and a landing-page
redesign that was still uncommitted when an unrelated deploy swept it up.
Building from a commit removes the whole class.

`railway up -d -s <svc>` still works and is the escape hatch for an emergency
that cannot wait for a push. Use it knowing it ships your working tree.

**Watch patterns** decide which services a commit rebuilds:

| Service | Rebuilds when a commit touches |
|---|---|
| `web` | `frontend/**`, `infra/railway/**` |
| `api`, `worker-default`, `worker-heavy`, `worker-render`, `beat` | `backend/**`, `infra/railway/**` |

So a backend change leaves `web` alone, a frontend change leaves the Django five
alone, `infra/railway/**` rebuilds everything (it holds both Dockerfiles and the
nginx config), and a commit touching only `docs/` rebuilds nothing at all.

No `railway` subcommand sets them directly, and `railway config` wants the
Railway TypeScript SDK as a repo dependency. But **`railway api` reaches the
public GraphQL API using your existing `railway login` session**, so no token is
involved:

```bash
railway api 'mutation($s: String!, $e: String!, $i: ServiceInstanceUpdateInput!){
  serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $i) }' \
  --variables '{"s":"<serviceId>","e":"<environmentId>",
                "i":{"watchPatterns":["backend/**","infra/railway/**"]}}'
```

`railway api search`/`describe` introspect the schema, and the dashboard does
the same job in six fields (service → Settings → Build → Watch Patterns) if you
would rather click.

Only reach for a minted account token where there is no interactive login — CI,
or a script on a machine nobody has logged in on. If you do, two traps cost an
hour each: the endpoint `https://backboard.railway.com/graphql/v2` sits behind
Cloudflare and refuses any request without a browser-ish `User-Agent` with
**HTTP 403, `error code: 1010`**, which reads exactly like a bad token but is
not one; and a workspace token cannot query `me` (`Not Authorized`) while
working perfectly on `project(id:)` and the mutation, so probe with a project
query, never `me`.

## Service map

| Railway service | Start command | Notes |
|---|---|---|
| `api` | `gunicorn config.wsgi --bind [::]:$PORT --workers 4 --timeout 120` | Private only — nginx reaches it over the private network. Run migrations on deploy (below). **`--timeout`**: the default 30 s kills a large account's data export mid-build and the user gets a 502. **A fixed worker count, not `$((2 * $(nproc) + 1))`**: on Railway Metal `nproc` reports the *host's* cores, so the formula asks for dozens of gunicorn workers on a container sized for a handful and the service OOMs. |
| `worker-default` | `celery -A config worker -Q default -c 2 --time-limit 300 --soft-time-limit 240` | Cheap page ops; 60 s is not enough for a large merge. |
| `worker-heavy` | `celery -A config worker -Q heavy -c 1 --time-limit 900 --soft-time-limit 600 --max-tasks-per-child 20` | OCR and conversion. `--max-tasks-per-child` recycles the process, which is what bounds a slow memory leak in a C parser. |
| `worker-render` | `celery -A config worker -Q render -c 2 --time-limit 300` | Thumbnails; neither cheap nor user-visible, so it gets its own lane. |
| `beat` | `celery -A config beat -s /tmp/celerybeat-schedule` | **Exactly one instance.** Two beats means two of every sweep. |
| `web` | nginx image built from `infra/railway/web.Dockerfile` | Serves the SPA, proxies `/api` and `/ads.txt`. Config is `infra/railway/nginx.railway.conf`. |
| `gotenberg` | `gotenberg/gotenberg:8` with the two hardening flags from `infra/docker-compose.prod.yml` | Private; never expose it. |
| Postgres | Railway plugin | Managed is the right call here. |
| Redis | Railway plugin | Broker **and** cache — the throttles, the captcha pass and the worker heartbeat live in the cache. |
| Storage | External S3-compatible (Cloudflare R2, Backblaze B2, AWS S3) | Railway has no object storage. SeaweedFS on a volume works but you own the backups. |

## Variables

Everything in `infra/.env.prod.example`, translated to Railway variables, plus:

```
DJANGO_SETTINGS_MODULE=config.settings.prod
ALLOWED_HOSTS=<your-domain>,<service>.up.railway.app
CSRF_TRUSTED_ORIGINS=https://<your-domain>
FRONTEND_BASE_URL=https://<your-domain>
API_BASE_URL=https://<your-domain>
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

`FRONTEND_BASE_URL` and `API_BASE_URL` are not cosmetic: every signing link,
verification link and unsubscribe link in every email is built from them, and
`ads.txt` is served from the API through nginx.

## Gotchas, in the order they usually bite

1. **`ALLOWED_HOSTS`** — Railway's health check hits the internal hostname.
   Include both it and your domain, or every deploy fails its own health check.
2. **`$PORT`** — Railway assigns it; gunicorn and nginx must bind to it rather
   than to 8000/80.
3. **Migrations** — set a deploy command (`python manage.py migrate --noinput`)
   rather than running them in the start command, or every replica races.
4. **The proxy hop** — **`NUM_PROXIES=3`**, which is the value measured against
   the running stack, not the 1 this file used to claim or the 2 the deploy plan
   predicted. The chain is browser → Railway edge → our nginx → gunicorn, and
   `client_ip` counts from the right, so an undercount reads a proxy's address
   as the client and every throttle and the admin allowlist key on the wrong
   one. If you put another proxy (Cloudflare) in front, raise it again.
5. **`SECURE_SSL_REDIRECT`** with Railway's TLS termination needs
   `SECURE_PROXY_SSL_HEADER`, which `config/settings/prod.py` sets. The health
   endpoints are exempt (`SECURE_REDIRECT_EXEMPT`), because the platform probes
   them over plain HTTP inside the private network.
6. **Beat's schedule file** — the default path is inside the image and resets
   on deploy, which is harmless (the schedule is in settings). Do not point it
   at a volume shared with another instance.
7. **Storage credentials** — `S3_ENDPOINT_URL` must be the API endpoint, not
   the public one; `S3_PUBLIC_ENDPOINT` is what presigned URLs are built from,
   and getting them the wrong way round produces downloads that work in dev and
   404 in production.

## After the first deploy

Work through `docs/10-launch-checklist.md`. Health first:

```bash
curl -s https://<domain>/api/health/ | jq
BASE_URL=https://<domain> npx playwright test --grep @smoke   # from e2e/
```
