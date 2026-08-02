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
| [railway.md](railway.md) | the owner's deploy target: service map, variables, gotchas |
| [secrets.md](secrets.md) | where secrets live, and why `SECRET_KEY` is a one-way door |
| [dependencies.md](dependencies.md) | the monthly engine-library patch pass |

## The three commands worth knowing before you need them

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
