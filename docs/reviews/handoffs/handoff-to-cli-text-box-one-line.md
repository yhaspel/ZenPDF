# Handoff — Land the one-line text box (2026-08-26, later)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** the patch carries its own commit — apply it onto a fresh `fix/text-box-one-line`.
**Depends on:** PR #44 (`960baba`) being on `main` — it is (`53043c1`).
**What lands:** `.zen-text-box-one-line.patch` (repo root on this Mac, sha256 `89148530…`), one commit proven to `git am` cleanly onto `53043c1`:

`fix(annotate): a text box is never shorter than one line, and resize handles are Select's alone` — owner-observed while validating PR #44 on production: every field traced along a printed form line rendered with its words cut in half (the drag was ~16 px tall where 12 pt at 900 px needs ~18, and the box clips to its rect on screen and in the file). A drag thinner than one line of its type (1.4 × the font size in points, against the page's real height — `AnnotationsFacade.pageHeightFor`, learned from the words payload) is grown to that height at creation, **upwards** so the traced line stays the one the words sit on; tall drags are untouched. With it, the selection's **resize handles render only with the Select tool** — under a draw tool they stayed live and a box drawn just below the selected one resized it instead. Contract §3 paragraph + §11 row; PROGRESS session entry, the handle row filed-and-resolved, one new LOW/product row (Edit's read model counts FreeText appearance text as page text — a scan with text boxes loses its gate).

**Verified in the sandbox:** unit **591 / 66 files** (+4: grow-upwards, keep-tall, clamp-at-top, facade page height, handles-only-with-Select), `ng lint` clean, build + **43 routes** + `verify:prerender`; on the local build against the production API, five thin drags along the owner's form lines all became full-line boxes (25 px, `scrollHeight === clientHeight`, no clipping) with the words sitting on the traced lines and no handle interception. Backend untouched.

**Deploys on merge?** Yes — `frontend/**` only. No migrations, no deps, no env.

Paste everything in the block below into `claude`.

---

```text
You are landing a prepared one-commit follow-up to PR #44 (the annotate text-box fix):
a drawn text box is never shorter than one line of its type, and resize handles are
Select's alone. Read AGENTS.md, then the PROGRESS session-log entry "2026-08-26 (later)
— Validated live, and the box that was one line too short" (inside the patch), then
docs/reviews/handoffs/TRACKING.md ("Landed outside the programme" is where this goes).

## 0. Apply

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain            # clean apart from .zen-text-box-one-line.patch and
                                      # docs/reviews/handoffs/handoff-to-cli-text-box-one-line.md
    shasum -a 256 .zen-text-box-one-line.patch   # must start 89148530
    git switch main && git pull --ff-only origin main   # expect 53043c1 or later
    git switch -c fix/text-box-one-line
    git am --3way .zen-text-box-one-line.patch  # conflict → git am --abort, stop, tell me
    rm .zen-text-box-one-line.patch
    git add docs/reviews/handoffs/handoff-to-cli-text-box-one-line.md
    git commit -m "docs(handoffs): the one-line text box prompt, as run"

## 1. Read the diff

annotate.ts (TEXT_LINE, atLeastOneLine, the call in onCreated), annotations.facade.ts
(_pageSizes / pageHeightFor), page-overlay.html (the handles' `tool() === 'select'`
condition), the four tests, the contract paragraph, the PROGRESS entry and rows.

## 2. Gate

    ./infra/up.sh && ./infra/test.sh --e2e   # no backend change: --pg not needed

Expect unit 591 / 66, lint clean, 43 routes, Playwright as the last run (86 passed /
1 skipped) — phase-3's free-text spec draws boxes 0.1 of the page tall, far above one
line, so nothing there changes. Append the real numbers under a "**Landed.**" line in
the PROGRESS entry.

## 3. Chrome MCP, localhost:4200, both themes

backend/tests/fixtures/pdfs/scanned.pdf → Annotate → Text box. (a) Trace a printed line
with a drag only a few pixels tall, type: the box is one full line, the words whole and
sitting on the line. (b) Draw a tall box: kept as drawn. (c) With Text box still armed,
draw the next box directly under the previous one, starting on its bottom edge: a new
box, not a resize (no handles are shown until Select). (d) Select → the four handles are
back, a corner drag resizes. (e) Save, reload: the boxes come back at the grown height.
Screenshot each; one line per item in PROGRESS.

## 4. Archive, ship, record, validate live

    git mv docs/reviews/handoffs/handoff-to-cli-text-box-one-line.md \
           docs/archived/$(date +%F)-handoff-to-cli-text-box-one-line.md
    # prepend "**Executed <date> — see PROGRESS.md session log 2026-08-26 (later). Historical.**", commit
    git push -u origin fix/text-box-one-line
    gh pr create --base main --head fix/text-box-one-line \
      --title "fix(annotate): a text box is never shorter than one line, and resize handles are Select's alone" \
      --body "<What / Verification (gate numbers + Chrome evidence) / Risk: frontend annotate + overlay template only>"

Self-review (regression lens): the handles condition must not touch Forms/Protect/Sign
— they pass `readonlyHandles` or use Select anyway; confirm by clicking through Protect's
redact tab and Sign's placement once. Then `gh pr merge --merge --delete-branch`,
`git switch main && git pull --ff-only origin main`, add the TRACKING "Landed outside the
programme" row (`docs(tracking): one-line text box landed`), wait for the new `main-*.js`
on https://zenpdf.up.railway.app, repeat 3(a) and 3(c) there as a guest, append a
"**Live.**" line to the PROGRESS entry (`docs(progress): one-line text box verified live`)
and push. Report the numbers and the evidence; file anything else as a queue row.
```
