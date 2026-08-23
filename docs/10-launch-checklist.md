# Launch checklist

Everything below is **owner-executed**. The code is done; these are the items
that need a domain, an account, a card, or a signature, and none of them can be
honestly ticked by the person who wrote the software.

Phase 10 stays 🟠 until this file has no unticked box. Do not tag `v1.0.0`
before then — a version number is a claim about all of it.

> **Status as of 2026-08-21 — added 2026-08-22, and deliberately nothing is ticked.** Several boxes below are *de facto* satisfied by the Railway deploy of 2026-08-08 and the audits since. They are left unticked because **you tick them**, not an agent — but you should tick them from evidence rather than from memory, so the evidence is now written under each section. Where a note says "satisfied", it means somebody measured it and said where; where it says "open", nobody has.

## Domain and transport

- [ ] Domain registered and pointed at the deployment.
- [ ] TLS certificate issued and auto-renewing. **Note:** nginx sets HSTS with
      a two-year `max-age`, so a lapsed certificate locks returning visitors
      out for two years, not until you fix it. See `docs/ops/cert-renewal.md`.
- [ ] `FRONTEND_BASE_URL` and `API_BASE_URL` set to the real host — every
      signing link, verification link and unsubscribe link is built from them.
- [ ] `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS` include the domain.
- [ ] CSP verified in a browser with the real page: `docs`, the viewer and the
      ceremony all load. **Production's policy is `infra/railway/nginx.railway.conf`**
      *(corrected 2026-08-22 — this named `frontend/nginx.conf`, which is the
      compose copy; the two are kept in step, but the one that serves users is
      the Railway conf)*, with each unusual directive explained.

> **Status 2026-08-21.** *Satisfied:* the deployment exists (`https://zenpdf.up.railway.app`, Railway, since 2026-08-08, TLS by the platform); `FRONTEND_BASE_URL` / `API_BASE_URL` / `ALLOWED_HOSTS` / `CSRF_TRUSTED_ORIGINS` are all set per `docs/ops/railway-deploy-report-2026-08-08.md` (note `ALLOWED_HOSTS` must include `healthcheck.railway.app`); **CSP verified in a real browser 2026-08-10** — full ads-off policy served, zero violations with content pages, workspace and the pdf.js machinery loaded, and re-confirmed 2026-08-21 on `/` and on the `.mjs`/`.wasm` locations. *Open:* a **custom domain** (this is Phase 11's P1 blocker and yours to buy); the **ceremony** half of the CSP check, which needs SMTP on.

## Mail

- [ ] Real SMTP credentials, and `DEFAULT_FROM_EMAIL` on the domain.
- [ ] **SPF, DKIM and DMARC** published. Without them every signing invitation
      lands in spam and the e-signature product does not work.
- [ ] `ABUSE_CONTACT_EMAIL` is an address somebody reads — it is printed in
      every footer, and it is where "I did not ask for this" arrives.
- [ ] Send yourself a signing invitation and confirm: it arrives in the inbox,
      the one-click unsubscribe button appears in Gmail, and clicking the
      footer link lands on the confirm page rather than unsubscribing you.

> **Status 2026-08-21.** *All open — **SMTP is off in production** by your own decision.* Nothing in this section can be satisfied until it is on, and while it is off **multi-party signing is unreachable on the hosted service** and H1 (proving the production certificate seals) cannot be exercised in production either. This is the first owner decision on the list, because several others hang off it.

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

> **Status 2026-08-21.** *Satisfied, measured on the live site 2026-08-10:* `SECRET_KEY` is **the fresh generated value**, not the dev default; the **seed admin's default credentials answer 401** (rotated or never seeded); database and storage credentials are **Railway platform secrets**, not files. *Deliberately not satisfied:* **admin is OFF in production** — `/admin/` answers **404**, which is the safe default (an empty allowlist denies) and is what you want until you need moderation. Note the consequence: the ban and trash actions in `docs/09-storage-hygiene.md` are **unreachable** until you set `ADMIN_ENABLED` and an IP allowlist.

## Signing

- [ ] Production signing certificate from a CA (or a written decision to stay
      self-signed — `/verify` says which it is, in as many words).
- [ ] `TSA_URL` set. Without a timestamp, signatures stop verifying when the
      certificate expires rather than remaining valid for the moment they were
      made.

> **Status 2026-08-21.** *Open, and this is the launch-gating one.* A production certificate exists as `SIGNING_CERT_B64` and decodes correctly on every service — but **it has never sealed a document**. That is **H1** (`docs/ops/railway-handoff-claude-cli.md`), the only one of the deploy's three handoff items still open, and it is a GATE row in PROGRESS. The certificate *decision* — buy from a CA, or stay self-signed and say so — is separately recorded in `infra/certs/prod/RAILWAY-SECRETS.md` and belongs in this box. **`TSA_URL`: unverified** — the deploy plan and the owner handoff disagree about whether it is set, and nobody has read the dashboard. Check it while you are in there.

> **Evidence 2026-08-23 — H1 is done; both boxes above are now yours to tick, from evidence.**
>
> **The certificate box.** The production certificate **seals, and the seal verifies.** Proven three ways and recorded in `development-plans/PROGRESS.md`, session log *"2026-08-23 — H1 — production seal proof"*, with the raw material in `docs/reviews/evidence/h1/`: the engine sealing a fixture in the api container; a **real two-signer envelope** (`ZEN-QUJVGF`) finalized by `worker-heavy` under the production certificate; and **production's own `/api/verify/`** accepting that file. In every case: `integrity: intact`, `coverage: ENTIRE_FILE`, **PAdES** (subfilter `/ETSI.CAdES.detached`, read back out of the file, not assumed), signer CN **`ZenPDF Document Sealing`** — where the development certificate's is `ZenPDF Dev Signing`, which is what makes this a different fact from any previous green test run. A one-byte edit inside a page object flips it to `modified`. A read-only probe inside production's own `worker-heavy` container sealed and verified a document with the file production decoded at start, so this is not an inference from matching bytes — production has now sealed.
>
> **The decision to tick or reverse**, copied verbatim from `infra/certs/prod/RAILWAY-SECRETS.md` so it is decided here rather than remembered: *"This is the deliberate 'stay self-signed' decision `docs/ops/cert-renewal.md` allows for v1. An AATL certificate is the post-launch upgrade — until then, Acrobat will show sealed documents as signed but not from a trusted issuer."* `/verify` says exactly that in as many words — "not from a trusted authority — the seal is valid, but nothing outside this file vouches for who made it" — so the honesty requirement in the box above is met either way. Tick it to keep self-signed for v1; reverse it by buying from a CA.
>
> **The `TSA_URL` box — no longer unverified.** Read from the Railway dashboard via the CLI on 2026-08-23: `TSA_URL` is **set on all five Django services** (`api`, `worker-default`, `worker-heavy`, `worker-render`, `beat`) and its value is exactly `http://timestamp.digicert.com`. `SIGNING_CERT_PASSWORD`, `SIGNING_CERT_B64` and `SIGNING_CERT_PATH` are set on all five too, and production's `SIGNING_CERT_B64` decodes **byte-identical** to `infra/certs/prod/zenpdf-prod.p12`. More than "set": the probe above reached DigiCert's TSA **from Railway's network** and embedded a real timestamp token, so B-T works in production and not merely in configuration.

## Legal and ads

- [ ] Privacy Policy and Terms reviewed by a lawyer. They are honest drafts
      written against real behaviour, and the retention numbers are pinned to
      the sweepers by a test — but nobody qualified has read them.
- [ ] E-sign disclosure reviewed. Any change must bump `VERSION` in
      `apps/esign/legal.py`, because its hash is recorded with every consent.
- [ ] Ads: `docs/09-adsense-readiness.md`, which is its own checklist. The
      product ships launchable with `ADS_ENABLED=false`.

> **Status 2026-08-21.** *All three open — they need a lawyer and an AdSense account, neither of which is an engineering task.* The two legal reviews are **GATE** rows in PROGRESS. What *is* satisfied on the ads side, with evidence: `/api/config/` on production answers `ads: {enabled: false}` and **ships no client id and no slot ids**, so a build with the flag off has nothing to load even by mistake; `/ads.txt` renders the honest "No sellers are authorised yet" state. See `docs/09-adsense-readiness.md` for the rest.

## Accessibility

- [ ] Run `docs/10-accessibility-screen-reader-script.md` — twenty minutes with
      VoiceOver or NVDA on the signing ceremony. axe and the keyboard test are
      automated and pass; this is the part that cannot be. §10.3 names this
      flow as the legally sensitive one.

> **Status 2026-08-21.** *Open — never executed.* The automated half is genuinely done and holds: `e2e/tests/phase-10-a11y.spec.ts` scans seventeen surfaces for **zero serious or critical** axe violations, and the keyboard test now completes a whole envelope with Tab/Enter/Space only. This box is the part neither can prove. **Run it against the local stack, not production** — the script uses Mailpit, and production has SMTP off.

## Operations

- [ ] `SENTRY_DSN` set (the wiring ships inert; PII is scrubbed at the SDK
      boundary either way).
- [ ] Alerts on: `/api/health/` non-200, `checks.workers` false, queue depth,
      error rate.
- [ ] Nightly `pg_dump` **and** storage sync running — the database without the
      blobs is a library of broken links.
- [ ] Restore drill performed once, and the time it took written into
      `docs/ops/restore-drill.md`.

> **Status 2026-08-21.** *All open, and all one Railway dashboard session.* `SENTRY_DSN` is unset (the wiring ships inert either way). No alerts are configured. **Backups:** production storage is SeaweedFS on a 50 GB volume — the mechanism is **volume snapshots**, not `pg_dump` + `aws s3 sync`, so read the Railway section of `docs/ops/restore-drill.md` before ticking that box; confirm the snapshot schedule is actually on. **The restore drill has never been run**, which is why its RTO line is still empty; it needs a token.

## Final

- [ ] The whole e2e suite green three consecutive runs against the prod-shaped stack. *(There is no `@full` tag — this means the suite with no grep.)*
- [ ] `@smoke` green against the deployed host.
- [ ] Lighthouse ≥90 on the deployed prod build (landing and dashboard).
- [ ] `PROGRESS.md` Human review queue has no unresolved GATE row.
- [ ] Tag `v1.0.0`.

> **Status 2026-08-21.** *`@smoke`:* run against production **2026-08-21 — 4 passed, 2 environmental**. The two are not defects: `phase-8:91` hit production's real rate limiter because the whole suite runs from one IP, and **passes standalone**; `phase-8:135` polls Mailpit on `localhost:8025`, which production has no equivalent of. Decide whether that counts as green before you tick it — it is a judgement, which is why nobody ticked it for you. *Whole suite:* **63/63 on 2026-08-21**, but on the local stack and once, not three consecutive nightly runs on a prod-shaped one. *Lighthouse:* landing scores **100 a11y / 100 best-practices / 100 SEO** — against the dev server; performance needs a trace against the deployed bundle and the dashboard needs an authenticated session. Runnable now that a host exists; it was not when this line was written. *GATE rows:* **three remain open** — the production signing certificate (H1), the Privacy/Terms legal review, and the e-sign disclosure review. `v1.0.0` is not tagged and `git tag` is empty, which is correct.
