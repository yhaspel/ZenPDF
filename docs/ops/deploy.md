# Deploy

## Before

- [ ] `./infra/test.sh --e2e` green on the commit being shipped.
- [ ] Migrations reviewed: any that rewrite a table on a large database are
      applied out-of-band first (this product has none today; `esign.0003` is
      the largest and it is a column add plus a backfill).
- [ ] `.env.prod` matches `infra/.env.example` — **new variables are the most
      common cause of a broken deploy**, and Django fails loudly for missing
      `SECRET_KEY` only.

## Deploy

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
