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

## The three commands worth knowing before you need them

```bash
# Is it up, and is anything degraded?
curl -s https://<host>/api/health/ | jq

# What is the queue doing?
curl -s https://<host>/api/health/ | jq .queues

# One request, end to end, across every container
docker compose logs --since 1h | grep <request-id>
```

Every response carries `X-Request-ID`, and every log line carries the same id
plus the principal and the job — so a user's bug report ("it said error at
14:32") becomes one grep rather than an archaeology session.
