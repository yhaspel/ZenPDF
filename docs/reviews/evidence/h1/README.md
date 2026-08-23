# H1 — evidence that the production signing certificate seals

Produced 2026-08-23 on branch `docs/h1-seal-proof` (prompt 9 of the handoff
programme, `docs/reviews/handoffs/TRACKING.md`). The narrative is in
`development-plans/PROGRESS.md`, session log **"2026-08-23 — H1 — production
seal proof"**; this folder is the raw material behind it.

**No key material is here.** No `.p12`, no password, no `SIGNING_CERT_B64`. The
certificate's *public* identity (subject, serial, validity, key size) is
recorded because it is what a verifier sees anyway, printed on every seal.

| File | What it proves |
|---|---|
| `step-a-console.txt` | Step A, verbatim. The production `.p12` loads in the api container, seals `tests/fixtures/pdfs/text.pdf` twice — **B-T** with DigiCert's TSA and **B-B** without — and both verify `intact` / `ENTIRE_FILE`. Ends with the tamper check: one byte flipped inside a page object → `modified`. |
| `step-a-report.json` | The same run as structured data, including the certificate's subject/issuer/serial/validity read off the p12 rather than assumed. |
| `final.pdf` | Step B. The sealed output of a **real two-signer ceremony** driven by `e2e/tests/phase-8.spec.ts`'s `@smoke @mobile` two-signer test, with api and all three workers running the production certificate. Envelope `ZEN-QUJVGF`. |
| `certificate.pdf` | The certificate of completion for the same envelope. Its event log carries `Seal Applied … level=B-T, sealed=True, timestamped=True` and the chain line. |
| `production-verify.json` | Step C. The response from **production's own** `POST https://zenpdf.up.railway.app/api/verify/` for `final.pdf`. `sealed: true`, `integrity: intact`, whole-document, signer CN `ZenPDF Document Sealing`, and `envelope_match.known: false` — correct, because the envelope is in the *local* database, not production's. |
| `production-worker-seal-probe.txt` | Step D, gone one better. A read-only probe run **inside production's `worker-heavy` container** over `railway ssh`: it loads the certificate production decoded at start (`/tmp/certs/zenpdf.p12`), seals an in-memory PDF and verifies it — B-T, PAdES, `ENTIRE_FILE`. Production seals, in production, with its own file. Nothing was written to the database or to storage. |
| `verify-page-light.png`, `verify-page-dark.png` | The `/verify` page rendering `final.pdf`'s report in both themes: the green headline, the signer CN, "not from a trusted authority", and the envelope match with recipient addresses masked. |
| `rotated-page-defect.png` | **Not part of the H1 verdict** — a defect found while doing the by-eye pass. Page 1 of a completed envelope whose source page carries `/Rotate 90`: both burnt-in signatures are 180° from upright and the envelope footer is laid out as an unreadable vertical ribbon. See the Human review queue row dated 2026-08-23. |

## The one number that ties the local proof to production

`SIGNING_CERT_B64` on Railway decodes to bytes **identical** to the local
`infra/certs/prod/zenpdf-prod.p12` — sha256 `45a196df78be5d58ade6e6f30396d272
2068d010270726623566ef865bd9ad34`, 3427 bytes, confirmed on both sides and in
production's own container. So Step A and Step B are not analogies: they
exercise the same bytes production seals with, under the same password and the
same `TSA_URL`.
