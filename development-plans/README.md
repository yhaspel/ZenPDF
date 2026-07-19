# ZenPDF — Development Plan

**Created:** 2026-07-19 · **Stack verified as of:** 2026-07-19 · **Status:** Ready for implementation

ZenPDF is a free-to-use, ad-supported, multi-user web application for editing, organizing, converting, securing, and signing PDF documents — a web-based product covering the table-stakes feature set of Adobe Acrobat / Foxit / Smallpdf-class tools, plus a DocuSign-class e-signature workflow, built entirely on open-source components.

## Locked product decisions (confirmed with owner, 2026-07-19)

| Decision | Choice |
|---|---|
| User model | Multi-user app: accounts + JWT auth, private per-user workspace. Teams/sharing = backlog. |
| E-signing | Full: self-sign + multi-party signature requests + cryptographic PAdES tamper seal (pyHanko). |
| Licensing | AGPL acceptable → PyMuPDF + Ghostscript unlocked as core engine. |
| OCR | In scope (OCRmyPDF/Tesseract). |
| Conversions | In scope (Gotenberg/LibreOffice, pdf2docx, PyMuPDF). |
| Monetization | **Free to use, ad-revenue model.** No billing/subscriptions. No AI assistant. (Scope change 2026-07-19, superseding earlier Stripe/AI scope.) |
| Stack | Latest Angular (v22) + latest Django (6.0) per `django-angular-project-setup` skill conventions. Full local Docker stack, single `infra/up.sh`. |

## Document index

| File | Contents |
|---|---|
| [PROGRESS.md](PROGRESS.md) | **Canonical execution tracker** — status, decisions, blockers, human review queue |
| [prompt-1-phases-00-02.md](prompt-1-phases-00-02.md) | One-shot agent prompt: execute Phases 0–2 autonomously |
| [prompt-2-phases-03-07.md](prompt-2-phases-03-07.md) | One-shot agent prompt: execute Phases 3–7 autonomously (requires Prompt 1 done) |
| [00-research-findings.md](00-research-findings.md) | Competitor + e-sign research digest, feature taxonomy, verified stack facts, sources |
| [01-architecture.md](01-architecture.md) | **The canonical reference**: stack versions, repo layout, data model, API + operation conventions, coordinate system, storage, jobs, security model, env matrix |
| [02-feature-matrix.md](02-feature-matrix.md) | Every researched feature → phase mapping (proof of completeness) |
| [phase-00-foundation.md](phase-00-foundation.md) | Monorepo scaffold, auth, Docker stack, infra scripts, job framework |
| [phase-01-documents-and-viewer.md](phase-01-documents-and-viewer.md) | Upload, library, folders, versions, PDF.js viewer, thumbnails, search |
| [phase-02-page-organization.md](phase-02-page-organization.md) | Merge, split, reorder, rotate, extract, insert, crop, N-up, compress |
| [phase-03-annotations.md](phase-03-annotations.md) | Highlights, notes, shapes, ink, stamps, comments sidebar, flatten |
| [phase-04-content-editing.md](phase-04-content-editing.md) | Edit/add text, images, links, whiteout, find & replace, watermark, headers/footers, Bates, metadata |
| [phase-05-forms.md](phase-05-forms.md) | Fill AcroForms, create fields, import/export data, flatten |
| [phase-06-ocr-conversion-compare.md](phase-06-ocr-conversion-compare.md) | OCR, to/from-PDF conversions, PDF/A, repair, document compare |
| [phase-07-security-redaction.md](phase-07-security-redaction.md) | Encrypt/decrypt, permissions, true redaction, sanitize |
| [phase-08-esignatures.md](phase-08-esignatures.md) | Saved signatures, self-sign, sign requests, public signing ceremony, audit trail, PAdES seal, verification |
| [phase-09-ads-and-abuse-controls.md](phase-09-ads-and-abuse-controls.md) | Ad slots + consent (CMP), landing page, quotas, throttling, anti-abuse |
| [phase-10-hardening-release.md](phase-10-hardening-release.md) | Security hardening, performance, a11y, E2E suite, prod deploy |

## How to use this plan

1. Implement phases **in order**. Each phase is self-contained: models, endpoints, UI, tests, acceptance criteria. A phase is done only when its **Acceptance criteria** all pass and its tests are green — no TODOs left behind.
2. `01-architecture.md` is normative. Phase docs reference it instead of restating conventions (coordinates, job pipeline, error shapes, storage keys). If a phase doc and the architecture doc conflict, the architecture doc wins — and the conflict should be fixed in the same commit.
3. Version pins in the architecture doc were verified against official sources on 2026-07-19. Phase 0 contains a short "re-verify on scaffold day" checklist for anything that may have moved (marked ⚠ in the stack table).
4. Recommended order is strictly linear (0→10). If parallelizing with multiple developers: 4, 5, and 7 each require 3 (they reuse its overlay layer); 6 requires only 1–2; 8 requires 3 + 5; 9 and 10 close out sequentially.

## Phase dependency graph

```
0 Foundation
└─ 1 Documents & viewer
   └─ 2 Page organization
      ├─ 3 Annotations — builds the shared overlay layer
      │  ├─ 4 Content editing
      │  ├─ 5 Forms
      │  └─ 7 Security & redaction
      └─ 6 OCR, conversion & compare   (needs only 1–2)

8  E-signatures        — after 3 + 5
9  Ads & abuse controls — after 8 (product feature-complete)
10 Hardening & release  — after everything
```

## Progress tracking

All execution status lives in **[PROGRESS.md](PROGRESS.md)** — the single source of truth (status table, per-phase acceptance evidence, decisions log, blockers, human review queue). Do not track status anywhere else.
