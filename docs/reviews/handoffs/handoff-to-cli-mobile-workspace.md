# Handoff — A designed phone workspace: drawers and a bottom bar instead of a stack (2026-08-21, revision 2 after Phase 12)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `feat/mobile-workspace`. **Depends on:** `handoff-to-cli-workspace-debt-batch.md` merged (shared pane templates).
**Source of truth:** PROGRESS Human review queue row "The workspace on a phone is stacked, not designed" (2026-08-20, still open after the 08-21 repair and after Phase 12); `docs/design/design-instructions.md` §3 workspace panes / workspace bar / **Context menu** (Phase 12) and §4 (per-mode Undo/Redo, nudging); `development-plans/phase-12-usability-add-ons.md` §1 D8 (every right-click action must also be reachable from a rail — your drawers are those rails on a phone); `docs/reviews/status-review-2026-08-21.md` §3.3 and L9/§0 (at 390 px every mode is 390 wide after Phase 12 too — the overflow is fixed; the *layout* is the rescue).
**Deploys on merge?** Yes — frontend.

---

```text
You are replacing the phone workspace's rescue layout (rails stacked above and below the
page, §3 "workspace panes") with a designed one, the way the 2026-08-20 row imagined it:
rails as drawers, a persistent bottom bar, the page first. This is UI work under the
design contract, so the contract is amended FIRST (gap rule) and the implementation
follows the amendment — never the other way round.

Read: AGENTS.md; docs/design/design-instructions.md — every section, then §3 (workspace
bar, panes, seg, sheet, tool-card), §4 workspace, §5 motion, §6 accessibility, §10
invariants; docs/design/mockups/04*/05* (reference only — contract wins); the 2026-08-20
and 2026-08-21 PROGRESS entries about the workspace; frontend/src/styles.scss
(`.ws-*` rules, :735–770), frontend/src/app/features/workspace/workspace.{ts,html} and
the seven pane templates; frontend/src/tailwind.css (tokens — you use semantic tokens
only, no raw colours/radii/sizes).

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    git switch -c feat/mobile-workspace

TRACKING: in docs/reviews/handoffs/TRACKING.md set row 6 to
`🔵 in progress — `feat/mobile-workspace`, <today>` (Status column) and put the branch name in
the next column; include that edit in your FIRST commit on the branch. Touch no other row.

PROGRESS session-log entry; the queue row → 🔵.

## 1. Spec first — amend the contract (own commit)

In docs/design/design-instructions.md §3/§4, specify the phone workspace (< `md`):
- **Bottom bar** (persistent, safe-area aware): the mode `.seg` becomes a horizontally
  scrollable row of icon+label buttons at the bottom (≥ 44 px targets, `aria-pressed`,
  contract focus ring), with Save/primary action of the active mode docked at its end
  where the pane has one, and **the mode's Undo/Redo pair** (Phase 12 put one in every
  editing surface's page bar; on a phone they belong in the bar, not in a drawer). Spec
  heights, tokens (`bg-surface`, hairline `border-line`, shadow token), the scrim. The
  workspace bar's own version Undo/Redo and the Shortcuts button move into the overflow
  of the top bar — a shortcuts sheet is keyboard-only by nature and need not be
  prominent on a phone.
- **Drawers:** the left rail (thumbnails/outline/history) and the right rail (the mode's
  panel) open as bottom sheets / side drawers over the page — one at a time — with a
  handle, a title, Escape/scrim-tap to close, focus trapped while open (CDK), body scroll
  locked, `prefers-reduced-motion` honoured (no slide when reduced). Spec which mode
  opens its panel drawer by default (annotate: palette as a compact bottom row rather
  than a drawer — decide and write it down), and where comments/history and Phase 12's
  Areas/Placements/Fields lists live (they are the touch-reachable equivalent of the
  right-click menu — D8 — so they must stay one tap away).
- **Page first:** the page fills the viewport width at fit-to-width on first paint (D7
  already says so for desktop — confirm it holds at 390 and say so).
- **Workspace bar** at the top shrinks to back · title · meta; mode nav moves to the
  bottom bar on phones only. Desktop (≥ `md`) is unchanged — write that invariant.
- Keep every existing `data-test` (the drawers wrap the same panels; additive attributes
  `ws-bottom-bar`, `ws-drawer`, `ws-drawer-close`).
Update the mockups? No — the contract says it wins; add a note in §4 that 04/05 mockups
are desktop-only references. Commit: `docs(design): the phone workspace — drawers and a
bottom bar`.

## 2. Implement to the spec

- Styles in `styles.scss` under the `.ws-*` family (component layer), tokens only;
  remove the stacked-rail rules at :753–769 once the drawers replace them (nothing
  unreachable may remain — no dead CSS).
- A small `shared/drawer.ts` (CDK overlay/dialog based, like the existing dialogs — reuse
  the dialog service's focus-trap and Escape handling; do not hand-roll a11y) and a
  `features/workspace/ws-bottom-bar.ts`. Components stay presentation-only; drawer open
  state lives in the workspace component's signals (not a facade — it is view state), or
  in `ViewerFacade` if another component needs it; write the decision down.
- `[useInlineScripts]="false"` and every viewer binding stay exactly as they are.
- The annotate pane toolbar's `flex-wrap` (08-21) still governs tablets; on phones the
  palette is the compact row you specced.

## 3. Tests

Unit: bottom bar renders the nine modes with `aria-pressed` and routes the mode change;
drawer traps focus, closes on Escape and scrim, restores focus to the opener, locks body
scroll; reduced-motion path; workspace at a narrow `matchMedia` stub shows the bar and
hides the desktop rails, and the reverse at ≥ `md` (use a `MediaMatcher` stub). e2e: new
`phase-10-mobile.spec.ts` at 390×844 (`isMobile: false`, exact viewport — the 2026-08-21
measurement trap): open a document, page drew (`expectPageDrew`), open/close both drawers
by tap and Escape, switch modes via the bottom bar, complete one real operation per
mode group (rotate in organize, a square in annotate, a text edit, fill a field,
protect), download; assert `scrollWidth === visualViewport.width` in every mode; axe scan
of the phone workspace (zero serious/critical). Keep `phase-8`'s 390×844 ceremony spec
green — the ceremony is not in scope and must not change.

## 4. Gate

`npm test`, `ng lint`, `npm run build && npm run verify:prerender`,
`./infra/test.sh --e2e` fully green (63 + your new specs; unit baseline 396); data-test parity (additive only); Lighthouse
a11y ≥ 90 on `/app/doc/<id>` at the mobile preset (local build).

## 5. UI testing via the Chrome MCP tools — this prompt is mostly this

On http://localhost:4200 with the Chrome MCP tools, **both themes**, at **390×844 and
414×896 with device emulation OFF** (resize the window; the 08-21 trap is that emulation
hides overflow), then at 768 and 1280 to prove desktop is untouched:
1. `/annotate-pdf` → upload → workspace: the page is the first thing on screen, fits the
   width, bottom bar visible, no horizontal scroll (read `document.documentElement.scrollWidth`
   and `visualViewport.width` via the javascript tool).
2. Each of the nine modes from the bottom bar: screenshot; open the panel drawer, do one
   action, close with Escape and with the scrim; read the console.
3. Thumbnails drawer: jump to page 3.
4. Keyboard only (Tab/Enter/Escape via the computer tool): open a drawer, reach its close
   button, close it, land back on the opener.
5. Reduced motion: toggle the OS/devtools setting and confirm drawers appear without a
   slide.
6. RTL spot-check (`document.dir='rtl'`): drawers and the bar mirror.
7. 768 px and 1280 px: desktop layout identical to before (compare against screenshots
   taken on `main` BEFORE your change — take those first).
Record one line per finding with the screenshot names in PROGRESS. After merge, repeat 1
and 2 on https://zenpdf.up.railway.app once the deploy is live — on a real phone too if
one is at hand (ten minutes; note it as owner evidence otherwise).

## 6. Record, self-archive, ship

PROGRESS: close the 2026-08-20 row ✔ with evidence; Decisions log (drawer vs sheet,
annotate palette treatment, where state lives, removal of the stacked rules); the
contract amendment already committed. Then:

    git mv docs/reviews/handoffs/handoff-to-cli-mobile-workspace.md docs/archived/$(date +%F)-handoff-to-cli-mobile-workspace.md

prepend the "Executed <date>" banner.

TRACKING: after the merge and the `git pull --ff-only` below, set row 6 of
docs/reviews/handoffs/TRACKING.md to `✅ merged — PR #<n> (<merge sha>), <date>, archived at
docs/archived/<date>-handoff-to-cli-mobile-workspace.md`, fill the PR/merge column, and put the PROGRESS anchor
(your session-log heading and the queue rows you closed) in the Evidence column. Commit that
one edit directly on `main` as `docs(tracking): prompt 6 merged` and push — docs only, no
deploy, the same way `f34800f` recorded Phase 12. This is the last commit of the run — do it
before you report. (The README carries no status; the board does.)

Commit in chunks (contract first; `feat(workspace): bottom bar`, `feat(shared): drawer`,
`style(workspace): …`, `test: …`, `docs(progress): …`); push;
`gh pr create --base main --head feat/mobile-workspace --title "feat(workspace): a designed phone workspace — drawers and a bottom bar" --body "<What / Spec sections / Verification / Chrome evidence with screenshots / Desktop unchanged proof>"`.

Self-review — *a11y* (focus trap, names, order, reduced motion, contrast in both themes,
44 px targets — run the phase-10 axe spec and the new mobile one), *contract* (tokens
only; nothing hardcoded; every affordance wired; data-test parity), *regression*
(desktop pixel-compare at 1280 before/after; ceremony spec untouched and green), *perf*
(no layout thrash on drawer open — check with the performance panel). Fix; re-run the
gate; `gh pr merge --merge --delete-branch && git switch main && git pull --ff-only
origin main`; production check; revert on `main` if production regresses. Report.
```
