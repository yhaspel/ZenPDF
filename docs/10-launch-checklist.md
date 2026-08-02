# Launch checklist

Everything below is **owner-executed**. The code is done; these are the items
that need a domain, an account, a card, or a signature, and none of them can be
honestly ticked by the person who wrote the software.

Phase 10 stays 🟠 until this file has no unticked box. Do not tag `v1.0.0`
before then — a version number is a claim about all of it.

## Domain and transport

- [ ] Domain registered and pointed at the deployment.
- [ ] TLS certificate issued and auto-renewing. **Note:** nginx sets HSTS with
      a two-year `max-age`, so a lapsed certificate locks returning visitors
      out for two years, not until you fix it. See `docs/ops/cert-renewal.md`.
- [ ] `FRONTEND_BASE_URL` and `API_BASE_URL` set to the real host — every
      signing link, verification link and unsubscribe link is built from them.
- [ ] `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS` include the domain.
- [ ] CSP verified in a browser with the real page: `docs`, the viewer and the
      ceremony all load. The policy is in `frontend/nginx.conf` with each
      unusual directive explained.

## Mail

- [ ] Real SMTP credentials, and `DEFAULT_FROM_EMAIL` on the domain.
- [ ] **SPF, DKIM and DMARC** published. Without them every signing invitation
      lands in spam and the e-signature product does not work.
- [ ] `ABUSE_CONTACT_EMAIL` is an address somebody reads — it is printed in
      every footer, and it is where "I did not ask for this" arrives.
- [ ] Send yourself a signing invitation and confirm: it arrives in the inbox,
      the one-click unsubscribe button appears in Gmail, and clicking the
      footer link lands on the confirm page rather than unsubscribing you.

## Secrets and access

- [ ] `SECRET_KEY` generated fresh (it signs JWTs *and* keys the audit chain
      and the suppression list — rotating it invalidates sessions and breaks
      chain verification for existing envelopes; see the note below).
- [ ] Seed admin removed or its password rotated (`SEED_ADMIN_*`).
- [ ] `ADMIN_ENABLED`, `ADMIN_URL_PATH` and `ADMIN_IP_ALLOWLIST` set. An empty
      allowlist denies, so an unconfigured admin is a locked door rather than
      an open one — but it also means no moderation until you configure it.
- [ ] Database and storage credentials are platform secrets, not in a file.

> **On rotating `SECRET_KEY` after launch:** existing audit chains verify with
> the key they were written under. Rotating it makes `verify_chain` report
> broken for every completed envelope. If it must be rotated, keep the old key
> and add key-versioning first — this is a one-way door.

## Signing

- [ ] Production signing certificate from a CA (or a written decision to stay
      self-signed — `/verify` says which it is, in as many words).
- [ ] `TSA_URL` set. Without a timestamp, signatures stop verifying when the
      certificate expires rather than remaining valid for the moment they were
      made.

## Legal and ads

- [ ] Privacy Policy and Terms reviewed by a lawyer. They are honest drafts
      written against real behaviour, and the retention numbers are pinned to
      the sweepers by a test — but nobody qualified has read them.
- [ ] E-sign disclosure reviewed. Any change must bump `VERSION` in
      `apps/esign/legal.py`, because its hash is recorded with every consent.
- [ ] Ads: `docs/09-adsense-readiness.md`, which is its own checklist. The
      product ships launchable with `ADS_ENABLED=false`.

## Operations

- [ ] `SENTRY_DSN` set (the wiring ships inert; PII is scrubbed at the SDK
      boundary either way).
- [ ] Alerts on: `/api/health/` non-200, `checks.workers` false, queue depth,
      error rate.
- [ ] Nightly `pg_dump` **and** storage sync running — the database without the
      blobs is a library of broken links.
- [ ] Restore drill performed once, and the time it took written into
      `docs/ops/restore-drill.md`.

## Final

- [ ] Full e2e green three consecutive runs against the prod-shaped stack.
- [ ] `@smoke` green against the deployed host.
- [ ] Lighthouse ≥90 on the deployed prod build (landing and dashboard).
- [ ] `PROGRESS.md` Human review queue has no unresolved GATE row.
- [ ] Tag `v1.0.0`.
