# Phase 8 — E-Signatures

**Goal:** DocuSign-class core loop, self-hosted: saved signatures, self-signing, multi-party signature requests with roles/routing, a public no-account signing ceremony, ESIGN/UETA-sound consent + hash-chained audit trail, PAdES tamper seal, certificate of completion, and a public verification tool. (Templates, bulk send, reassign, SMS/KBA identity, QES: explicit backlog — see 02-feature-matrix.)

Depends on: Phases 2B (principals), 3 (overlay), 5 (field UX patterns). Models per 01-architecture §9; emails/beat §15; compliance model per 00-research §2.

> **Access split (01-architecture §21.3, normative).** **8A self-sign is guest-accessible** — a visitor can draw or type a signature, place it and flatten it with no account; only *saving* a signature for reuse requires one (`SavedSignature` is user-only, so guests keep an ephemeral signature client-side for the session). **8B signature requests are account-only** and return 403 `account_required` to a guest: ESIGN/UETA attribution needs an identified sender, and a guest-triggerable outbound email path would be a spam relay against our own domain reputation. **8C `/verify` and the `/s/:token` ceremony stay fully public** — and, being trust surfaces, stay ad-free. `/sign-pdf` is a public SSR tool page (§21.6) whose no-account path is self-sign.

## 8A — Saved signatures & self-sign

- `POST/GET/DELETE /api/signatures/` — kinds signature|initials; methods: **draw** (signature_pad canvas → PNG w/ alpha, trimmed), **type** (text + 4 cursive Google-hosted-locally fonts rendered server-side to PNG via PyMuPDF text draw — fonts vendored in repo), **upload** (PNG/JPG → background removal: luminance threshold to alpha; simple v1), `is_default`.
- `self_sign` op: `{placements: [{signature_id, page, rect §8}], include_date?: bool}` — engine stamps PNG(s) via `insert_image` (+optional date text below), then **flattens** into content → version "Signed (self)". UI: "Sign myself" tool → pick/create signature → click-to-place (resizable) → Apply.

## 8B — Signature requests

### Request builder (owner side)
Wizard at `/app/sign/new/:docId`: 1) recipients (email, name, role signer|approver|viewer|cc, order — drag list; same order = parallel; validation: ≥1 signer, cc receives result only); 2) fields: overlay placement per signer/approver (palette: signature, initials, date-signed, text, checkbox; each bound to a recipient with color coding; required toggle; date-signed is auto-filled at signing, not editable); approvers need zero fields (approve/decline buttons); 3) message + expiry (default 30 d) + reminder cadence (default 3 d); 4) review & send.
API: `POST /api/sign-requests/` (draft) → `PATCH` (recipients/fields while draft) → `POST /api/sign-requests/{id}/send/`. Send pipeline (default queue): snapshot `source_version` (frozen — later edits to the doc don't affect the request), generate `envelope_code` (page stamping deferred to finalize), store field map, create tokens, email group(s) with `order=min`, AuditEvent(created, sent). Status transitions: draft→sent→(completed|declined|expired|canceled). `POST …/cancel/`, `POST …/remind/` (manual nudge, rate-limited 1/day), `GET /api/sign-requests/?role=sent` list with per-recipient status chips, `GET …/{id}/` detail + `GET …/{id}/audit/` (owner view), `GET …/{id}/certificate/` + `…/final/` downloads when completed.

### Public signing ceremony (`/s/:token` — no auth)
API under `/api/public/sign/{token}/` (AllowAny, tight throttle, token = recipient capability):
- `GET /` → request meta (title, owner display, message, my role, my fields, doc page count, status guard: not-yet-my-turn → friendly wait page; completed/declined/expired/canceled → status page).
- `GET /content/` → the frozen source_version stream (Range).
- `POST /consent/` `{agree: true}` → records ESIGN consent (checkbox text = the vendored **/legal/esign-disclosure**; stores at/ip/ua; AuditEvent consented). Everything else 403s until consented. First `GET /` also logs AuditEvent(opened).
- `POST /fields/` `{field_id, value}` incremental saves (text/checkbox; signature/initials accept `{signature_image: dataURL}` from ceremony's own draw/type/upload widget — external signers have no saved library; date_signed ignored here).
- `POST /complete/` — validates all my required fields filled; role approver → records approval instead of fields. AuditEvent(signed|approved) with ip/ua. Recipient completed → routing engine: notify next order group, or if all signer/approver roles completed → enqueue `finalize_sign_request` (heavy).
- `POST /decline/` `{reason}` → request status declined; owner + already-signed recipients emailed; audit.
Ceremony UI: mobile-first single-column: doc viewer (read-only) with "next required field" guidance rail, field widgets overlaid at §8 coords, signature dialog (draw/type/upload tabs, signature_pad), progress "2 of 3 fields", consent gate screen first, decline link, download-copy link on the completion screen.

### Finalize pipeline (`finalize_sign_request`, worker, idempotent)
1. Load frozen source; burn ALL field values: signature/initial PNGs via insert_image, date_signed (completion timestamps, TZ=UTC label), text/checkbox rendering; flatten.
2. Stamp each page footer: "Envelope {envelope_code} · verify at {FRONTEND_BASE_URL}/verify".
3. **PAdES seal via pyHanko**: platform cert from `SIGNING_CERT_PATH` (.p12); level: B-B if no `TSA_URL`, else B-T (RFC 3161); B-LT when cert chain + revocation available (config-detected — with real CA cert). Invisible signature field named `ZenPDF-Seal`; reason "Completed via ZenPDF envelope {code}"; location FRONTEND_BASE_URL.
4. Compute `final_sha256` = sha256 of the **sealed** output — the hash of the exact file everyone downloads (printed on the certificate; `/api/verify/` compares uploads against it). Integrity of content is additionally proven by the seal itself.
5. **Certificate of completion** (reportlab): envelope code, doc title + `final_sha256` (post-seal), owner, per-recipient table (name, email, role, ip, ua, consent time, completed time), full event log from audit chain, chain-head hash. 
6. Store `sign/{id}/final.pdf` + `certificate.pdf`; also append final as new version "Signed" on the source document (owner convenience); status completed; AuditEvent(seal_applied, completed); email everyone (signers+cc): completion + links (recipients: tokenized `GET /download/final|certificate` on the public API — enabled post-completion, satisfies ESIGN retention).

### Reminders & expiry (beat, §15)
`sign_reminders`: recipients in status notified/viewed/consented, last_notified_at older than cadence, request not expired → resend email, AuditEvent(reminder_sent). `sign_expirations`: past expires_at & not completed → status expired, notify owner + pending recipients.

## 8C — Verification (`/verify`, public)
`POST /api/verify/` (multipart pdf, anon-throttled): pyHanko validation → `{sealed: bool, signer: cert CN, integrity: intact|modified, signing_time, timestamp: present|absent, coverage: whole-document?, envelope_match: {found_code?, known: bool, sha256_match: bool}}` (looks up envelope_code stamp against our DB when present). UI: drop zone → green/red report. Honest copy for self-signed dev certs ("seal valid but certificate is not from a trusted CA").

## Tests
Unit/golden: routing engine truth table (sequential, parallel, mixed, approver-declines mid-chain, viewer role auto-completes on view? — **decision: viewer must open the doc; opening = completion for viewer role**); token security (32 random bytes urlsafe; invalid/expired/reused-after-complete all 401/410); consent gate blocks field posts; finalize idempotency (double-dispatch → one seal); audit chain verifies (recompute hashes; tamper test breaks); pyHanko validation round-trip on our own output (B-B and B-T with a mock/public TSA in CI-optional test); certificate PDF contains all events; frozen-version isolation (edit doc after send → ceremony content unchanged); cross-request field isolation; decline path emails + blocks others.
E2E (full loop, Mailpit-driven): create request (2 signers sequential + 1 cc) → signer1 link from Mailpit → consent → sign (draw) → signer2 not yet notified before signer1 completes (assert) → signer2 types signature → completion emails ×3 → download final + certificate → verify page shows green → version "Signed" on source doc.

## Acceptance criteria
- [ ] Self-sign in <4 clicks from an open document.
- [ ] Full 2-signer sequential flow works on a phone-sized viewport without login.
- [ ] Completed PDF opens in Acrobat/any validator showing an intact signature; ANY byte modification flips verification to invalid (test proves).
- [ ] Audit trail + certificate reproduce every event with IP/UA/UTC and chain integrity.
- [ ] Consent is unskippable and its exact disclosure text is versioned in the repo (legal page + hash recorded in audit metadata).
- [ ] Reminders/expiry fire per beat schedule (time-warped tests).
- [ ] Monthly sign-request quota enforced (§16).

## Risks
- pyHanko is 0.x/beta → pin exact version; validation round-trip tests on every upgrade; its API is the de-facto standard regardless.
- Deliverability of email in production (SPF/DKIM) → phase 10 prod checklist item; dev uses Mailpit.
- Legal nuance: we implement SES + platform seal (Documenso/DocuSeal parity) and say exactly that in product copy — no QES/AES claims.
