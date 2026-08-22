# Storage hygiene: dormant and oversized accounts

**v1 deletes nothing automatically.** The only automatic deletion in the
product is the one the privacy policy states: guest sessions expire after
`GUEST_TTL_HOURS`, trash is purged after `TRASH_RETENTION_DAYS`, exports after
`EXPORT_TTL_HOURS`. An account's own files are kept until the person deletes
them.

That is a deliberate choice, not an omission. The failure mode of an automatic
answer here is deleting somebody's real work because they took four months
off — and there is no undo for that.

## Dormant accounts — the policy

- Dormancy is **reported, never acted on**, in v1.
- If a dormant-account policy is introduced later it must, at minimum: warn by
  email at least 30 days ahead, exclude any account with an open or completed
  signature request (that record is evidence somebody may need), and give one
  click to keep everything.
- Until then, storage pressure is handled by talking to the account holder.

## Oversized accounts — the report

Local / compose:

    docker compose -f infra/docker-compose.yml exec api python manage.py oversized_accounts --over 80

On Railway (production) *(added 2026-08-22 — the command above is compose-only, and production has no `docker compose`)*:

    railway run python manage.py oversized_accounts --over 80

Lists accounts using more than the given percentage of their tier quota,
largest first, with what they use, what they are allowed, and when they last
touched a document. Nothing is changed by running it.

## Moderation actions that do exist

Both are in Django admin, both are reversible, and both are for abuse rather
than housekeeping:

- **Ban** (users): deactivates the account and cancels its open signature
  requests, so a banned sender stops mailing strangers in our name.
- **Move to trash** (documents): soft delete, recoverable for
  `TRASH_RETENTION_DAYS`.

> **⚠ Neither action is reachable in production today** *(corrected 2026-08-22)*. This section ended "Admin itself is IP-gated in production (§17)", which describes a configuration that was never applied. **Admin is OFF in production: `/admin/` answers 404** (measured live 2026-08-10, and re-measured 2026-08-22 while writing this note — still 404). The gate denies when unconfigured, which is the safe default and deliberate — but it means **ban and move-to-trash cannot be performed at all** until the owner sets `ADMIN_ENABLED=true`, `ADMIN_URL_PATH` and a real `ADMIN_IP_ALLOWLIST` (an empty allowlist denies). Both are launch-checklist items. Until then, moderation in production is: change the variables, or nothing.
