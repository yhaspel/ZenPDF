# Jobs are not finishing

## What you will see

Users report "processing" that never ends. `/api/health/` shows
`checks.workers: false`, or `queues.default` / `queues.heavy` climbing.

## Check, in this order

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
