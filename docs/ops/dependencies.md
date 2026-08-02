# Keeping the engine libraries patched

**Monthly, and after any advisory.** This product's job is parsing files
somebody else made, and the parsers are C libraries with a long history of
memory-safety bugs. They are the most likely route to remote code execution
here, and the update cadence is the control.

## What to watch

| Library | Reaches | Where the advisories are |
|---|---|---|
| MuPDF (via PyMuPDF) | every render, every page operation | <https://mupdf.com/releases> · GHSA for `PyMuPDF` |
| qpdf (via pikepdf) | validation, encryption, sanitize | <https://github.com/qpdf/qpdf/releases> |
| Ghostscript | PDF/A conversion | <https://ghostscript.readthedocs.io> · Ghostscript CVE list |
| Pillow | every uploaded image | GHSA for `Pillow` |
| Tesseract / OCRmyPDF | OCR of scanned pages | project releases |
| Chromium (via Gotenberg) | URL → PDF | Gotenberg image tags |

The Python ones are visible to tooling; the system ones (Ghostscript,
Tesseract, Chromium) come from the base images, which is why the images are
rebuilt on the same cadence rather than only when a Python pin changes.

## The monthly pass

```bash
# 1. Python advisories
docker compose run --rm api sh -c "pip install --quiet pip-audit && python -m pip_audit"

# 2. JavaScript advisories
docker compose run --rm --no-deps web npm audit --omit=dev

# 3. Rebuild on the current base images (picks up Ghostscript, Tesseract, etc.)
docker compose build --pull api web

# 4. Prove the parsers still behave
docker compose run --rm -e DJANGO_SETTINGS_MODULE=config.settings.test api pytest -q
cd e2e && npx playwright test --grep @smoke
```

Anything `pip-audit` reports in a parser gets applied the same day; the rest
goes into the next release. Record the date and what moved, here:

| Date | What changed | Who |
|---|---|---|
| 2026-08-02 | Pillow 11.3.0 → 12.3.0 (18 decoder advisories), requests 2.32.5 → 2.33.0, pytest 8.4.1 → 9.0.3 | phase-10 audit |

## Why the hostile corpus matters here

`backend/apps/pdf_engine/tests/test_hostile_corpus.py` is the regression net
for exactly these upgrades: it asserts that a page bomb, a decompression bomb
and a malformed image still fail as *messages* within a time and memory budget.
If an upgrade changes that, the suite says so before a user finds out.
