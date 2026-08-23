# Launch handoff — production verification of 2026-08-10, and what is left for the owner

A Cowork session ran the phase-10 verification it could do autonomously against
the **live production deployment**. This file records what is now proven with
evidence, the one defect it surfaced, and the remaining work only you can do —
ordered, with the exact command or prompt for each. Companion docs:
`docs/ops/railway-handoff-claude-cli.md` (H1–H3 prompts),
`docs/10-launch-checklist.md` (the GATE), `development-plans/PROGRESS.md`
(session log of this pass).

## Update 2026-08-21 — read this before the rest of the file

Twelve days of work happened after this handoff was written. Three things in it are no longer true, and the owner list has shrunk.

- **The viewer defect is fixed and verified live.** The one defect this pass surfaced — the production workspace viewer never fetching `/content/`, so the page stayed blank — was root-caused on 2026-08-20 to **two** production-only blockers: the viewer library feature-detects the browser with an inline `<script>` that `script-src 'self'` refuses (`[useInlineScripts]="false"` now takes its external equivalent), and nginx served pdf.js's `.mjs` modules as `application/octet-stream`, which `nosniff` makes fatal for a module script (both configs pin the type). Shipped in PR #17 and **confirmed on the live site 2026-08-21**: both modules served `text/javascript`, `/content/` answered 200, and the canvas was measured non-uniform from a cold profile — the page drew.
- **H2 and H3 are done** (2026-08-21). `@smoke` against production: 4 passed, 2 environmental (a shared-IP throttle and a Mailpit-only test — neither a deploy defect). `./infra/test.sh --e2e` on the Mac: 59/60 twice, then 63/63 after Phase 12. **H1 is the only one of the three still open**, and it still gates launch.
- **"e2e never run" is out of date** — it has been run repeatedly since.

**What actually remains for you** is the owner list from `docs/reviews/status-review-2026-08-21.md` §5.2, reproduced here so you do not have to open it:

- **SMTP on or off for launch.** Multi-party signing is unreachable until it is on, and H1 cannot be exercised *in production* without it (locally it can).
- **A custom root domain** (Phase 11 P1) → Cloudflare session, Railway custom domains + TXT, Search Console. Phase 11 is gated on this.
- **Three legal reviews** — Privacy, Terms, and the e-sign disclosure — including the AdSense cookie-disclosure check. These are GATE rows.
- **A Railway dashboard session:** the storage-volume backup schedule, `SENTRY_DSN`, the worker recycle drill, and **the restore drill** (needs a token — it has never been run). *(`TSA_URL` is off this list as of 2026-08-23: it is **set on all five Django services** and its value is exactly `http://timestamp.digicert.com` — read from the dashboard, and independently confirmed by a production seal that carries a real DigiCert timestamp token. Nothing to do there.)*
- **The certificate decision**, recorded in the checklist: stay self-signed for v1, or buy one. *(2026-08-23: the certificate itself is proven — it seals, and production verifies the seal. Only the decision is left, and `docs/10-launch-checklist.md` "Signing" now carries the sentence to tick or reverse.)*
- **Five minutes with a viewer** (Acrobat/Preview) for annotations, filled forms, permissions and a sealed envelope; **ten minutes signing from a real phone**; the **twenty-minute screen-reader script** (`docs/10-accessibility-screen-reader-script.md`).
- **Skim the twelve guides** before any AdSense submission, and decide the ad-revenue sanity check.
- **Tag `v1.0.0`** only when `docs/10-launch-checklist.md` has no unticked box.

## Verified today, with evidence

- **Chrome smoke pass on production (your real browser).** Landing renders
  (compact masthead, dark theme, zero console errors); `/sign-pdf` shows a
  dropzone and **no login form anywhere**; a full guest merge ran end-to-end
  through the UI — two files uploaded, MERGED stamp, download offered, 24 h
  retention notice; `/legal/privacy` and `/verify` render with footer links.
  Recording: `zenpdf-prod-smoke-2026-08-10.gif` in your Downloads.
- **CSP verified in a real browser** (checklist "Domain and transport", last
  box, minus the ceremony): the full ads-off policy is served by
  `infra/railway/nginx.railway.conf` on every location, and content pages,
  the workspace shell and the pdf.js machinery loaded with **zero CSP
  violations** in the console. The ceremony could not be loaded (no signing
  link can exist while SMTP is off) — same policy applies; re-check it when
  SMTP lands.
- **Guest job pipeline via the API, on production:** `fill_form`, `flatten`,
  `encrypt` and `annotate_batch` all ran to `succeeded`; `/api/health/` green
  before and after (db/redis/storage/gotenberg/workers all true).
- **Byte-level proof of the outputs** (pikepdf/pypdf): filled values present
  in the AcroForm (`full_name`, checkbox `/Yes`, `notes`); flatten removes
  the fields and bakes the text; encryption is **AES-256 (R6)** with
  print_lowres/highres/modify/extract all denied and **accessibility
  preserved** (the flag the product refuses to restrict); the annotation file
  carries `/Highlight`, `/Text` + `/Popup`, `/Square` in `/Annots`.
- **Security posture, live:** `/admin/` answers **404** (locked door as
  designed); the seed-admin **default credentials are rejected** (401 on
  `admin@zenpdf.local` / `admin12345`); `SECRET_KEY` in production is the
  freshly generated value from `RAILWAY-SECRETS.md`, not a dev default;
  `/ads.txt` renders the honest no-sellers state; `robots.txt` correct.
- **Guest isolation, live:** operations attempted against another
  principal's document answered **404, never 403** — the isolation sweep's
  contract, observed on production by accident (a mis-sent header) and
  worth having seen.
- **Compact landing is deployed.** `2062fb8` committed and pushed; auto-
  deploy from `main` is live, and the masthead is what production serves.

Evidence files for your five-minute viewer checks are on your Mac at
**`_to_delete/qa-evidence-2026-08-10/`** (also delivered in the chat).

## 🔴 New finding — the workspace viewer never loads the document (production)

**Repro:** open any `/app/doc/<id>` as a guest in desktop Chrome.
Metadata, versions, outline and all page thumbnails load (HTTP 200 each), but
**no request for `…/content/` is ever made**, the pdf.js canvas stays blank,
and the console stays completely silent. Reproduced across an SPA navigation
*and* a hard reload. The tool-page funnel (upload → result → download) is
unaffected, so phase-2B's primary flow still works — but "Open in workspace"
hands a guest an empty page, and every workspace mode that needs a rendered
page (organize, annotate, edit) is unusable in production.

**Why nothing caught it:** the deploy report's by-hand check covered the
landing and `/sign-pdf` only; the e2e suite has **never** run against the
deployed build (H2/H3, still open); and the Human review queue already
warned (row of 2026-08-02) that the suite asserts the viewer *element*, not
that a page *drew* — this is that gap, live.

**Next step:** run **H3** (`infra/test.sh --e2e` locally) and **H2**
(`@smoke` against production) from
`docs/ops/railway-handoff-claude-cli.md` — if the local run is green, the
defect is production-specific (build/proxy/headers); if it is red locally,
it came in with a recent commit. Either way, add the "a page actually drew"
assertion the queue asked for, so it cannot return.

## What is left for you — in order

1. **Chase the viewer finding.** H3 then H2, prompts ready in
   `docs/ops/railway-handoff-claude-cli.md`. This is the only *new* item
   today and it belongs first: it is a real production defect on a core
   surface.
2. ~~**H1 — prove the production signing certificate seals**~~ — **done
   2026-08-23.** It seals: whole-document, PAdES, B-T with DigiCert's TSA,
   and production's own `/verify` accepts the result. See
   `development-plans/PROGRESS.md` session log *"2026-08-23 — H1 —
   production seal proof"* and `docs/reviews/evidence/h1/`. **Launch is no
   longer gated on the certificate** — only on SMTP, the two legal reviews
   and your own ticks.
3. **Two decisions, both one-liners to record:**
   - **SMTP on or off for launch.** Multi-party signing is unusable until
     on. Recipe: `RAILWAY-SECRETS.md` (Gmail app password; ~10 min). SPF/
     DKIM alignment comes later with the custom domain (phase 11 P1's
     Cloudflare session covers the DNS records).
   - **Certificate: stay self-signed for v1.** `RAILWAY-SECRETS.md` already
     records this as the deliberate choice — copy that sentence into
     `docs/10-launch-checklist.md` "Signing" and tick it, or reverse it.
4. **Five minutes in Preview/Acrobat** with
   `_to_delete/qa-evidence-2026-08-10/`:
   - `annotated-unflattened.pdf` — highlight visible on the "highlighted"
     line, sticky note opens with its text, rectangle frames its sentence.
   - `form-filled.pdf` — name/notes in the fields, checkbox ticked, right
     place and size. `form-flattened.pdf` — same values, no live fields.
   - `protected-no-print.pdf` — opens without a password; **Print greyed
     out / refused** (Preview is lax about permissions — Acrobat is the
     honest judge here).
   - The sealed-envelope check (P8) waits for H1 + SMTP.
5. **Railway dashboard session (~10 min)** — my session had no API token
   (the deploy token's value was never written to disk, which is correct):
   - ~~Set `TSA_URL=http://timestamp.digicert.com` on api + all three
     workers + beat~~ — **already set on all five, confirmed 2026-08-23**,
     and a production seal carries a real DigiCert timestamp token, so it
     works rather than merely being present.
   - Confirm the **storage volume** has a daily backup schedule (Postgres
     has one; the handoff flagged storage as unconfirmed).
   - `SENTRY_DSN` when you want error reporting (wiring ships inert).
   - Apply env-only changes with `serviceInstanceDeployV2`, not `redeploy`.
6. **Worker recycle drill** (`docs/ops/queue-stuck.md`, the last open half
   of the hostile-corpus criterion): start a long OCR as a guest, restart
   `worker-heavy` mid-run from the dashboard, and confirm the job lands
   `failed` with a readable message (the beat reaper sweeps every 5 min)
   and the next job succeeds. **Or:** drop a Railway API token into the
   chat and I will run and evidence it end-to-end.
7. **Lighthouse on the deployed build** (last open `[~]` criterion):
   `npx lighthouse https://zenpdf.up.railway.app/ --preset=desktop` for the
   landing (PSI's anonymous quota was exhausted from my egress IP today; a
   free PSI API key also unblocks me to do it). The dashboard run needs a
   logged-in browser — I don't authenticate into accounts, so that run is
   yours or waits for a session with you at the keyboard.
8. **The suite runs only your Mac can do:** `infra/test.sh --e2e` green,
   then three consecutive nightly `@full` runs (`docs/ops/release.md`), and
   one `infra/perf/` locust run pointed at production with `PERF_EMAIL` set
   (the p95 number the criterion still owes).
9. **Restore drill, once** (`docs/ops/restore-drill.md`) — including the
   audit-chain re-verification it insists on. I can walk it with you
   against a scratch Railway environment when you have the token handy.
10. **The twenty-minute screen-reader script**
    (`docs/10-accessibility-screen-reader-script.md`) and **ten minutes
    signing from a real phone** — the two judgements automation cannot
    make.
11. **Legal reviews ×3 (GATE):** Privacy + Terms, and the e-sign
    disclosure (any change bumps `VERSION`). Add the phase-11 P4 check
    while there: the privacy policy's advertising-cookie wording against
    AdSense's required-content list (support.google.com/adsense/answer/1348695).
12. **Then:** tick `docs/10-launch-checklist.md` through, clear the GATE
    rows in PROGRESS's Human review queue, and tag `v1.0.0`.

Independent of launch: phase 11 (`development-plans/phase-11-adsense-review.md`)
starts the moment you buy the domain — its P1 Cloudflare session folds in the
SPF/DKIM records from item 3.
