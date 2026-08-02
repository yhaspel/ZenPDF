# Restore drill

**A backup nobody has restored is a hypothesis.** Run this quarterly and after
any change to storage, the database, or the backup job itself.

RPO is **24 hours** (nightly dump). RTO measured on the last drill:
_fill this in every time you run it._

## Back up

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

## Restore, into a scratch stack

```bash
createdb zenpdf_restore
pg_restore -d zenpdf_restore --clean --if-exists zenpdf-<date>.dump
DATABASE_URL=postgres://…/zenpdf_restore docker compose up -d api
```

## Verify — the part that makes it a drill rather than a copy

- [ ] `python manage.py check` and `migrate --check` are clean.
- [ ] A document opens and its **bytes** come back: `GET /api/documents/<id>/content/`.
- [ ] A completed envelope still verifies: upload its final PDF to `/verify`
      and confirm `integrity: intact` and the envelope code matches.
- [ ] `python manage.py shell -c "from apps.esign.models import *; print([verify_chain(r)['intact'] for r in SignRequest.objects.filter(status='completed')[:20]])"`
      — all `True`. A restore that breaks the audit chain has destroyed the
      evidence the product exists to produce.
- [ ] Record how long the whole thing took, and put it at the top of this file.
