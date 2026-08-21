# Handoff — H1: prove the production signing certificate actually seals (2026-08-21, revision 2 — unchanged by Phase 12 except this header)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF` — it needs the local Docker stack, Mailpit, and the production `.p12` at `infra/certs/prod/zenpdf-prod.p12` (gitignored; password in `infra/certs/prod/RAILWAY-SECRETS.md`).
**Branch:** `docs/h1-seal-proof`. **Depends on:** `handoff-to-cli-e2e-gate-hardening.md` merged (repo-relative cert path resolution in tests; worker restart in the gate).
**Source of truth:** `docs/ops/railway-handoff-claude-cli.md` H1 (the prompt is reused below, tightened); PROGRESS Human review queue GATE row "Production signing certificate" (2026-08-02); `docs/10-launch-checklist.md` "Signing"; `docs/reviews/status-review-2026-08-21.md` §2 Phase 8, §5.1 item 9, §7 (the seal path was verified only with the dev certificate).
**Deploys on merge?** No — docs only. **This is the only launch-gating engineering item left.**

---

```text
You are proving, with evidence, that the certificate production is configured to seal
envelopes with can actually seal one — something that has never happened because SMTP is
off in production and the seal runs only at multi-party finalize. The proof is made on
the LOCAL stack with the PRODUCTION certificate; the final verification is made against
the LIVE /api/verify/. You change no product code; you produce a record and, if the
answer is "it cannot seal", you say so plainly and stop.

Read: docs/ops/railway-handoff-claude-cli.md (H1 in full), apps/pdf_engine/engine/seal.py,
apps/esign/tasks.py (`finalize_sign_request`, `_finalize_tail`), apps/esign/tests/
test_sign_api.py::test_the_full_two_signer_loop_completes_and_seals, e2e/tests/phase-8.spec.ts
(the `@smoke @mobile` two-signer test), docs/10-launch-checklist.md "Signing",
infra/certs/prod/RAILWAY-SECRETS.md (read-only; never copy a secret into git, PROGRESS,
a PR body, a screenshot or a log you commit).

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    ls -la infra/certs/prod/zenpdf-prod.p12 infra/certs/prod/RAILWAY-SECRETS.md   # both must exist; else stop and ask
    git check-ignore infra/certs/prod/zenpdf-prod.p12                              # must print the path (ignored)
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    git switch -c docs/h1-seal-proof

PROGRESS session-log entry "H1 — production seal proof"; the GATE row → 🔵.

## 1. Step A — the engine seals with the production p12

In the api container (so pyHanko and the engine are the real ones), with the prod p12
mounted read-only (`docker compose -f infra/docker-compose.yml run --rm -v
$PWD/infra/certs/prod:/prodcerts:ro -e SIGNING_CERT_PATH=/prodcerts/zenpdf-prod.p12 -e
SIGNING_CERT_PASSWORD=… -e TSA_URL=http://timestamp.digicert.com api python manage.py
shell`), run a throwaway snippet (do not commit it) that calls
`apps.pdf_engine.engine.seal.seal(...)` on `backend/tests/fixtures/pdfs/text.pdf` and
then the module's verify function on the output. Record: seal produced (bytes), verify
→ integrity intact, whole-document coverage true, signer CN = "ZenPDF Document Sealing"
(or whatever the p12 actually carries — print it, do not assume), subfilter PAdES,
timestamp present (TSA reachable) — and repeat once with `TSA_URL` empty to record the
B-B path too. Then flip one byte inside a page object and verify again → modified. Paste
the results (no secrets) into PROGRESS.

## 2. Step B — the real thing: a two-signer envelope, sealed with the production p12

Restart the workers with the prod cert in their environment (edit a throwaway compose
override `infra/docker-compose.h1.yml` that mounts `infra/certs/prod` read-only into
api + the three workers and sets the two variables; keep it uncommitted, or commit it
with the secret NOT in it — the password must come from the shell, never a file in git).
Then run the suite's own two-signer loop:

    cd e2e && npx playwright test -g "two signers in order, sealed, certified and verifiable"

It reads invitation links out of Mailpit, completes both signers, downloads the final
and the certificate, and checks /verify locally. Keep the downloaded sealed PDF and the
certificate (`e2e/test-results/…` → copy to `docs/reviews/evidence/h1/` WITHOUT the
certificate if it contains real addresses — it contains the test addresses only; check).

## 3. Step C — production verifies its own seal

    curl -s -F "file=@docs/reviews/evidence/h1/final.pdf" https://zenpdf.up.railway.app/api/verify/ | jq

Record the full JSON (redact nothing — it contains no secrets; the envelope code is
fine). Criterion: `sealed: true`, integrity intact, whole-document coverage, the signer
CN matches Step A, and `envelope_match.known` is **false** (the envelope exists in the
local database, not production's — that is the correct answer; say so). If `known` is
true, something is wrong — stop and investigate.

## 4. Step D — the environment side (Inferred unless you have a token)

From the docs, production's `SIGNING_CERT_B64` decodes at service start and the workers
are running (which proves the decode). What this branch cannot prove without a Railway
token: that `SIGNING_CERT_PASSWORD` and `TSA_URL` are set on the worker-heavy service
(the finalize queue). If `railway` CLI is logged in on this Mac, run
`railway variables -s worker-heavy | grep -E 'SIGNING_CERT_PASSWORD|TSA_URL'` and
record **only whether each is set** (never the value). Otherwise record it as owner-
verifiable and write the exact dashboard check into docs/ops/launch-handoff-owner.md.

## 5. Record

- PROGRESS: the GATE row — ✔ if A, B and C all pass ("the production certificate seals,
  verifies whole-document, PAdES, B-T with DigiCert's TSA; production's /verify accepts
  it; environment variables on worker-heavy: verified / owner-verifiable"); otherwise
  leave it ⬜ with the failing step and the exact error, and mark the launch checklist
  "Signing" note BLOCKED. Session log with every command and result. Decisions log: the
  self-signed-for-v1 decision is already in RAILWAY-SECRETS.md — copy its sentence (not
  the secrets) into the checklist's "Signing" note so the owner can tick or reverse it.
- docs/ops/railway-handoff-claude-cli.md: H1 → done/failed with the date and the PROGRESS
  pointer.
- docs/10-launch-checklist.md "Signing": dated evidence note under both boxes (the
  certificate box and the `TSA_URL` box).
- docs/reviews/evidence/h1/: the sealed PDF, the /verify JSON, Step A's printed report.
  No `.p12`, no password, no compose override with a secret.

    git mv docs/reviews/handoffs/handoff-to-cli-h1-production-seal-proof.md docs/archived/$(date +%F)-handoff-to-cli-h1-production-seal-proof.md

prepend the "Executed <date> — result: <sealed / failed at step X>" banner; mark row 9
in docs/reviews/handoffs/README.md.

## 6. UI testing via the Chrome MCP tools

1. Local stack: open the ceremony links from Mailpit in Chrome for both signers (the
   e2e did it headless — do it once by eye at 390 px and 1280 px, both themes): the
   consent screen, the signature pad, the done screen; read the console.
2. https://zenpdf.up.railway.app/verify: drop `final.pdf` through the page (the file
   picker via the Chrome MCP upload tool): the green report renders with the CN and
   "not from a trusted authority" copy (self-signed) — screenshot both themes.
3. Open the certificate PDF in Chrome's viewer: every event present, the chain line.
Record in PROGRESS.

## 7. Ship

    git add -A && git status        # NO secrets, NO .p12, NO compose override with a password
    git commit -m "docs(h1): the production certificate seals — evidence, /verify on production, checklist notes"
    git push -u origin docs/h1-seal-proof
    gh pr create --base main --head docs/h1-seal-proof --title "docs(h1): production signing certificate — seal proof and launch-checklist evidence" --body "<Steps A–D with results / What remains owner-verifiable / Evidence paths>"

Self-review with one lens: *secrets* — `git diff origin/main...HEAD | grep -iE 'passw|secret|BEGIN|base64'` returns nothing sensitive; the evidence folder has no key material;
the PR body has no values. Then `gh pr merge --merge --delete-branch && git switch main &&
git pull --ff-only origin main`. Remove the throwaway compose override and restart the
workers with the dev cert (`./infra/restart-all.sh`) so the local stack is back to
normal. Report: pass/fail per step, in those words, and what the owner must still do
(SMTP decision, `TSA_URL` confirmation if unverifiable, the certificate decision tick).
```
