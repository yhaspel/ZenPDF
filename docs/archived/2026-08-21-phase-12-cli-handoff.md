# Phase 12 — CLI handoff

> **EXECUTED — 2026-08-21.** Every step below was carried out on the owner's Mac and the
> phase is closed. Merged as **PR #20** (`ec8a33e`); the record, with the numbers the gate
> actually produced, is the Phase 12 section and the session-log entry in
> `development-plans/PROGRESS.md`. Kept here verbatim as the prompt that was run — nothing
> in it has been edited after the fact.
>
> Three things it did not predict, all recorded in PROGRESS:
>
> 1. **`§1`'s host commands do not work on this machine.** Node is 25.2.1, which ships its
>    own `localStorage` global; `token.service.ts` guards on `typeof localStorage ===
>    'undefined'`, so a host `ng test` fails 108 tests and a host `ng build` fails every
>    prerendered route. The gate was run inside the pinned-Node `web` container — which is
>    what `infra/test.sh` does anyway — and the guard is now a queue row.
> 2. **`e2e/tests/phase-12.spec.ts` failed all three specs** the first time it was ever
>    run, and §1's warning was right: all three were test problems, not product problems.
>    Each acted before Angular's zoneless change detection had rendered the frame the
>    previous action caused. Verified by hand in a browser first, then the spec was made to
>    wait on observable state rather than race it.
> 3. **§4's self-review found two real defects** in the phase's own code: Protect, Sign and
>    the request builder declared `aria-keyshortcuts="Control+Z Meta+Z"` on buttons with no
>    handler behind them, and six `menuTargetId` signals were written and never read. Both
>    fixed in the same PR.
>
> `phase-2b:130`, which §1 lists as a known pre-existing failure, **passed** — it was the
> stale Celery worker recorded on 2026-08-21, and `infra/up.sh` restarts the workers.

**For Claude Code, running on the owner's Mac, in `~/Documents/Claude/Projects/ZenPDF`.**

Phase 12 is **implemented and verified** — the code is already in the working tree on `main`. What is left is everything a cloud session cannot do: run the parts of the gate that need the full local stack, commit, push, open a PR, review it, merge it, and come back to a clean `main`. Work through this file top to bottom and do not skip a step because the previous one looked fine.

Read first: `development-plans/phase-12-usability-add-ons.md` (the plan, including §0.1's six defects and §5's contract amendments) and `AGENTS.md`.

---

## 0. What is in the working tree

Uncommitted changes on `main`, nothing else. Nothing is staged; there is no patch file and no branch to `git am`.

**New files (13)**

```
development-plans/phase-12-usability-add-ons.md
docs/archived/2026-08-21-phase-12-cli-handoff.md   ← this file (archived after execution)
e2e/tests/phase-12.spec.ts
frontend/src/app/shared/history.ts
frontend/src/app/shared/history.spec.ts
frontend/src/app/shared/shortcuts.ts
frontend/src/app/shared/shortcuts.spec.ts
frontend/src/app/shared/shortcuts-help.ts
frontend/src/app/shared/shortcuts-help.spec.ts
frontend/src/app/shared/editor-clipboard.service.ts
frontend/src/app/shared/editor-clipboard.service.spec.ts
frontend/src/app/features/workspace/annotate.spec.ts
frontend/src/app/features/workspace/edit.spec.ts
frontend/src/app/features/workspace/sign.spec.ts
frontend/src/app/features/workspace/workspace-undo.spec.ts
frontend/src/app/features/sign/request-builder.spec.ts
```

**Modified**

```
development-plans/PROGRESS.md
docs/design/design-instructions.md                 ← §§2–4, 6, 8 amended (plan §5)
frontend/src/styles.scss                           ← .menu extended, .kbd added
frontend/src/app/shared/page-overlay/page-overlay.ts|.html|.spec.ts
frontend/src/app/shared/page-overlay/overlay-model.ts|.spec.ts
frontend/src/app/abstraction/annotations.facade.ts ← lifted onto HistoryStack
frontend/src/app/abstraction/edit.facade.ts
frontend/src/app/abstraction/forms.facade.ts
frontend/src/app/abstraction/security.facade.ts
frontend/src/app/abstraction/esign.facade.ts
frontend/src/app/features/workspace/{annotate,edit,forms,protect,sign,workspace}.ts|.html
frontend/src/app/features/workspace/{forms,protect}.spec.ts
frontend/src/app/features/sign/request-builder.ts|.html
```

No migrations. No new npm or pip dependencies. No env changes. No `infra/` changes, so **no service needs a rebuild beyond the normal frontend deploy** — pushing to `main` is the deploy, as always.

---

## 1. Gate — run all of it, locally

The cloud session ran everything in this list except the e2e suite and the backend, both of which need the full stack. Re-run the lot anyway; the point of this step is that it ran *here*.

```bash
cd ~/Documents/Claude/Projects/ZenPDF

# Frontend — these were green in the cloud sandbox at node 22.23.2
cd frontend
npm run lint                # expect: All files pass linting
npx ng test --no-watch      # expect: 47 files, 391 tests, 0 failed  (baseline was 38 / 258)
npm run build               # expect: Prerendered 29 static routes
npm run verify:prerender    # expect: 24 tool pages … sitemap and robots
cd ..

# Backend — untouched by this phase, so this is a "no new failures" check
./infra/up.sh
ruff check backend && mypy backend
docker compose exec api pytest      # diff against the baseline; nothing here touches Python

# e2e — the part the cloud could not run at all
./infra/test.sh --e2e
```

**About the e2e run.** `e2e/tests/phase-12.spec.ts` is new and has **never been executed**. It was written to the same shape as `phase-3.spec.ts` (1440×1100 viewport, `fitPage`, fraction-based drags) but treat a failure in it as a *test* problem first and a product problem second — verify by hand in the browser before changing product code. Two things to know if it misbehaves:

- The phase-3 helper style captures the overlay's bounding box once and clicks at fractions of it. **Do not do that after the rail contents change**: adding a row to a rail can move the page pane, and a stale box then aims the click at empty backdrop. `phase-12.spec.ts` re-reads the box, but if you extend it, re-read it too. This is exactly how a real defect (§0.1 D-E) hid for an hour.
- `phase-2b:130` ("extract takes the pages the visitor typed") is a **known pre-existing harness failure**, recorded 2026-08-21. It is not ours.

---

## 2. Verify by hand, in a browser, in both themes

The cloud session drove the built bundle against the live production API and checked all of this (see PROGRESS). Spot-check it on the real local stack, because this is a UI phase and `AGENTS.md`'s definition of done says so:

1. `/annotate-pdf` → drop a PDF → draw a rectangle → **⌘C ⌘V** → two marks, the copy offset.
2. **Right-click the copy** → Copy · Cut · Duplicate · Edit comment… · Paste here · Delete. Walk it with ↑/↓, activate with Enter, close with Esc.
3. Select a mark, press **Delete** — gone; **⌘Z** — back. Arrow keys move it; Shift+arrow moves it ten times as far; at the page edge it stops.
4. **⌘/** opens the shortcuts sheet: 15 rows, Esc closes, the *Shortcuts* button in the bar opens the same thing.
5. Protect → Redact → draw an area → **click it: it must still be there and outlined** (this is defect D-C, and the old behaviour deleted it). The Areas list in the rail has a ✕ per row. Undo brings a removed area back.
6. Sign → place a signature → the Placements list appears with a ✕ (before this phase a placement could not be removed at all — D-B).
7. The workspace bar carries **Undo and Redo**. Two Undos in a row must go back **two** versions, not there-and-back (D-D).
8. All of the above in **light and dark**, at **1440** and **390** px.

---

## 3. Commit

One commit per coherent change, on a branch. Suggested split — adjust if you prefer, but keep the defect fixes legible:

```bash
git checkout -b feat/phase-12-usability

git add frontend/src/app/shared/history.ts frontend/src/app/shared/history.spec.ts \
        frontend/src/app/shared/shortcuts.ts frontend/src/app/shared/shortcuts.spec.ts \
        frontend/src/app/shared/editor-clipboard.service.ts \
        frontend/src/app/shared/editor-clipboard.service.spec.ts \
        frontend/src/app/shared/shortcuts-help.ts frontend/src/app/shared/shortcuts-help.spec.ts \
        frontend/src/styles.scss
git commit -m "feat(shared): one history, one keyboard map, one clipboard

Five editing surfaces were about to grow their own undo stack and their own
keydown listener. HistoryStack is AnnotationsFacade's proven snapshot design
lifted out verbatim; resolveShortcut is a pure function so every rule — not
while typing, AltGr is not Alt, no bare printable characters (WCAG 2.1.4) — is
a two-line test; EditorClipboard is typed and in-app, because an annotation is
an object and navigator.clipboard is async, permission-gated and absent in
jsdom."

git add frontend/src/app/shared/page-overlay/
git commit -m "fix(overlay): a right-click was doing a left-click's work

pointerdown fires before contextmenu and neither handler tested event.button,
so a right-click cleared the selection, latched a move drag with pointer
capture on button 2, and — in Protect, where selecting an area removed it —
deleted the thing the user was trying to open a menu on. With that fixed the
overlay gains the menu itself (generic: the feature supplies a resolver and
receives the choice), arrow-key nudging through the existing geometryChanged
channel, a role and a live region on a host that had neither, and two smaller
corrections a browser found: focus() no longer scrolls the page out from under
the pointer, and a zero-distance drag is no longer recorded as a move."

git add frontend/src/app/abstraction/ \
        frontend/src/app/features/workspace/ frontend/src/app/features/sign/
git commit -m "feat(workspace): undo, redo, copy/paste and a menu in every editing mode

Undo and Redo are now visible controls in Annotate, Edit, Forms, Protect, Sign
and the request builder, each over its own staged store; the bar carries a
version-level Redo and no longer replays itself on a second Undo. Clicking a
redaction area or a signature placement selects it instead of destroying it —
both surfaces gain a rail list with a 44px remove, because right-click does not
exist on a phone. Edit's links gain a selection and the confirm its images
always had. Off-palette Tailwind indigo, cyan and slate swapped for the
contract's own values."

git add docs/design/design-instructions.md development-plans/ e2e/tests/phase-12.spec.ts
git commit -m "docs: phase 12 — the plan, the contract amendments and the record"
```

Every commit message above is a claim about the code; if you split differently, keep the claims true.

---

## 4. PR, review, merge

```bash
git push -u origin feat/phase-12-usability
gh pr create --fill --title "Phase 12 — usability add-ons: undo/redo, keyboard, right-click"
```

The PR body should carry: the gate numbers you actually got, the `data-test` parity (**0 removed, 27 added** — verify with the command below), and the six defects from plan §0.1.

```bash
git diff main --unified=0 -- 'frontend/src/**/*.html' | grep '^-' | grep -o 'data-test="[^"]*"' | sort -u > /tmp/gone.txt
git diff main --unified=0 -- 'frontend/src/**/*.html' | grep '^+' | grep -o 'data-test="[^"]*"' | sort -u > /tmp/added.txt
comm -23 /tmp/gone.txt /tmp/added.txt   # must be empty
```

**Then review your own PR properly** — read the diff as if someone else wrote it, and check at least:

- No `data-test` renamed or removed (contract §10).
- No hardcoded colour outside the contract palette in anything the diff touches (§9 forbids Tailwind indigo and blue-slate grays by name).
- Every rendered control has a wired action (§10, "no dead UI") — in particular the new rail lists and the menu entries.
- `resolveShortcut` is not called anywhere that also lets the overlay handle the same key. The mode components deliberately skip `cancel`, `delete`, `context-menu` and the nudges; the overlay owns those on the focused element.
- `AnnotationsFacade`'s behaviour is unchanged by the `HistoryStack` lift — its own spec is the regression test and must not have been edited.

Merge when it is green and you are satisfied. Then:

```bash
git checkout main
git pull origin main
```

Pushing `main` is the deploy. Watch Railway until all six services return ● Online and `/api/health/` reports `status: ok`, then do one production smoke: open `/annotate-pdf`, upload, draw a mark, right-click it, and confirm the menu appears with a clean console.

---

## 5. Close the phase in PROGRESS.md

`development-plans/PROGRESS.md` already carries the Phase 12 section, its acceptance criteria and the session log, with the status set to **🟠 Awaiting the local gate**. After the gate passes and the PR merges, in one commit:

1. Set the status-overview row and the phase section to **✅ Complete**, with today's date.
2. Tick the two criteria the cloud session could not evidence — the e2e run and the local-stack gate — each with one line of real evidence (test name + count, or command output). **Unproven ticks are forbidden** (update protocol step 4).
3. Append a session-log entry recording what the local gate found: the e2e result, the backend diff against baseline, and the production smoke.
4. Mark this handoff **done** in the Phase 12 section, and say so in the log.

If anything in §1 or §2 fails, do **not** tick it. Record it in the Phase 12 section with what you saw, and open a queue row instead — a green tick with a red test underneath it is the one outcome this file exists to prevent.
