# Deploy

## Before

- [ ] `./infra/test.sh --e2e` green on the commit being shipped.
- [ ] Migrations reviewed: any that rewrite a table on a large database are
      applied out-of-band first (this product has none today; `esign.0003` is
      the largest and it is a column add plus a backfill).
- [ ] `.env.prod` matches `infra/.env.prod.example` — **new variables are the most
      common cause of a broken deploy**, and Django fails loudly for missing
      `SECRET_KEY` only.

## Deploy

### Railway (the live target)

```bash
git push origin main
```

That is the whole deploy. The six app services build from `main` through
Railway's GitHub integration (`docs/ops/railway.md`), each runs its own
pre-deploy migration, and Railway replaces containers behind a healthcheck.
Nothing is deployed that is not a commit — which is the point: the previous
`railway up` snapshots shipped whatever happened to be in the working tree.

Watch it land, rather than assuming:

```bash
railway status                       # every service ● Online
railway logs -s api --build          # the build that just ran
```

`railway up -d -s <svc>` remains the emergency path when a fix cannot wait for
a push. It uploads your working tree, so check `git status --porcelain` first.

### Docker Compose (self-hosting)

**Order matters for the workers.** Restart them *before* beat: the heartbeat
task and its cache keys are versioned with the code, so a new beat talking to
old workers makes `/api/health/` report `workers: false` until they catch up.
It is an alerting false positive, not an outage — the site keeps serving —
but it is the kind that gets a pager ignored.

```bash
docker compose -f infra/docker-compose.prod.yml pull
docker compose -f infra/docker-compose.prod.yml run --rm api python manage.py migrate
docker compose -f infra/docker-compose.prod.yml up -d
```

Migrations run **before** the new code is live, which is why every migration in
this repo has to be backwards-compatible with the previous release for the few
seconds in between.

## After

- [ ] `curl -s https://<host>/api/health/ | jq` → `status: ok`, and `checks.workers`
      is `true` (a green stack with dead workers accepts jobs and runs none).
- [ ] `BASE_URL=https://<host> npx playwright test --grep @smoke` from `e2e/`.
- [ ] Watch the logs for 5 minutes: `docker compose logs -f api worker-default | grep '"level":"ERROR"'`.

If the smoke suite fails, roll back rather than debugging in production —
[rollback.md](rollback.md).
