# Rollback

**Rolling back code is safe. Rolling back a migration usually is not.** Decide
which one you are doing before you type anything.

## Code only (the common case)

```bash
docker compose -f infra/docker-compose.prod.yml up -d --no-deps \
  --scale worker-default=0 api web            # stop new work first
docker compose -f infra/docker-compose.prod.yml pull api web  # previous tag
docker compose -f infra/docker-compose.prod.yml up -d
```

Every migration in this repo is additive (new columns, new tables, a nullable
FK), so the previous release runs against the newer schema. That is a property
worth keeping: **never ship a migration that drops or renames a column in the
same release that stops using it.** Drop it one release later.

## If the migration itself is the problem

Do not reverse it under load. Take the site to maintenance (nginx `503` page),
restore from the last dump ([restore-drill.md](restore-drill.md)), then replay
whatever was written in the gap — the audit chain and the job table make that
possible, storage blobs are content-addressed by key and survive.

## Afterwards

Write down what happened while it is still fresh, and add the check that would
have caught it to `@smoke`.
