# Rollback

**Rolling back code is safe. Rolling back a migration usually is not.** Decide
which one you are doing before you type anything.

## On Railway (production)

*(Added 2026-08-22. This is the live target — production has been on Railway since 2026-08-08, auto-deploying from `main`. The compose sections below are for the local stack and any VM-hosted copy.)*

**A rollback is a redeploy of the previous SUCCESS deployment**, not a git revert. In the service's **Deployments** tab, find the last deployment marked SUCCESS before the bad one and choose **Redeploy**.

Order matters, for the same reason as compose: **stop new work first.** Roll back `worker-default`, `worker-heavy` and `worker-render` before `api`, so no worker picks up a job written by code you are about to remove.

> **⚠ The trap that bit on 2026-08-08 — the frozen manifest.** A redeploy re-runs that deployment's **frozen `serviceManifest`**, including the start command it was created with. If anything has since changed a service's start command or variables, a redeploy silently reverts those too — this is exactly how `railway redeploy` ignored freshly-written start commands during the initial deploy (deploy report, gotcha 4). **Before redeploying, check the current start command and variables; after redeploying, check them again.** If they moved, set them and redeploy once more.
>
> The signing certificate lives in that start command (`printf %s "$SIGNING_CERT_B64" | base64 -d > /tmp/certs/zenpdf.p12 && exec …`), so a manifest that reverts it takes sealing down with it. Verify `/api/health/` and one seal after any rollback.

**Auto-deploy will undo you.** Production deploys from `main` on push. A rollback in the dashboard is temporary — the next push to `main` ships forward again. Either revert on `main` in git as well, or accept that the rollback lasts only until the next merge, and say which in the incident note.

Because Postgres is managed, a migration rollback is a **restore**, not a `pg_restore` you run yourself — see the Railway section of [restore-drill.md](restore-drill.md).

## Code only (the common case) — local / compose

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
