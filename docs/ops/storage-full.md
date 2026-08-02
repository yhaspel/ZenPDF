# Storage is full

## What you will see

Uploads fail; the logs carry storage errors from `apps.pdf_engine.storage`;
`/api/health/` shows `checks.storage: false`.

## First, buy time

The three sweepers exist for exactly this and can be run by hand:

```bash
docker compose -f infra/docker-compose.yml exec api python manage.py shell -c "
from apps.core.tasks import guest_purge, exports_purge, trash_purge
print(guest_purge(), exports_purge(), trash_purge())"
```

That deletes expired guest sessions (24 h), exports past their TTL (24 h) and
trash past 30 days — all three are promises already made to users, so running
them early is not a policy change.

## Then, find out who

```bash
docker compose -f infra/docker-compose.yml exec api python manage.py oversized_accounts --over 80
```

Reports accounts over a share of their quota. It changes nothing; the decision
is a human's. `docs/09-storage-hygiene.md` explains why there is no automatic
deletion, and what a dormant-account policy would have to include if one is
ever introduced.

## What is safe to delete, and what is not

| Safe | Never |
|---|---|
| `exports/…` — regenerable, TTL'd | `sign/…` — sealed envelopes and certificates: somebody's evidence of an agreement |
| `thumbs/…` — regenerated on demand | `docs/…` for a document under an open signature request |
| guest `uploads/…` past expiry | anything a `DocumentVersion` row still points at |

Deleting a blob that a row still references leaves the user a file that opens
to an error, which is worse than being out of space.
