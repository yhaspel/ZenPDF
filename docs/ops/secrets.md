# Secrets and rotation

## Where they live

Platform secrets (Railway variables, or the deployment's equivalent) — never a
file in the repo. `.env` and `infra/certs/` are gitignored and must stay that
way; `infra/.env.example` documents the shape with empty values.

## `SECRET_KEY` — read this before rotating

It does three jobs, and only one of them is the usual one:

1. Signs JWTs — rotating logs everybody out. Fine.
2. Signs the email-verification and unsubscribe tokens — rotating invalidates
   links already in people's inboxes. Annoying, recoverable.
3. **Keys the audit-chain HMAC and the suppression-list hashes.** Rotating
   makes `verify_chain` report *broken* for every envelope already signed, and
   orphans every suppression row. That is not recoverable by re-running
   anything: the old hashes cannot be recomputed without the old key.

So: rotating `SECRET_KEY` after launch needs key-versioning first (keep the old
key for verification, sign new events with the new one). Until that exists,
treat it as a one-way door and protect it accordingly.

## JWT rotation

Access tokens are short-lived; refresh tokens are blacklisted on logout
(`token_blacklist`). To force a global logout without touching `SECRET_KEY`,
truncate the outstanding-token table:

```bash
docker compose exec api python manage.py shell -c "
from rest_framework_simplejwt.token_blacklist.models import OutstandingToken, BlacklistedToken
BlacklistedToken.objects.bulk_create(
    [BlacklistedToken(token=t) for t in OutstandingToken.objects.all()],
    ignore_conflicts=True)"
```

## The signing certificate

`SIGNING_CERT_PATH` / `SIGNING_CERT_PASSWORD` — see
[cert-renewal.md](cert-renewal.md). Store the `.p12` as a platform secret file
with 0600 permissions, back it up somewhere the deployment cannot reach, and
keep the old one: envelopes sealed under it verify against the certificate
embedded in the PDF, but a copy is what lets you answer questions about it.

## Rotating anything else

Database and storage credentials rotate without ceremony — change the variable,
restart the services. Guest tokens are hashed and short-lived; the guest IP
salt (`GUEST_IP_HASH_SALT`) can be rotated no more often than
`GUEST_TTL_MAX_HOURS` (72 h), because every stored hash has aged out by then
and no version column is needed. Rotating it faster silently voids the IP leg
of the guest throttle for in-flight sessions.
