# Storage is full

## What you will see

Uploads fail; the logs carry storage errors from `apps.pdf_engine.storage`;
`/api/health/` shows `checks.storage: false`.

## On Railway (production)

*(Added 2026-08-22 — production is Railway. The compose commands below are the local stack.)*

**What you are actually full of:** production storage is **SeaweedFS on a 50 GB Railway volume** (Pro plan), not an elastic bucket. That is the number to think in — 50 GB is a ceiling you can hit, and unlike S3 it does not quietly absorb a bad week.

```bash
curl -s https://zenpdf.up.railway.app/api/health/ | jq .checks.storage
railway logs -s storage          # SeaweedFS
railway run python manage.py oversized_accounts --over 80
```

**Buy time the same way** — the four sweepers are promises already made to users, so running them early is not a policy change:

```bash
railway run python manage.py shell -c "
from apps.core.tasks import guest_purge, exports_purge, trash_purge, jobs_purge
print(guest_purge(), exports_purge(), trash_purge(), jobs_purge())"
```

**Growth check, before you resize.** Look at the volume's usage graph in the dashboard alongside `oversized_accounts`: a steady climb is capacity planning (resize the volume, which Railway does without data loss), while a step change is one principal or one loop and resizing only buys it room. Two known unbounded-by-design consumers to rule out first, both open queue rows: **account-side `uploads/…` image assets have no sweeper** (`purge_principal_assets` runs only on guest purge and account deletion), and **documents under a signature request are `PROTECT`ed and survive the 30-day trash promise for ever** — the nightly sweep retries them and never wins.

**Do not** move production to external S3 as an incident action. It is a reasonable future choice and it is a migration, not a mitigation.

## First, buy time — local / compose

The sweepers exist for exactly this and can be run by hand:

```bash
docker compose -f infra/docker-compose.yml exec api python manage.py shell -c "
from apps.core.tasks import guest_purge, exports_purge, trash_purge, jobs_purge
print(guest_purge(), exports_purge(), trash_purge(), jobs_purge())"
```

That deletes expired guest sessions (24 h), exports past their TTL (24 h),
trash past 30 days and finished job rows past a year — all four are promises
already made to users, so running them early is not a policy change.

`jobs_purge` will free the least of the four by a wide margin: it exists to
bound row growth, not bytes, and it deletes an `exports/` prefix only in the
rare case `exports_purge` has not already got there. Run it last, and do not
expect it to be the answer.

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
