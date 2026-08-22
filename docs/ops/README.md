# Runbooks

Short, specific, and written to be read at 3am by somebody who did not build
this. Each one says what you will see, what to check first, and what to do —
in that order, because the first question in an incident is always "is it
actually broken".

| Runbook | When |
|---|---|
| [deploy.md](deploy.md) | shipping a release |
| [rollback.md](rollback.md) | the release is worse than what it replaced |
| [restore-drill.md](restore-drill.md) | quarterly, and after any restore-affecting change |
| [queue-stuck.md](queue-stuck.md) | jobs sit in `queued`, nothing finishes |
| [storage-full.md](storage-full.md) | uploads fail, storage errors in the logs |
| [cert-renewal.md](cert-renewal.md) | TLS or the signing certificate is expiring |
| [release.md](release.md) | what the suites are and when they run |
| [secrets.md](secrets.md) | where secrets live, and why `SECRET_KEY` is a one-way door |
| [dependencies.md](dependencies.md) | the monthly engine-library patch pass |

**Production is Railway** — live since 2026-08-08, auto-deploying from `main` since 08-10. These four are the Railway record *(indexed here 2026-08-22; this table listed only `railway.md`)*:

| Railway doc | What it is |
|---|---|
| [railway.md](railway.md) | **The live target.** Service map, variables, per-service start commands, gotchas. Start here. |
| [railway-deploy-plan.md](railway-deploy-plan.md) | The plan that was executed on 2026-08-08 — historical, kept for the reasoning |
| [railway-deploy-report-2026-08-08.md](railway-deploy-report-2026-08-08.md) | What actually happened, with the evidence and the four gotchas that bit |
| [railway-handoff-claude-cli.md](railway-handoff-claude-cli.md) | H1–H3, the three things the deploy could not finish. H2 and H3 were done 2026-08-21; **H1 (proving the production certificate seals) is open and gates launch** |

## The commands worth knowing before you need them

The block below is **compose** — the local stack and any VM-hosted copy. Production is Railway, where you have no `docker compose`; the equivalents are on the right.

| What you want | Local / compose | On Railway (production) |
|---|---|---|
| Logs for one service | `docker compose -f infra/docker-compose.yml logs -f <svc>` | `railway logs -s <svc>` (or the service's Deployments tab) |
| Follow one request across services | `docker compose … logs --since 1h \| grep <request-id>` | `railway logs -s api \| grep <request-id>`, repeated per service — there is no cross-service grep |
| Restart a service | `docker compose … restart <svc>` | **Restart** on the service in the dashboard, or redeploy the current deployment |
| Run a management command | `docker compose … exec -T api python manage.py <cmd>` | `railway run python manage.py <cmd>` (runs against production's variables — read the command before you run it) |
| A shell in the container | `docker compose … exec api sh` | `railway ssh` — **not always available**; the 08-08 deploy could not establish it from a sandbox |
| Health | `curl -s http://localhost:8010/api/health/ \| jq` | `curl -s https://zenpdf.up.railway.app/api/health/ \| jq` |

```bash
# What are the hottest queries actually costing? (dev only — prod runs managed
# Postgres, where the app role cannot CREATE EXTENSION)
docker compose -f infra/docker-compose.yml exec -T db psql -U zen -d zenpdf -c \
"SELECT calls, round(mean_exec_time::numeric,2) mean_ms,
        round(total_exec_time::numeric,0) total_ms, rows, left(query,90) query
 FROM pg_stat_statements WHERE query NOT LIKE '%pg_stat_statements%'
 ORDER BY total_exec_time DESC LIMIT 15;"

# Is it up, and is anything degraded?
curl -s https://<host>/api/health/ | jq

# What is the queue doing?
curl -s https://<host>/api/health/ | jq .queues

# One request, end to end, across every container
docker compose -f infra/docker-compose.yml logs --since 1h | grep <request-id>
```

Every response carries `X-Request-ID`, and every log line carries the same id
plus the principal and the job — so a user's bug report ("it said error at
14:32") becomes one grep rather than an archaeology session.
