# ZenPDF — Development Plan

**Created:** 2026-07-19 · **Stack verified as of:** 2026-07-19 · **Amended:** 2026-07-31 (anonymous-first access), 2026-08-22 (status line + index reconciled)

**Status:** Phases 0–9 and 12 complete, Phase 10 awaiting owner sign-off, Phase 11 part-landed and awaiting the owner's domain; production live on Railway since 2026-08-08 (auto-deploy from `main`). See [PROGRESS.md](PROGRESS.md).

ZenPDF is a free-to-use, ad-supported web application for editing, organizing, converting, securing, and signing PDF documents — **usable with no account at all** — a web-based product covering the table-stakes feature set of Adobe Acrobat / Foxit / Smallpdf-class tools, plus a DocuSign-class e-signature workflow, built entirely on open-source components.

## Locked product decisions (confirmed with owner, 2026-07-19)

| Decision | Choice |
|---|---|
| Access model | **Anonymous-first (amended 2026-07-31 — supersedes the original login-gated model).** Every stateless tool works with no account. Accounts are an upgrade: persistent library, folders, higher limits, saved signatures, sending signature requests. Canonical spec: [01-architecture.md](01-architecture.md) §21. Teams/sharing = backlog. |
| E-signing | Full: self-sign + multi-party signature requests + cryptographic PAdES tamper seal (pyHanko). |
| Licensing | AGPL acceptable → PyMuPDF + Ghostscript unlocked as core engine. |
| OCR | In scope (OCRmyPDF/Tesseract). |
| Conversions | In scope (Gotenberg/LibreOffice, pdf2docx, PyMuPDF). |
| Monetization | **Free to use, ad-revenue model.** No billing/subscriptions in v1. No AI assistant. (Scope change 2026-07-19, superseding earlier Stripe/AI scope.) A `pro` tier is **defined in config but not purchasable** — no payment provider, no checkout, no upgrade UI — solely so limits already resolve per-tier if billing is ever added (§21.7). Reaffirmed 2026-07-31. |
| Stack | Latest Angular (v22) + latest Django (6.0) per `django-angular-project-setup` skill conventions. Full local Docker stack, single `infra/up.sh`. |

## Document index

| File | Contents |
|---|---|
| [PROGRESS.md](PROGRESS.md) | **Canonical execution tracker** — status, decisions, blockers, human review queue |
| [prompt-1-phases-00-02.md](prompt-1-phases-00-02.md) | One-shot agent prompt, Phases 0–2 — **executed 2026-07-19. Historical; do not run.** |
| [prompt-2b-phase-02b.md](prompt-2b-phase-02b.md) | One-shot agent prompt, Phase 2B — **executed 2026-08-01. Historical; do not run.** |
| [prompt-2-phases-03-07.md](prompt-2-phases-03-07.md) | One-shot agent prompt, Phases 3–7 — **superseded by prompt-3; never run as written. Historical.** |
| [prompt-3-phases-03-10.md](prompt-3-phases-03-10.md) | One-shot agent prompt, Phases 3–10 — **executed 2026-08-01/02. Historical; do not run.** |
| [00-research-findings.md](00-research-findings.md) | Competitor + e-sign research digest, feature taxonomy, verified stack facts, sources |
| [01-architecture.md](01-architecture.md) | **The canonical reference**: stack versions, repo layout, data model, API + operation conventions, coordinate system, storage, jobs, security model, env matrix |
| [02-feature-matrix.md](02-feature-matrix.md) | Every researched feature → phase mapping (proof of completeness) |
| [phase-00-foundation.md](phase-00-foundation.md) | Monorepo scaffold, auth, Docker stack, infra scripts, job framework |
| [phase-01-documents-and-viewer.md](phase-01-documents-and-viewer.md) | Upload, library, folders, versions, PDF.js viewer, thumbnails, search |
| [phase-02-page-organization.md](phase-02-page-organization.md) | Merge, split, reorder, rotate, extract, insert, crop, N-up, compress |
| [phase-02b-anonymous-access.md](phase-02b-anonymous-access.md) | **Guest sessions, principal model, tiered limits, public SSR tool pages, claim-on-signup** |
| [phase-03-annotations.md](phase-03-annotations.md) | Highlights, notes, shapes, ink, stamps, comments sidebar, flatten |
| [phase-04-content-editing.md](phase-04-content-editing.md) | Edit/add text, images, links, whiteout, find & replace, watermark, headers/footers, Bates, metadata |
| [phase-05-forms.md](phase-05-forms.md) | Fill AcroForms, create fields, import/export data, flatten |
| [phase-06-ocr-conversion-compare.md](phase-06-ocr-conversion-compare.md) | OCR, to/from-PDF conversions, PDF/A, repair, document compare |
| [phase-07-security-redaction.md](phase-07-security-redaction.md) | Encrypt/decrypt, permissions, true redaction, sanitize |
| [phase-08-esignatures.md](phase-08-esignatures.md) | Saved signatures, self-sign, sign requests, public signing ceremony, audit trail, PAdES seal, verification |
| [phase-09-ads-and-abuse-controls.md](phase-09-ads-and-abuse-controls.md) | Ad slots + consent (CMP), landing page, quotas, throttling, anti-abuse |
| [phase-10-hardening-release.md](phase-10-hardening-release.md) | Security hardening, performance, a11y, E2E suite, prod deploy |
| [phase-11-adsense-review.md](phase-11-adsense-review.md) | AdSense approval pass: custom-domain cutover, contact page, guides editorial layer, application loop. **The half that needs no domain landed 2026-08-24** — `/contact`, the About identity paragraph, twelve guides + `/guides`, the content floors and the tool-page top-up; 11A/11D/11E wait on the owner's domain purchase |
| [phase-12-usability-add-ons.md](phase-12-usability-add-ons.md) | Right-click menus, keyboard shortcuts, visible Undo/Redo on all six editing surfaces, six defect fixes — **executed 2026-08-21** |

## How to use this plan

1. Implement phases **in order**. Each phase is self-contained: models, endpoints, UI, tests, acceptance criteria. A phase is done only when its **Acceptance criteria** all pass and its tests are green — no TODOs left behind.
2. `01-architecture.md` is normative. Phase docs reference it instead of restating conventions (coordinates, job pipeline, error shapes, storage keys). If a phase doc and the architecture doc conflict, the architecture doc wins — and the conflict should be fixed in the same commit.
3. Version pins in the architecture doc were verified against official sources on 2026-07-19. Phase 0 contains a short "re-verify on scaffold day" checklist for anything that may have moved (marked ⚠ in the stack table).
4. Recommended order is strictly linear (0→2→2B→3→10). If parallelizing with multiple developers: **2B should land before anything else starts** (it changes ownership everywhere); then 4, 5, and 7 each require 3 (they reuse its overlay layer); 6 requires only 1–2 + 2B; 8 requires 3 + 5; 9 and 10 close out sequentially. Phase 12 came after all of them and touches only the frontend.
5. **`docs/reviews/`** holds the adversarial QA and status reviews, the production audits, and the CLI handoff prompts they generated (`docs/reviews/handoffs/`, with `TRACKING.md` as the board for those nine prompts). Reviews are evidence *about* the plan, not part of it — when a review and this plan disagree, PROGRESS.md is what settles it. The current one is `docs/reviews/status-review-2026-08-21.md`, with `docs/reviews/2026-08-21-phase-12-production-audit.md` as an independent corroboration of Phase 12 in production.

## Phase dependency graph

```
0 Foundation
└─ 1 Documents & viewer
   └─ 2 Page organization
      └─ 2B Anonymous access — removes the login wall; principal model + tiered limits + SSR tool pages
         ├─ 3 Annotations — builds the shared overlay layer
         │  ├─ 4 Content editing
         │  ├─ 5 Forms
         │  └─ 7 Security & redaction
         └─ 6 OCR, conversion & compare   (needs only 1–2 + 2B)

8  E-signatures        — after 3 + 5
9  Ads & abuse controls — after 8 (product feature-complete)
10 Hardening & release  — after everything
11 AdSense review readiness — after 9 + production deploy; gated on an owner-purchased custom domain, terminal gate external (Google review)
12 Usability add-ons     — after 3, 4, 5, 7 and 8 (it edits all six editing surfaces); frontend-only, no backend or infra change
```

**Why 2B sits there:** every phase after it adds ownership-coupled code. Doing the principal refactor once, before Phase 3, costs one focused phase; doing it after Phase 8 means unpicking eight phases of accumulated `filter(owner=request.user)`. From 2B onward, each phase also ships its own public tool page (§21.6) rather than deferring all SEO surface to Phase 9.

## Progress tracking

All execution status lives in **[PROGRESS.md](PROGRESS.md)** — the single source of truth (status table, per-phase acceptance evidence, decisions log, blockers, human review queue). Do not track status anywhere else.
