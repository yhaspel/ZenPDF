# Restore drill

**A backup nobody has restored is a hypothesis.** Run this quarterly and after
any change to storage, the database, or the backup job itself.

RPO is **24 hours** (nightly dump / daily volume snapshot). RTO measured on the last drill:
**never run — this drill has not been performed.** *(Stated plainly 2026-08-22; the line said "_fill this in every time you run it_", which read as though it had been. It is an open Phase-10 acceptance item and an owner task: it needs a Railway token.)*

## On Railway (production)

*(Added 2026-08-22. The compose procedure below is the local stack and any VM-hosted copy; it is **not** how production restores, because production's Postgres is managed and its blobs are on a Railway volume.)*

**What production actually is:** managed Postgres (Railway plugin), and **SeaweedFS 3.97 on a 50 GB Railway volume** for object storage — not external S3. So there are two different restore mechanisms and neither is `pg_restore` from a dump you took.

**Back up**

- **Database:** Railway's managed Postgres backups, in the plugin's Backups tab. Confirm the schedule is on — it is one of the owner's open dashboard items.
- **Storage:** **volume snapshots** on the SeaweedFS volume, daily. Railway snapshots the volume; nobody dumps the bucket.

Both halves matter and they are not interchangeable — the same rule as compose: the database without the blobs is a library of broken links, and the blobs without the database are files nobody can find. On Railway they are also **not snapshotted at the same instant**, so expect a skew of minutes between the two and treat the older of the pair as the real RPO.

**Restore**

1. Restore the Postgres backup into a **new** database (the plugin offers restore-to-new; never restore over the live one to test it).
2. Restore the volume snapshot onto a **scratch service**, not the live one.
3. Point a throwaway API service at both — same variables as production but with `DATABASE_URL` and the storage endpoint swapped — and run `python manage.py migrate --check` with `railway run`.
4. Work through **the same Verify checklist below**. It is the part that makes this a drill rather than a copy, and the audit-chain step is the one that matters most.

**Then record the RTO at the top of this file.** That is the deliverable; the restore itself is just how you get it.

## Back up — local / compose

```bash
# Database
docker compose -f infra/docker-compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > zenpdf-$(date +%F).dump

# Storage — every document version, every signed envelope, every export
aws s3 sync s3://zenpdf s3://zenpdf-backup --delete   # or `rclone sync`
```

Both halves matter and they are not interchangeable: the database without the
blobs is a library of broken links, and the blobs without the database are
files nobody can find.

## Restore, into a scratch stack — local / compose

```bash
# All of it inside the containers — nothing here assumes psql on the host.
docker compose -f infra/docker-compose.prod.yml exec -T db \
  createdb -U "$POSTGRES_USER" zenpdf_restore
docker compose -f infra/docker-compose.prod.yml exec -T db \
  pg_restore -U "$POSTGRES_USER" -d zenpdf_restore --clean --if-exists \
  < zenpdf-<date>.dump

# Point a throwaway API at the restored database. Substitute the real
# credentials — this line is the one people paste without reading.
docker compose -f infra/docker-compose.prod.yml run --rm \
  -e DATABASE_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@db:5432/zenpdf_restore" \
  api python manage.py migrate --check
```

## Verify — the part that makes it a drill rather than a copy

*(Applies to both paths. On Railway, run the management commands with `railway run` against the scratch service.)*

- [ ] `python manage.py check` and `migrate --check` are clean.
- [ ] A document opens and its **bytes** come back: `GET /api/documents/<id>/content/`.
- [ ] A completed envelope still verifies: upload its final PDF to `/verify`
      and confirm `integrity: intact` and the envelope code matches.
- [ ] `python manage.py shell -c "from apps.esign.models import *; print([verify_chain(r)['intact'] for r in SignRequest.objects.filter(status='completed')[:20]])"`
      — all `True`. A restore that breaks the audit chain has destroyed the
      evidence the product exists to produce.
- [ ] Record how long the whole thing took, and put it at the top of this file.
