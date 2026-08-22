> **Executed 2026-07-19 — kept as history. Do not run.** Phases 0, 1 and 2 are ✅ in `PROGRESS.md` and have been through eight further phases of change since; running this again would drive an agent to rebuild a foundation that exists. It is kept because it records what the phases were asked to be, which is not the same as what they became — the drifts are in PROGRESS's Decisions log.

# One-Shot Prompt 1 — Execute Phases 0–2 (Foundation → Documents & Viewer → Page Organization)

**Usage:** start an agent session (e.g. Claude Code) with its working directory at the **ZenPDF repo root** (the folder containing `development-plans/`), with Docker installed and the daemon running, and paste everything below the line as the prompt.

---

You are an expert full-stack engineer executing a pre-approved, pre-reviewed development plan **autonomously, start to finish, without asking for permission at each step**. Your mission: fully implement **Phase 0, Phase 1, and Phase 2** of ZenPDF.

## Step 1 — Read the plan (in this exact order, fully)

1. `development-plans/PROGRESS.md` — the canonical execution tracker; follow its **Update protocol** for the entire session.
2. `development-plans/README.md` — product decisions, document index, phase order.
3. `development-plans/01-architecture.md` — **normative**: stack pins (§2), repo layout (§4), compose services + infra scripts (§5), API conventions (§6), frontend conventions (§7), coordinate system (§8), data model (§9), operation registry (§10), job pipeline (§11–12), storage (§13), versioning (§14), email/beat (§15), quotas (§16), security (§17), testing (§18), env matrix (§19), Definition of Done (§20).
4. `development-plans/phase-00-foundation.md`, `development-plans/phase-01-documents-and-viewer.md`, `development-plans/phase-02-page-organization.md` — your work orders.
5. Consult `development-plans/00-research-findings.md` and `development-plans/02-feature-matrix.md` only when context is needed; do not expand scope from them.

## Step 2 — Environment preflight

Verify and record in PROGRESS.md: `git` present (init a repo at the root if none; create a proper `.gitignore` — never commit `.env`, `infra/certs/`, `node_modules/`, venvs, or build output); `docker` + `docker compose` working (`docker info` succeeds); Node 24 available for scaffolding (if absent, run scaffold commands through a `node:24` container). If Docker is unusable and you cannot fix it, record a Blocker and stop.

## Step 3 — Execute (rules of engagement)

- **Order:** Phase 0 → Phase 1 → Phase 2. Within Phase 0, run the **0.1 scaffold-day verification checklist first** and fill the "Verified pins" table in PROGRESS.md before writing project code.
- **Authority:** `01-architecture.md` wins over phase docs on any conflict; fix the conflicting text in the same commit and note it in the Decisions log. The operation registry (§10), data model (§9), error shape (§6), and coordinate convention (§8) are law.
- **Pre-approved fallbacks** (use without stopping, record in Decisions log): Django 5.2.16 LTS if a dependency blocks Django 6.0; `python:3.13-slim` if 3.14 wheels are missing; the content-delivery and viewer-src alternatives explicitly speced as dual-path in 01-architecture §13 and phase-01.
- **No scope creep:** items marked BL/OUT in `02-feature-matrix.md` stay out. No extra libraries beyond §2 without a Decisions-log entry justifying necessity.
- **Verification is the gate, not vibes:** a phase is complete only when (a) every acceptance criterion in its phase doc is ticked in PROGRESS.md **with evidence**, (b) the §20 Definition of Done holds, (c) `./infra/up.sh` succeeds on a torn-down stack (`./infra/reset.sh --yes` then up) and (d) `./infra/test.sh --e2e` is fully green including the phase's Playwright happy-path spec. Run the real commands; paste result summaries into PROGRESS.md.
- **Testing discipline:** write the tests the phase docs enumerate (golden engine tests against `backend/tests/fixtures/pdfs/`, cross-user isolation fixture applied router-wide, geometry rotation tests, Range/206 tests). Build or obtain the fixture corpus in Phase 0/1 as specified; generate synthetic fixtures with scripts committed to the repo.
- **Commits:** small, conventional (`feat(phase-1): …`, `test: …`, `infra: …`), after each green milestone. Never leave the tree broken at a phase boundary.
- **Blockers:** after ~3 distinct failed approaches to the same obstacle, stop hacking: record a 🟡 Blocker in PROGRESS.md (symptom, attempts, smallest human decision needed) and halt that phase. Do not silently weaken acceptance criteria, skip tests, or stub features to "get past" a gate.
- **Progress hygiene:** follow the PROGRESS.md Update protocol literally (phase sections, session log, decisions). PROGRESS.md is the only status record (README "Progress tracking" just points to it) and supersedes any phase-doc instruction to record outcomes inside the phase file — never fork status into other files.

## Step 4 — Done definition for THIS session

Phases 0, 1, 2 all ✅ in PROGRESS.md with evidence; a fresh-clone-simulating run (`./infra/reset.sh --yes && ./infra/up.sh && ./infra/test.sh --e2e`) fully green; seeded demo user can register/login, upload, view, search, organize pages, merge/split, and revert versions through the UI; all work committed. Finish by writing a short handoff note in the PROGRESS.md session log stating exactly where Phase 3 should begin (it is speced in `development-plans/phase-03-annotations.md`) and flagging anything a human should eyeball (e.g. workspace look & feel) in the Human review queue.
