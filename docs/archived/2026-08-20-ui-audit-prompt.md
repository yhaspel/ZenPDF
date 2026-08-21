# Handoff — UI audit + production bug hunt (2026-08-20)

**For:** Claude CLI, run locally on the Mac, in `~/Documents/Claude/Projects/ZenPDF`.
**What it does:** applies six commits that already exist as a patch, re-runs the full local
gate, and pushes — the push is the deploy (Railway auto-deploys `main`).

The work was done in a Cowork cloud session that **cannot push to `yhaspel/ZenPDF`**, so it is
delivered as a `git format-patch`. Everything below is one prompt; paste it into Claude CLI.

---

## The one-shot prompt

```text
You are picking up a finished piece of work on ZenPDF and getting it onto production.
Read AGENTS.md first, then development-plans/PROGRESS.md's newest session log entry
(2026-08-20) — it is the record of what this patch does and why.

Context you need up front:
- The repo is at ~/Documents/Claude/Projects/ZenPDF and `main` is at 00ccb52.
- Six commits are waiting in `.zen-ui-audit-2026-08-20.patch` in the repo root.
  They were authored against 00ccb52 and have been proven to `git am` cleanly onto it
  and reproduce the exact reviewed tree.
- A push to `main` IS the deploy. Six Railway services build from the repo; watch
  patterns mean `frontend/**` rebuilds `web`, `backend/**` rebuilds the Django five,
  and `infra/railway/**` rebuilds both. THIS PATCH TOUCHES ALL THREE — in particular
  `infra/railway/nginx.railway.conf`, and the nginx change is load-bearing: without it
  the PDF viewer stays blank in production.
- No migrations. No new npm or pip dependencies. No environment variables to set.
- Local env quirks: `.env` overrides API_PORT=8010 and DB_PORT=15432; Angular 22 needs
  Node >= 22.22.3.

Do this, and stop at the first step that does not come out clean:

1. Apply the patch.
     cd ~/Documents/Claude/Projects/ZenPDF
     git status --porcelain          # must be clean before you start; if it is not, stop and tell me
     git checkout main && git pull --ff-only
     git am .zen-ui-audit-2026-08-20.patch
   If `git am` fails, run `git am --abort` and stop — do not hand-resolve. Tell me what
   conflicted; the patch is regenerable.

2. Read the diff before you trust it. `git log --oneline -6` then `git show --stat` each
   commit. Six commits, in this order:
     - fix(api): a browser must never replay an answer meant for another principal
     - fix(guest): a dead token must not take the live session down with it
     - feat(annotate): a text box is text — on the page, edited there, and undoable
     - fix(workspace): the viewer that never loaded, and a screen that never fitted
     - fix(tools): merge in the order the visitor added the files
     - docs(progress): the UI audit, and the handoff that lands it
   Each message states the defect and the reasoning. If any of them describes something
   you disagree with after reading the code, say so before pushing.

3. Bring the stack up and run the full gate. This is the part the cloud session could not
   do, and it is the reason this handoff exists.
     ./infra/up.sh
     ./infra/test.sh --e2e
   Expect: ruff + mypy clean; the backend suite green (it needs the OCR language packs,
   Ghostscript and unpaper that only the containers have — those are the five failures a
   sandbox always shows and they must NOT appear here); `ng lint` clean; 250 frontend unit
   tests; the Playwright suite green.

   The e2e suite is the specific thing this patch has never been run against. Two specs
   matter most:
     - e2e/tests/phase-3.spec.ts — includes a NEW test, "a text box shows its words on the
       page, and undo takes them back". It was written against the new behaviour and has
       never executed. If it fails, read it before changing anything: it may be the test
       that is wrong about a selector, or it may be a real defect.
     - the phase-2 and phase-4/5 specs touch the workspace layout, which this patch
       changed (panes, host flex class). A failure there is likely a real regression.

4. Verify the two things the patch is actually for, by hand, on the local stack:
   a. Open a document and switch to View. The page must DRAW. Then check the network
      panel: `/assets/viewer-*.min.mjs` and `/assets/pdf.worker-*.min.mjs` must be served
      as `text/javascript` (not `application/octet-stream`), and
      `/api/documents/<id>/content/` must be requested. If the canvas is blank, the nginx
      change did not take — rebuild the web container rather than guessing.
   b. In Annotate, pick "Text box", drag a box, type a sentence. The words must appear
      INSIDE the box in dark ink at the size shown in the Font size slider — not in a
      small badge above it, not in yellow. Press Escape, then Undo in the page bar: the
      sentence goes. Redo: it comes back. Save, download, and confirm the text is in the
      file.

5. Push.
     git push origin main
   Then watch the deploy. Do not walk away from it: `web` and the Django services both
   rebuild, and the nginx config is in the web image.

6. Verify in production, at https://zenpdf.up.railway.app, in a REAL browser — and start
   from a genuinely cold state, because the defect this patch fixes lives in the browser
   cache. Either use a fresh profile or, in DevTools, Application → Clear storage → Clear
   site data. Then:
   a. `curl -sI https://zenpdf.up.railway.app/assets/pdf.worker-6.0.1169.min.mjs | grep -i content-type`
      must say `text/javascript`.
   b. `curl -s -D - -X POST https://zenpdf.up.railway.app/api/guest/session/ -o /dev/null | grep -i cache-control`
      must say `private, no-store`. And an error must say `no-store`:
      `curl -s -D - https://zenpdf.up.railway.app/api/documents/00000000-0000-0000-0000-000000000000/ -o /dev/null | grep -i cache-control`
   c. Upload a PDF at /annotate-pdf, land in the workspace, switch to View — the page
      draws, with no console errors.
   d. The returning-visitor case, which is the whole point. In DevTools console on the
      site, run `localStorage.setItem('zen_guest','definitely-not-a-real-token')`, then
      reload and upload a file at /annotate-pdf. It must simply work: one 410, one
      `POST /api/guest/session/`, then 200s, and NO "Your guest session ended" banner and
      no "An error occurred." screen.
   e. Open `/app/doc/00000000-0000-0000-0000-000000000000`. The message must now be
      "We could not find that. It may have been deleted, or it may belong to a session
      that has ended." — not "An error occurred." — and the screen must have a header
      with the brand and the theme toggle on it.

7. Record what happened. Append a short entry to development-plans/PROGRESS.md's session
   log saying the patch landed, what the e2e run found, and what production verification
   showed. Close the two 2026-08-20 rows in the Human review queue only if you actually
   did them. Commit that as `docs(progress): the UI audit landed` and push.
   Then delete `.zen-ui-audit-2026-08-20.patch` from the repo root.

Two things NOT to do:
- Do not "simplify" NUM_PROXIES back to 2. It is 3 by measurement (see the railway memory
  and docs/ops/); at 2 every client collapses into one throttle bucket.
- Do not run git through any file-bridge tool. Run it in a normal terminal. A previous
  session stranded .git/index.lock that way and the repo refused writes until it was
  moved aside.

If anything in step 3, 4 or 6 fails, stop and tell me exactly what you saw before
changing code. This patch has been verified against the live API from a production-
faithful harness, but never against the full local stack, and never in a real browser
after a deploy — those are precisely the two gaps you are here to close.
```

---

## What is in the patch, in one line each

| Commit | Defect |
|---|---|
| `fix(api)` | API responses carried no `Cache-Control`, so Chrome heuristically cached a `410 guest_expired` and replayed it for every later token — the site could never start a working session again in that browser. Also: `Http404` reached users as the literal words "An error occurred." |
| `fix(guest)` | A late-arriving 410 about an already-replaced token wiped the live session. And `guest_expired` now mints a fresh session and replays the request once, so a returning visitor just carries on. |
| `feat(annotate)` | A text box drew an empty yellow-framed rectangle and put its words in a truncated 10 px badge above it. Text now renders and is edited inside the box; colour and opacity are per tool family; Undo/Redo added (⌘Z / ⇧⌘Z). |
| `fix(workspace)` | The viewer never loaded in production (CSP refused the library's inline script; nginx served `.mjs` as `application/octet-stream` under `nosniff`). The workspace never filled the screen. It overflowed on a phone. Loading and error screens had no header. A 429 was dressed as a fatal error. Plus a version-level Undo and human-readable file sizes. |
| `fix(tools)` | `/merge-pdf` sent `document_ids` in network order, against its own promise that page order follows the order you add the files. |

## What was verified, and what was not

**Verified** (cloud session, against the live production API through a harness that copies
Railway's MIME map, CSP and `nosniff`): all 24 tool pages run end to end; the viewer loads
and draws; the returning-visitor recovery; the text box round-trips into a real `/FreeText`
annotation in a downloaded PDF; light, dark, 390 px and RTL; `data-test` parity 0 removed /
9 added; `ng lint`, 250 unit tests, build + 29 prerendered routes + `verify:prerender`,
ruff, mypy, and the backend suite diffed against baseline with no new failures.

**Not verified, and why:** the Playwright e2e suite (needs the full local stack — the cloud
sandbox has no outbound network for Chromium), and the deployed result itself. Steps 3, 4
and 6 above are exactly those gaps.
