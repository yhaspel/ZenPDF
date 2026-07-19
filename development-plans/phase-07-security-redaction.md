# Phase 7 — Security & Redaction

**Goal:** encryption/permissions management, true content-destroying redaction (area + pattern), and document sanitization.

Depends on: Phase 3 (overlay for area redaction). Completes the P1 encrypted-document story.

## Backend

### Encryption (`pikepdf`, AES-256 / R6)
- `encrypt`: `{user_password?, owner_password, permissions: {print: none|lowres|full, copy: bool, modify: none|form_fill|annotate|full, accessibility: true (always — never restrict screen readers)}}` → pikepdf `save(encryption=Encryption(user=…, owner=…, R=6, allow=Permissions(...)))`. Owner password required; user password optional (open password). Version labeled "Protected". Document.is_encrypted=true; subsequent ops require the session password.
- `decrypt`: `{password}` → open with password, save unencrypted → "Unlocked" version; is_encrypted=false. Wrong password → `invalid_password` error (throttled: 5 attempts/min/doc).
- `set_permissions`: re-encrypt with new permission set (needs owner password).
- **Session password handling:** for encrypted docs, mutation ops accept `document_password` param (never persisted; passed worker-side in job params encrypted at rest? — v1: params JSON stores it transiently and job params for such ops are redacted from API responses + purged on completion (job.params_sanitize list). Documented tradeoff; full vault = backlog).

### Redaction (`redact` — PyMuPDF, TRUE removal)
Params: `{areas: [{page, rect §8}], patterns: [{kind: preset|regex, value, presets: ssn|email|phone|credit_card|iban}], search_text?: string, match_case, scope: pages?, fill: {color: black, label?: "REDACTED"}}`.
Engine: for patterns/search → `page.get_text("words")`-based regex over reconstructed text with rect mapping (preset regexes defined + unit-tested individually) → collect rects; add_redact_annot for every rect (+areas) with fill/overlay text → `apply_redactions()` (glyphs AND intersecting image content destroyed — PyMuPDF image redaction default `PDF_REDACT_IMAGE_PIXELS`) → **post-verification step**: re-extract text, assert zero pattern matches remain; if any residue (e.g., text-as-curves misses are undetectable — documented), job still succeeds but result includes `verification: {rechecked: true, residual_matches: 0}`. Version "Redacted". **Irreversibility UX:** redaction does not auto-run sanitize (they stay separate tools); the `redact` convenience flag `fork_clean_copy: true` → result is a NEW document containing only the redacted output (no prior versions to leak). Default ON in UI for redaction (the version-history leak is real: earlier versions still contain the content — this flag is the fix).
Dry-run: `dry_run: true` returns match rects/context for review UI (like P4 find&replace).

### Sanitize (`sanitize`)
Checklist params: `{metadata, xmp, javascript, embedded_files, hidden_layers_flatten, form_reset? (no — forms are a feature), links_external?, comments}` — engine: PyMuPDF del metadata/xmp, remove `/OpenAction`+`/AA`+doc-level JS, delete embedded files, flatten OCG layers (set visible state + drop OC), optionally strip annotations; pikepdf pass to drop leftover junk + `remove_unreferenced_resources`. Result includes a report of what was removed (counts). Version "Sanitized".

## Frontend
- Tool tab "Protect": encrypt dialog (passwords with strength meter + confirm, permissions checklist with plain-language labels), change-permissions, remove-password (password prompt).
- Tool tab "Redact": mode A draw areas on overlay (marked translucent black until applied); mode B search panel (preset chips SSN/email/phone/credit card/IBAN + free text/regex with validation) → dry-run review list (per-match include toggle, jump-to-page) → red "Apply redaction" with irreversible-action confirm (type doc title) + "create clean copy" checkbox (default on, explains version-history leak).
- Tool "Sanitize": checklist dialog → report toast ("Removed: 2 scripts, metadata, 1 attachment").
- Encrypted-doc UX completion: unlock flow feeding session password to subsequent ops transparently (facade holds it in memory only).

## Tests
Golden: encrypt→probe requires password, permissions bits verified via pikepdf `allow`; decrypt round-trip; wrong password error; redact area removes glyphs (extract empty in rect) AND image pixels (pixmap check); each preset regex catches fixture strings & skips near-misses (unit table); dry-run counts = applied count; clean-copy fork has 1 version; sanitize removes JS/attachments/metadata (asserted via pikepdf inspection) and reports counts; accessibility permission always allowed.
E2E: protect doc → reopen (password prompt) → unlock → redact all emails via preset (review shows 3, uncheck 1, apply 2) → download → text search proves removal → sanitize.

## Acceptance criteria
- [ ] Password-protect + unlock round-trip through UI; permissions visibly enforced in external viewers (spot-check print-restricted output).
- [ ] Pattern redaction on the PII fixture removes content irrecoverably (extraction + raw-bytes grep in test), clean-copy default prevents history leakage.
- [ ] Redaction of a region overlapping an image blacks out image content, not just overlay.
- [ ] Sanitize report accurate against a booby-trapped fixture (JS + attachment + metadata).
- [ ] Session-password ops work without re-prompting per action.

## Risks
- Text-as-outlines/vector text escapes pattern redaction (undetectable by extraction) → documented limitation in UI ("pattern search finds *text*; scanned/outline content: use area redaction after OCR/visual review").
- Password material in job params → sanitization scheme above; revisit with a proper secrets channel in backlog.
