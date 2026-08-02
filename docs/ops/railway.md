# Deploying to Railway

The owner's deploy target. Railway runs one process per service, so the compose
stack maps to eight services plus two managed add-ons.

## Service map

| Railway service | Start command | Notes |
|---|---|---|
| `api` | `gunicorn config.wsgi --bind 0.0.0.0:$PORT --workers $((2 * $(nproc) + 1))` | Public. Run migrations on deploy (below). |
| `worker-default` | `celery -A config worker -Q default -c 2 --time-limit 300 --soft-time-limit 240` | Cheap page ops; 60 s is not enough for a large merge. |
| `worker-heavy` | `celery -A config worker -Q heavy -c 1 --time-limit 900 --soft-time-limit 600 --max-tasks-per-child 20` | OCR and conversion. `--max-tasks-per-child` recycles the process, which is what bounds a slow memory leak in a C parser. |
| `worker-render` | `celery -A config worker -Q render -c 2 --time-limit 300` | Thumbnails; neither cheap nor user-visible, so it gets its own lane. |
| `beat` | `celery -A config beat -s /tmp/celerybeat-schedule` | **Exactly one instance.** Two beats means two of every sweep. |
| `web` | nginx image built from `infra/docker/web.Dockerfile` | Serves the SPA, proxies `/api` and `/ads.txt`. |
| `gotenberg` | `gotenberg/gotenberg:8` with the two hardening flags from `infra/docker-compose.prod.yml` | Private; never expose it. |
| Postgres | Railway plugin | Managed is the right call here. |
| Redis | Railway plugin | Broker **and** cache — the throttles, the captcha pass and the worker heartbeat live in the cache. |
| Storage | External S3-compatible (Cloudflare R2, Backblaze B2, AWS S3) | Railway has no object storage. SeaweedFS on a volume works but you own the backups. |

## Variables

Everything in `infra/.env.example`, translated to Railway variables, plus:

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
4. **The proxy hop** — `NUM_PROXIES=1` is already set, and `client_ip` reads
   the hop *our* proxy appended. If you put another proxy (Cloudflare) in
   front, raise it, or every throttle and the admin allowlist key on the wrong
   address.
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
