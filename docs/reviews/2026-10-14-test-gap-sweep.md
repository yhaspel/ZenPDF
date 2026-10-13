# Test-gap sweep — 2026-10-14

Scope: close the measured unit/integration gaps across `backend/` and `frontend/`
**without touching product source**. Every file in this change is a test file, plus
this note. The seven product issues the sweep surfaced are listed at the end with
repros; none was fixed here, by design — a test sweep that quietly patches the
product is two changes pretending to be one.

## Numbers

| | before | after |
|---|---|---|
| backend tests (`pytest`) | 1 241 | **1 648** (+407) |
| backend line coverage (`apps`) | 92 % | **97 %** |
| backend modules at 100 % | 30 | **47** |
| frontend tests (`ng test`) | 678 | **1 049** (+371) |
| frontend modules no spec imports | 33 | **1** (`app.config*.ts`, provider wiring only) |

Gate checks run locally: `ruff check .` clean, `mypy apps config` clean (199 files),
`ng lint` clean, both suites green twice in a row (vitest ordering changes between runs).
The only backend failures are the five pre-existing environment-only ones that need
`gs`, `unpaper` and the tesseract language packs the worker image ships.

### Backend modules that moved

| module | before | after |
|---|---|---|
| `core/management/commands/oversized_accounts.py` | 0 % | 100 % |
| `users/managers.py` | 65 % | 100 % |
| `pdf_engine/engine/convert.py` | 79 % | 100 % |
| `pdf_engine/engine/seal.py` | 83 % | 100 % |
| `core/assets.py` | 83 % | 99 % |
| `pdf_engine/engine/text.py` | 83 % | 100 % |
| `jobs/views.py` | 85 % | 100 % |
| `core/observability.py` | 85 % | 100 % |
| `users/privacy.py` | 86 % | 100 % |
| `core/captcha.py` | 87 % | 100 % |
| `pdf_engine/engine/security.py` | 88 % | 100 % |
| `esign/views.py` | 88 % | 100 % |
| `pdf_engine/storage.py` | 89 % | 100 % |
| `esign/tasks.py` | 89 % | 100 % |
| `pdf_engine/engine/signatures.py` | 89 % | 100 % |
| `pdf_engine/engine/pages.py` | 90 % | 100 % |
| `core/tasks.py` | 90 % | 98 % |
| `documents/views.py` | 90 % | 99 % |
| `documents/tasks.py` | 91 % | 99 % |

### Frontend modules that now have a spec

`features/sign/ceremony` (40 cases — consent gate, required-field gating, draw/type
signature, decline, report, last-signer polling), `verify`, `disclosure-page`,
`request-list`; `features/settings` (export/delete/verify-banner/consent, 24),
`features/dashboard` (36 — trash/restore/purge gating, merge, uploads, folders, ads),
`features/landing`, `app-shell`, `legal/*`, `guides-index`; `core/client-errors`,
`core/services/verification`, `folders.service` + `folders.facade`, `guards/unsaved-work`,
`retention`; `shared/signature-pad` (fake 2-D context), `theme.service` (runs
`public/theme-boot.js` under `vm` and asserts the service agrees with it for eight
stored × OS combinations), `theme-toggle`, `toast`, `confirm`, `modal.directive`,
`consent-banner`, `guest-banner`, `upload-dropzone`, `fit-width`, `viewer-tab-order`,
`tool-icon` (every slug in `TOOL_SLUGS`), `brand`, `empty-state`, `spinner`, `save-blob`.

### Quality check

An independent pass (a reviewer that had not seen the tests being written) sampled
fourteen of the new files and ran ten product mutations — removing a clamp, flipping a
branch, changing a constant — each restored afterwards. **All ten were caught** by at
least one new test. It also found one test that had pinned a defect as a contract
(`confirm.service.spec.ts`, see issue 5) and removed that assertion.

### Not covered, and why

- `pdf_engine/engine/convert.py:211` ("No pages could be read from those images") —
  unreachable: an unreadable image raises earlier, a readable one always yields a page.
- `pdf_engine/engine/pages.py:427` (palette-PNG transparency skip) — PyMuPDF rewrites
  such images with an SMask on insert, so the earlier `smask` branch always wins.
- `documents/views.py:124-125` — `select_for_update`, Postgres only (`./infra/test.sh --pg`).
- `core/tasks.py:143` — a malformed export row with no `storage_key`.
- `ClientErrorHandler`'s `typeof location === 'undefined'` prerender branch — jsdom
  always has a `location`.
- Focus-restore `setTimeout`s in `dashboard.ts` and `ceremony.ts` — cosmetic, and jsdom
  focus is unreliable.

### Environment notes for whoever runs this outside Docker

- `test_observability.py` needs `ADMIN_ENABLED=true` and a reachable `REDIS_URL`; the
  compose env file supplies both, a bare `pytest` does not.
- The `zenpdf` logger has `propagate: False`, so log assertions on the purge tasks must
  attach a handler to it directly (see the `sweep_log` fixture in `test_purge_failures.py`).
- Angular's unit-test builder pre-bundles with esbuild, so v8 coverage reports 0 % for
  every source file. "Does any spec import it" was used as the frontend measure instead.

## Product issues found (confirmed by independent repro, not fixed here)

Severity is user-visible impact. Each was reproduced from a throwaway script against
the current tree.

1. **`merge()` propagates a bare `RecursionError`** — `pdf_engine/engine/pages.py:287`.
   `src.get_toc(simple=True)` on `tests/fixtures/pdfs/deep-outline.pdf` overflows the
   stack; `inspect.py` guards its own `get_toc` with `try/except`, `merge` does not. The
   job layer catches it generically, so the user sees *"Operation failed: maximum
   recursion depth exceeded"*. The fixture passes ingest, so it is reachable from the UI.
   *Low–medium.* Fix: guard as `inspect` does, or skip that document's outline.

2. **PATCH truncates `title` to 5 000 chars against a 255-char column** —
   `esign/views.py:341-343` vs `SignRequest.title = CharField(max_length=255)`. POST
   slices `[:255]` correctly; PATCH does not, and `full_clean` is never called. SQLite
   accepts it; Postgres raises → 500. The SPA never PATCHes `title`, so API-only. *Low.*

3. **Saving a signature at storage quota is a 500** — `esign/views.py:123`.
   `store_image()` raises `AssetQuotaExceeded` (a `ValueError`) outside the `try` that
   maps `EngineError`/`ImageRejected`. Repro: `TIERS["free"]["storage_mb"]=0`, then
   `POST /api/signatures/ {"method":"type","text":"Ada"}` → 500. `core/views.py:316`
   shows the intended mapping to `QuotaExceeded`. *Medium* — a full account cannot save
   a signature and gets no quota message; logged as a crash.

4. **`FoldersFacade` swallows every HTTP error** — `abstraction/folders.facade.ts:14,18`
   subscribe with `next:` only. A failed `POST /api/folders/` is an unhandled RxJS
   error that `ClientErrorHandler` ignores (it early-returns on `HttpErrorResponse`,
   assuming facades handle them); `dashboard.ts:164-169` clears the input immediately,
   so a failed create looks like success. `documents.facade.ts` has eight `error:`
   handlers; `folders`, `pages`, `security`, `compare`, `convert`, `workspace-shell` have
   none. *Medium.*

5. **`ConfirmService.ask()` orphans a pending promise** — `shared/confirm.service.ts:15-18`.
   A second `ask()` while one is pending overwrites `current` without settling the first,
   so the first `await this.confirm.ask(...)` never resumes (13 call sites). Hard to
   reach through the UI (the dialog is focus-trapped), but a test in this sweep had been
   written to *pin* the behaviour; that assertion was removed. *Low.*

6. **The upload dropzone is not keyboard-operable** — `shared/upload-dropzone.ts:28-36`.
   The `<input type=file>` is `class="hidden"` (`display:none`, unfocusable) inside a
   `<label>` with no `tabindex` or keydown handler, and it is the *only* route into the
   file picker on every `/<tool>` page (`tool-page.html:24`) and the dashboard
   (`dashboard.html:94`). WCAG 2.1.1 failure on the product's primary action; contradicts
   the accessibility floor in `AGENTS.md`. *High for a11y.* Fix: visually-hidden (not
   `display:none`) input, or `tabindex="0"` + Enter/Space on the label.

7. **Two modal dialogs can be Tabbed out of** — `shared/modal.directive.ts:39`.
   `FocusTrapFactory.create()` runs at field-init; when `zenModal` is on the root element
   of an `@if` block, `parentNode` is `null` and CDK silently never attaches its anchor
   sentinels. TestBed repro: 0 `.cdk-focus-trap-anchor` elements for that shape, 2 when
   nested under a scrim. Affected: the Tool-options dialog (`workspace.html:397-398`) and
   the Add-link dialog (`edit.html:446-447`); `ceremony`, `confirm-host`, `sign` and
   `shortcuts-help` use the working shape. Escape and initial focus still work. *Medium.*
   Fix: create the trap in `ngAfterViewInit`/`afterNextRender`, or move `zenModal` off the
   `@if` root in those two templates.
