⚠ Superseded by `prompt-3-phases-03-10.md` (2026-08-01) — do not run.

# One-Shot Prompt 2 — Execute Phases 3–7 (Annotations → Content Editing → Forms → OCR/Conversion/Compare → Security & Redaction)

**Usage:** start an agent session (e.g. Claude Code) with its working directory at the **ZenPDF repo root**, Docker daemon running, and paste everything below the line as the prompt. **Precondition: Phases 0–2B are ✅ in `PROGRESS.md`.**

> **✅ Unblocked 2026-08-01 — Phase 2B has landed.** Ownership now flows through `apps/core/principals.py` (01-architecture **§21**, normative) and a grep test fails the build on `request.user` / `job.user` / `owner=` / `context["request"].user` outside that module. **Add §21 to the Step 1 reading list**, and when writing phases 3–7: scope querysets with `owned_by(qs, principal)`, create rows with `owner_kwargs(...)`, resolve worker ownership with `principal_of(job)`, put new limits in `settings.TIERS` behind `core.limits.for_principal()`, and leave `IsPrincipal` as the default permission unless a feature is genuinely account-only (§21.3, with a written reason). Each phase also ships its public tool page by appending to `frontend/src/app/core/tool-pages.ts` — routes, prerendering and `sitemap.xml` are generated from that table.

---

You are an expert full-stack engineer executing a pre-approved, pre-reviewed development plan **autonomously, start to finish, without asking for permission at each step**. Your mission: fully implement **Phases 3, 4, 5, 6, and 7** of ZenPDF.

## Step 1 — Read the plan (in this exact order, fully)

1. `development-plans/PROGRESS.md` — canonical tracker. **Hard precondition:** Phases 0–2 are ✅. If they are not, or if `./infra/up.sh` / `./infra/test.sh` fail on the current tree, STOP and record a Blocker — do not start Phase 3 on a red base, and do not re-implement Phases 0–2.
2. `development-plans/README.md` and `development-plans/01-architecture.md` (**normative** — §6 API conventions, §8 coordinates, §9 data model, §10 operation registry, §11–12 job pipeline/queues, §13 storage, §16 tiers/quotas, §17 security, §18 testing, §20 Definition of Done, **§21 access model — anonymous-first; every tool you build must work for a guest principal, and each phase ships its public SSR tool page**).
3. Work orders, in execution order: `development-plans/phase-03-annotations.md` → `development-plans/phase-04-content-editing.md` → `development-plans/phase-05-forms.md` → `development-plans/phase-06-ocr-conversion-compare.md` → `development-plans/phase-07-security-redaction.md`.
4. `development-plans/02-feature-matrix.md` for scope boundaries only (BL/OUT items stay out).

## Step 2 — Baseline verification

Run `./infra/up.sh` then `./infra/test.sh --e2e` and record the green baseline in PROGRESS.md before touching code. Read the Phase 0 "Verified pins" table and the Decisions log — honor prior decisions (e.g. Django/Python fallbacks, viewer src mode) instead of re-litigating them.

## Step 3 — Execute (rules of engagement)

- **Order:** 3 → 4 → 5 → 6 → 7, strictly. Phases 4, 5, and 7 reuse Phase 3's overlay layer — build `PageOverlayComponent` to the phase-03 spec once, generically, and extend rather than fork it.
- **Authority & conventions:** `01-architecture.md` wins on any conflict (fix the text in the same commit, log the decision). All new operations must match the §10 registry signatures exactly (`annotate_batch`, `flatten`, `edit_text`, `find_replace` incl. `dry_run`/`only[]`, `edit_form_fields_batch`, `fill_form` with `flatten_after`, `ocr` with `rotate_pages`, `convert_from`/`convert_to`, `compare`, `repair`, `encrypt`/`decrypt`/`set_permissions`, `redact` incl. `dry_run`/`fork_clean_copy`, `sanitize`). All geometry through `pdf_engine/geometry.py` (§8) — never inline coordinate math.
- **Speced implementation directives to honor** (already validated against library docs — do not substitute without a logged blocker): flatten via PyMuPDF `Document.bake()`; text edit via redact-annot + `insert_htmlbox` + `subset_fonts` with the `text_overflow` error contract; signature form fields via pyHanko `fields.append_signature_field(SigFieldSpec(...))` (PyMuPDF cannot create them); form fill via ngx-extended-pdf-viewer `[(formData)]`; SSRF guard layered API pre-check + Gotenberg `--chromium-deny-list`; redaction post-verification re-extract step.
- **Fixture corpus additions** (commit generation scripts): RTL/Hebrew text fixture (P3/P4/P6), XFA sample (P5), PII fixture with SSN/email/phone/credit-card/IBAN strings (P7 — one per redaction preset), booby-trapped fixture with JS + attachment + metadata (P7), a crafted compare pair (P6). Extend golden tests accordingly.
- **Pre-approved dual-path decisions** (pick by golden test, record in Decisions log): custom stamp appearance stream vs. "flattened stamp" fallback (P3); per-field-type fill path viewer-native vs. overlay inputs (P5).
- **Verification gates per phase:** all acceptance criteria ticked in PROGRESS.md with evidence + §20 DoD + `./infra/test.sh --e2e` green including that phase's new Playwright spec. Coverage gates (§18: apps 85%, pdf_engine 90%) hold.
- **Human review queue (do NOT stop for these):** after Phase 3 add "overlay interaction feel (drag/resize/ink smoothing)"; after Phase 4 add "text-edit visual fidelity on real-world docs beyond fixtures". Mark neither as GATE. Anything legally or destructively sensitive that you're unsure of → add as GATE and continue with other phases if independent.
- **Blockers, commits, scope, hygiene:** identical rules to Prompt 1 — ~3 failed approaches ⇒ 🟡 Blocker + halt that phase; small conventional commits; no BL/OUT scope; PROGRESS.md Update protocol followed literally; never weaken tests or acceptance criteria to pass a gate.

## Step 4 — Done definition for THIS session

Phases 3–7 all ✅ in PROGRESS.md with evidence; full regression (`./infra/reset.sh --yes && ./infra/up.sh && ./infra/test.sh --e2e`) green; through the UI a user can: annotate + flatten, edit/add text with the scanned-page OCR gate working end-to-end, fill and build forms, OCR a scan, convert in/out (incl. PDF/A), compare two documents, password-protect/unlock, redact by pattern with clean-copy fork, and sanitize. All work committed. Finish with a PROGRESS.md handoff note: Phase 8 is next (`development-plans/phase-08-esignatures.md`) and carries a **mandatory human gate** (ESIGN disclosure/legal text + production signing certificate) — list it in the Human review queue as GATE now so the owner sees it early.
