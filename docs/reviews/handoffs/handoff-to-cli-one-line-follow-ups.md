# Handoff — Land the one-line box's follow-ups (2026-08-26, later still)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** the patch carries its own commit — apply it onto a fresh `fix/one-line-follow-ups`.
**Depends on:** PR #45 (`1dd2263`) on `main` — it is (`b384bf3`).
**What lands:** `.zen-one-line-follow-ups.patch` (repo root on this Mac, sha256 `2c5f3c8b…`), one commit proven to `git am` cleanly onto `b384bf3`. It closes three of the four rows PR #45's self-review filed, plus the client half of the fourth:

- **Sign and the request builder get their handles back** — `PageOverlay.handlesWhileDrawing` (default false), set by `sign.html` and `request-builder.html` only; Annotate, Forms, Protect unchanged. The MEDIUM row is resolved.
- **One line is measured at the zoom** — `Annotate.atLeastOneLine` works in overlay pixels (`⌈1.25 × fontPx⌉ + 2`) and takes it back to the page; the `1.4 ×` multiple is gone; tests at 900 and 437 px. The hairline LOW row is resolved; contract §3 corrected.
- **No rect can carry a sub-micron origin** — `clamp01` (frontend, every geometry producer) and `NormRect.from_dict` (backend, every rect off the wire) round to six decimals, the precision the readers already write. The hang did not reproduce on x86-64 (every case in the row returns in ≤ 4 ms), so it is guarded rather than patched; the row is resolved with that said.
- **A job the worker never returns from is given up on after 16 minutes** — `JobsFacade.track` reports it as the reaper will (`failed`/`timeout`/the reaper's sentence), so panels toast and release `busy()`. The server half of that row is corrected in place: the soft limit fired, but a Python exception cannot interrupt MuPDF's C loop; the hard limit and `reap_stalled_jobs` are what end it (~35 min), and now the client stops sooner.

**Verified in the sandbox:** unit **593 / 66 files** (+2), `ng lint` clean, build + **43 routes** + `verify:prerender`; backend `pdf_engine` + `documents` **721 passed** (the 5 failures are the sandbox's Ghostscript ×2 and tesseract/unpaper ×3), `ruff` + `mypy` clean.

**Deploys on merge?** Yes — `frontend/**` and `backend/apps/pdf_engine/geometry.py`. No migrations, no deps, no env.

Paste everything in the block below into `claude`.

---

```text
You are landing a prepared one-commit follow-up to PR #45 (the one-line text box): Sign's
handles restored, the line measured at the zoom, sub-micron rect origins rounded away on
both ends, and a 16-minute client ceiling on job polling. Read AGENTS.md, then the PROGRESS
session-log entry "2026-08-26 (later still) — What the one-line box's self-review found,
closed" (inside the patch), then docs/reviews/handoffs/TRACKING.md ("Landed outside the
programme").

## 0. Apply

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain            # clean apart from .zen-one-line-follow-ups.patch and
                                      # docs/reviews/handoffs/handoff-to-cli-one-line-follow-ups.md
    shasum -a 256 .zen-one-line-follow-ups.patch   # must start 2c5f3c8b
    git switch main && git pull --ff-only origin main   # expect b384bf3 or later
    git switch -c fix/one-line-follow-ups
    git am --3way .zen-one-line-follow-ups.patch  # conflict → git am --abort, stop, tell me
    rm .zen-one-line-follow-ups.patch
    git add docs/reviews/handoffs/handoff-to-cli-one-line-follow-ups.md
    git commit -m "docs(handoffs): the one-line follow-ups prompt, as run"

## 1. Read the diff

page-overlay.ts/.html (`handlesWhileDrawing`), sign.html + request-builder.html (the one
binding each), overlay-model.ts (`clamp01`), annotate.ts (`atLeastOneLine`, the two
constants), jobs.facade.ts (`TRACK_CEILING_MS`, the synthesized failed job),
backend/apps/pdf_engine/geometry.py (`from_dict`), the five tests, the contract, PROGRESS.

## 2. Gate

    ./infra/up.sh && ./infra/test.sh --pg --e2e

Expect unit 593 / 66, lint clean, 43 routes, backend one more than the last green run
(the geometry test), Playwright as last time. Append the numbers under "**Landed.**" in
the PROGRESS entry.

## 3. Chrome MCP, localhost:4200, both themes

(a) Sign: make a signature, place it, right-click it → four handles, a corner drag
resizes it (this is the regression PR #45 introduced — confirm it is gone). (b) Request
builder step 2: same on a placed field. (c) Annotate, Text box armed: draw a box, then
another directly under it starting on its bottom edge → a new box, no handles shown
until Select; Select → handles back. (d) Annotate: select a box, drag its NW handle past
the page's left edge and Save → the save completes (the stored x is 0; read it on
GET /annotations/). (e) Reproduce the MuPDF hang if you can on this arm64 stack the way
the row describes, through the API this time — with the patch it must not be reachable:
the rect the server receives is already rounded; if you can still make a worker spin
with a rounded rect, that is a new finding, stop and file it. (f) The poll ceiling is
16 minutes and cannot be driven by hand; the fake-timer unit test is its evidence.
Screenshot each; one line per item in PROGRESS.

## 4. Archive, ship, record, validate live

    git mv docs/reviews/handoffs/handoff-to-cli-one-line-follow-ups.md \
           docs/archived/$(date +%F)-handoff-to-cli-one-line-follow-ups.md
    # prepend "**Executed <date> — see PROGRESS.md session log 2026-08-26 (later still). Historical.**", commit
    git push -u origin fix/one-line-follow-ups
    gh pr create --base main --head fix/one-line-follow-ups \
      --title "fix(overlay): Sign keeps its handles, one line is measured at the zoom, and a rect can no longer carry a sub-micron origin" \
      --body "<What (four items) / Verification (gate numbers + Chrome evidence) / Risk: overlay template + annotate + jobs facade + geometry.py; no migrations, no deps>"

Self-review (regression lens): `clamp01` now rounds — confirm nothing compares a produced
coordinate for exact equality against an unrounded one (the overlay-model and page-overlay
suites pass; read `sameRect` and `transformRect`'s callers once); the synthesized failed
job carries the last polled job's fields plus the three overrides — confirm every
`(saved)`/`onJob` consumer only reads `status`, `error_code`, `error_message`, `result`.
Then `gh pr merge --merge --delete-branch`, `git switch main && git pull --ff-only`, the
TRACKING "Landed outside the programme" row (`docs(tracking): one-line follow-ups landed`),
wait for the new `main-*.js` on https://zenpdf.up.railway.app, repeat 3(a) and 3(d)
there as a guest, append "**Live.**" to the PROGRESS entry and push. Report the numbers
and the evidence; file anything else as a queue row.
```
