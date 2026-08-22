# Jobs are not finishing

## What you will see

Users report "processing" that never ends. `/api/health/` shows
`checks.workers: false`, or `queues.default` / `queues.heavy` climbing.

## On Railway (production)

*(Added 2026-08-22 — production is Railway. The compose commands below are the local stack.)*

```bash
curl -s https://zenpdf.up.railway.app/api/health/ | jq '{workers: .checks.workers, age: .worker_heartbeat_age_seconds, queues}'
railway logs -s worker-heavy    # and worker-default, worker-render
```

There are **three worker services** — `worker-default`, `worker-heavy` (OCR, conversion, compare, redact, compress) and `worker-render` — plus `beat`. Read the health payload first: which queue is climbing tells you which service to look at, and a `workers: false` with all three services ● Online is a Redis problem, not a worker problem.

**To restart:** use **Restart** on the service in the dashboard (or redeploy its current deployment). Restart the one whose queue is stuck; restarting all three at once loses whatever each was mid-way through, and a job killed mid-flight is `reap_stalled_jobs`' problem afterwards.

Two Railway-specific things worth knowing before you restart anything:

- **The workers carry `--max-memory-per-child 1500000`**, so a worker child recycling itself after a large document is **normal** and is not the incident. A restart loop in the logs at that boundary is the guard working.
- **`beat` must be exactly one instance.** If queue depth is fine but every sweep is running twice, check that `beat` was not scaled to 2 — that is a different incident with the same symptom.

Everything below — the queued/started reasoning, purging, and what *not* to do — applies unchanged; only the commands differ.

## Check, in this order — local / compose

```bash
curl -s https://<host>/api/health/ | jq '{workers: .checks.workers, age: .worker_heartbeat_age_seconds, queues}'
docker compose -f infra/docker-compose.prod.yml ps            # is the worker even up?
docker compose -f infra/docker-compose.prod.yml logs --tail 200 worker-heavy
```

Three distinct failures wear the same face:

1. **Workers are dead** (`workers: false`, heartbeat stale, queues climbing).
   Restart them. If they die again immediately, read the last 200 lines —
   an OOM kill shows as exit 137.
2. **Workers are alive but starved** (`workers: true`, `heavy` climbing,
   `default` fine). Long OCR or conversion jobs are holding the heavy lane.
   That is the lane doing its job; scale `worker-heavy` or wait.
3. **Redis lost the queue** (queues at 0, jobs still `queued` in the database).
   The rows are the truth and the beat sweeper will reap them —
   `reap_stalled_jobs` marks anything running past its limit as failed with a
   message, every 5 minutes, so users get an error rather than silence.

Optional second look, dev only: `docker compose -f infra/docker-compose.yml
--profile flower up -d flower` gives a task-by-task view at
http://127.0.0.1:5555. It has no login and can revoke tasks, which is why it is
loopback-only and absent from the production compose — production answers the
same question through `/api/health/`.

## Fix

```bash
docker compose -f infra/docker-compose.prod.yml restart worker-default worker-heavy worker-render
# Nothing is lost: a job's state lives in Postgres, and an interrupted task is
# reaped and marked failed rather than left running forever.
```

If a *single* document reliably kills a worker, find it and quarantine it:

```bash
docker compose -f infra/docker-compose.yml exec api python manage.py shell -c "
from apps.jobs.models import Job
print(Job.objects.filter(status='running').values_list('id','type','document_id')[:20])"
```

That document is a hostile-corpus candidate — add it to
`backend/tests/fixtures/generate_fixtures.py` and to
`apps/pdf_engine/tests/test_hostile_corpus.py` so it cannot come back.
