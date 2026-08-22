# Phase 12 — Usability add-ons: undo/redo, keyboard, right-click

**Goal:** make the editing surfaces behave the way every other editor on the machine behaves. Three things people reach for without thinking and do not currently find in ZenPDF: a **right-click menu** on the thing under the pointer, **keyboard shortcuts** for the actions they use constantly (copy/paste, undo/redo, delete, nudge, save), and **Undo / Redo controls that are visible** in every mode that edits — not only in Annotate, and not buried three clicks deep in a History tab.

Depends on: Phase 3 (the overlay primitive — arch §7), Phase 4 (Edit), Phase 5 (Forms), Phase 7 (Protect/redact), Phase 8 (Sign + the request builder). **No backend work.** Every action this phase reaches already exists in the client; the phase is about reaching it, plus the six defects the survey and the browser check turned up.

Design contract: `docs/design/design-instructions.md` is law (`AGENTS.md` → "Design governance"). This phase adds patterns the contract does not have and fixes rules it already had; **§5 amends the contract in the same change**, per the gap rule.

> **This document was revised after an adversarial review** (two independent passes read it against the built code; 47 findings, 14 of them HIGH). The review's material corrections are folded in below and the defects it surfaced are listed in §0.1 (with two more that only a browser could find). Nothing in §0 is asserted from memory — every cell was read out of the tree.

---

## 0. What is true today (read out of the code, not remembered)

Snapshot: `main`, 2026-08-21, after PR #19.

| Surface | Undo/redo | Right-click | Delete key | Copy/paste | Selection |
|---|---|---|---|---|---|
| **Annotate** `workspace/annotate.ts` | ✅ real — `AnnotationsFacade` keeps a 100-deep snapshot history (`canUndo`/`canRedo`/`undo`/`redo`); `annot-undo` / `annot-redo` in the page bar; ⌘Z / ⇧⌘Z on a `window` keydown listener (`annotate.ts:221-236`) | ❌ | ✅ the **only** consumer wired to `(deleteRequested)` (`annotate.html:186`) | ❌ | `[selectedId]="annotations.selectedId()"`, and the comments sidebar's `comment-jump` selects — the one keyboard-reachable selection path in the app |
| **Edit** `workspace/edit.ts` | ❌ `EditFacade._edits` stages block edits with no history. Everything else is an immediate server op appending a version: `add_text`, `whiteout`, `add_image`, `replace_image`, `delete_image`, `add_link`, `delete_link`, `watermark`, `page_numbers`, `header_footer`, `bates`, `overlay_pdf`, `set_metadata`, `set_bookmarks`, find & replace | ❌ | ❌ not wired | ❌ | `[selectedId]="null"` — hard-bound (`edit.html:365`). Only `selectedImage` exists; **links have no selection state and `deleteLink` has no confirm** (`edit.ts:404-406`) |
| **Forms** builder `workspace/forms.ts` | ❌ `FormsFacade._ops` stages add/update/delete with no history | ❌ | ❌ not wired | ❌ | `[selectedId]="selectedItemId()"` ✅, `(geometryChanged)` ✅ |
| **Protect / redact** `workspace/protect.ts` | ❌ `SecurityFacade._areas`; `addArea` / `removeArea` only — **no move** | ❌ | ❌ not wired | ❌ | no `[selectedId]`; `onSelect(id) → removeArea(id)` — **a left-click destroys the area** |
| **Sign** `workspace/sign.ts` | ❌ `EsignFacade._placements`; `place` / `unplace` only — **no move** | ❌ | ❌ not wired | ❌ | no `[selectedId]`; `onSelect(id) → unplace(id)` is **unreachable dead code** (see §0.1 D-B) |
| **Sign request builder** `features/sign/request-builder.ts` | ❌ `fields = signal<DraftField[]>([])`, no history | ❌ | ❌ | ❌ | no `[selectedId]`; `onSelect` filters the field out of the list — the same destructive click as Protect, and likewise unreachable (`armedFor` is never cleared) |
| **Compare** `workspace/compare.ts` | — read-only; `onOverlaySelect` jumps to a diff row | — | — | — | `[selectedId]="compare.selectedId()"` |
| **Workspace bar** `workspace/workspace.ts` | ⚠️ half — a version-level **Undo** (`undo-version`) reverts to `currentSeq - 1`. **No Redo, and repeated Undo is broken** (§0.1 D-D) | — | — | — | — |

Two more facts that shape the work:

1. **`grep -rn contextmenu frontend/src` returns nothing.** No context menu exists anywhere, and there is no in-repo pattern to copy. There *is* a `.menu` block in `styles.scss:524-550` (raised surface, hairline, `shadow-3`, `--radius-2`, `.menu-danger`) used by the dashboard's ⋯ menu — that is the visual starting point. It is **not** in the design contract: §3's only mention is a parenthetical inside the file-card spec (`design-instructions.md:150`). Adding the pattern to §3 is therefore required, not optional.
2. **pdf.js binds `keydown` on `window`** whenever `<ngx-extended-pdf-viewer>` is mounted (`viewer-6.0.1169*.mjs`), and it claims `Ctrl/⌘+S` (download), `+` / `-` (zoom) and `PageUp`/`PageDown` (paging), calling `preventDefault()`. The viewer is mounted in **View** mode (`workspace.html`) and the Forms **fill** tab (`forms.html`) — and in no other mode. `ignoreKeyboard` / `ignoreKeys` / `acceptKeys` inputs exist on the component and are set on neither.

### 0.1 Six defects found on the way, fixed by this phase

Four turned up while surveying the code; **D-E and D-F only appeared when the built app was driven in a real browser**, because both are layout facts and jsdom has no layout. They are listed in the order they matter, not the order they were found.

- **D-A — a right-click already acts as a left-click on the overlay.** `page-overlay.ts:228` `onPointerDown` and `:352` `onItemPointerDown` never test `event.button`, and `pointerdown` precedes `contextmenu`. So today, right-clicking a redaction area deletes it, right-clicking a mark starts a latched `move` drag with `setPointerCapture` on button 2, and right-clicking empty page clears the selection. **This must be fixed before a context menu can exist at all.**
- **D-B — signature placements cannot be removed.** `sign.html` binds `[tool]="esign.hasSignature() ? 'rect' : 'select'"`, and `onPlaced` returns early unless `hasSignature()`; so a placement can only exist while the tool is `rect`, and `onItemPointerDown` returns early unless the tool is `select`. `onSelect → unplace` is unreachable. `sign.html:46` nonetheless reads *"N placement(s). **Click one to remove it.**"* The same shape of bug is in the request builder.
- **D-C — the Protect panel documents a destructive click.** `protect.html` `data-test="area-count"`: *"N area(s) marked. **Click one to remove it.**"* — and it is the *only* way to remove one; the rail has no per-area control.
- **D-E — focusing the overlay scrolls the page out from under the pointer.** The overlay host *is* the whole page box, taller than the pane that holds it, so a plain `element.focus()` scrolls it into view. Closing the context menu restored focus that way, the page moved, and the next click landed on backdrop and cleared the selection — so the menu appeared to work exactly once. Every focus call in the overlay now passes `{ preventScroll: true }`. **Found by driving a real browser; no unit test saw it, because jsdom has no layout.**
- **D-F — a click on a shape was recorded as a move.** `onItemPointerDown` starts a `move` drag on every selecting click, and `onPointerUp` emitted `geometryChanged` unconditionally — so each click added a history entry with identical coordinates, and the first ⌘Z after selecting something appeared to do nothing. A zero-distance drag is now not a change.
- **D-D — the workspace bar's Undo replays itself.** `undoLastChange()` always targets `currentSeq() - 1` (`workspace.ts:368`). Undo at v5 reverts to v4, appending v6. Pressing Undo again targets v5 — **which restores the change just undone**. Undo is single-shot today and silently becomes Redo on the second press.

---

## 1. Design decisions

**D1 — The clipboard is in-app and typed, not the system clipboard.**
`navigator.clipboard` is async, permission-gated, absent on insecure origins and in jsdom, and an annotation is a structured object, not text. Copy/paste therefore moves a typed value through an injectable `EditorClipboard` (`{kind, payload}`), and **paste only accepts its own kind**. The feature stays synchronous, deterministic and unit-testable, and never touches the user's real clipboard. ⌘C/⌘X are **skipped entirely** when the document has a non-collapsed text selection, so copying a comment out of the sidebar still does what it always did.

**D2 — Undo is local-session undo, and it is per surface.**
Every editing mode already batches locally and commits one job per session. That batch is what a person means by "undo" while working, so each mode gets a history over **its own staged store**. Once a session is saved, undo means "take the file back a version", and that lives in the workspace bar. The two are deliberately separate: binding ⌘Z to a server round-trip that appends a version would make a keystroke destructive. **Edit's mode-level Undo therefore covers staged text-block edits only** — its immediate server ops (§0's list) are the bar's business, and the button says so.

**D3 — One history implementation, six users.**
`AnnotationsFacade`'s snapshot history is the proven design (snapshot the whole local state, restore it whole — undo is exact, not a replayed inverse). It is lifted verbatim into a generic `HistoryStack<T>` in `shared/`, and `AnnotationsFacade` is refactored onto it, so every new history is the same code and the untouched `annotations.facade.spec.ts` is the regression test for the lift.

**D4 — The shortcut table is data; the resolver is a pure function.**
`resolveShortcut(event, opts)` maps a `KeyboardEvent` to a `ShortcutId | null` with no DOM access and no component state. The same `EDITOR_SHORTCUTS` array feeds the resolver's labels and the help sheet — one entry per `ShortcutId`, asserted bidirectionally — so a shortcut cannot be listed but unimplemented, or implemented but undocumented.

**D5 — No single-character shortcuts, anywhere.**
WCAG 2.1 SC 2.1.4 requires a shortcut using only a letter/number/punctuation/symbol to be switchable off, remappable, or active-on-focus-only. Rather than build a remapping UI, **every binding in this phase carries a modifier or is a non-printable key.** Help is `Mod+/` (Slack/GitHub's binding), not `?`. Zoom keeps its existing `+`/`−` *buttons* and gains no key — which also sidesteps §0's fact 2, since `+`/`−`, `PageUp`/`PageDown` and `Mod+S` are pdf.js's inside the two surfaces where the viewer is mounted. Our handlers live in components that are **not mounted in View mode**, and Forms' handler is gated to the `build` tab, so no binding in this phase can collide with the viewer's.

**D6 — The context menu is generic, like the overlay it lives in, and it asks for its actions synchronously.**
`overlay-model.ts` states the law: the overlay "knows about *shapes on a page*, never about annotations". The menu keeps that — the overlay owns *opening, positioning, keyboard navigation, dismissal*; the feature supplies the actions and receives `menuAction`. It also emits `contextTarget` **before** opening, a **separate output from `selectionChanged`**, because in Protect and the request builder selection is destructive.

The actions arrive through **`menuActionsFor: (itemId) => OverlayMenuAction[]`, a function, not an array** — and that is load-bearing rather than stylistic. The overlay must decide *inside* the `contextmenu` handler whether to `preventDefault()`, because a browser menu cannot be suppressed after the fact. An array input cannot answer in time: emitting `contextTarget` sets a signal in the parent, but the input carrying the result only refreshes on the next change detection, so the overlay reads the **previous** item's actions. Written the first way, Protect's menu never opened at all while Annotate's worked by luck (its list happened to be non-empty already) — and no unit test caught it, because a fixture runs change detection between steps and papers over exactly this gap. A browser did.

**D7 — An empty `menuActions` means no menu**, and the browser's own menu is left alone. "No dead affordances" (contract §10) applies to menus. Locked items (`locked: true`, e.g. redaction pattern matches) are hit-tested explicitly and always return no actions — they are `pointer-events: none` in the SVG, so the surface handler must `closest('[data-item-id]')` rather than rely on the item receiving the event.

**D8 — The menu is an accelerator, never the only path.**
Right-click does not exist on a phone and this repo's contract forbids controls that are unreachable at a breakpoint. So every action the menu offers is *also* a real control: Protect and Sign and the request builder each gain a **rail list of what has been placed, with a 44 px remove per row** (they have none today — see D-B/D-C); Annotate's comments sidebar gains **Copy** and **Duplicate** beside its existing Edit/Delete, and the palette gains **Paste** when the clipboard holds a mark. Those lists are also the keyboard's way to select an item, which is why this phase adds no "cycle items" shortcut — Annotate already works that way and the rest now match it.

**D9 — Arrow-key nudge is physical, and so is menu positioning.**
The nudged thing is a page raster (`<img>`) plus an SVG user-space layer; neither mirrors under `dir="rtl"`, and the overlay measures pointers physically (`event.clientX - box.left`). Feeding a physically-measured offset into `inset-inline-start` would mirror the menu across the page under RTL, and `ArrowLeft → start` would move a shape visibly right. So: `nudge-left`/`nudge-right` map to `-dx`/`+dx` unconditionally, and the menu is placed with physical `left`/`top` like every other child of the overlay. Contract §8 governs *layout CSS*; this is direct manipulation of a fixed raster, and every editor (Figma, Illustrator, Preview) nudges physically in RTL locales. §5 records the exception so it is a decision, not a lapse.

**D10 — Nudge needs a geometry path that three surfaces do not have.**
`(geometryChanged)` is bound only in `annotate.html` and `forms.html`; `SecurityFacade` and `EsignFacade` expose no move at all. So nudging is delivered for **Annotate and Forms** (which get it for free through the handlers that already re-derive quads/ink/vertices), and Protect / Sign / the request builder gain `moveArea(id, rect)` / `movePlacement(id, rect)` / a field move plus the `(geometryChanged)` binding — because otherwise the selection outline would render four live resize handles wired to nothing, which contract §10 forbids. Edit's overlay items are read-models of the file (blocks, images, links); they are **not** movable and Edit therefore renders selection without handles (`readonlyHandles`).

**D11 — Version-level Undo/Redo is a cursor, not a stored stack.**
A revert *appends*, so "the version whose content is showing" and `currentSeq()` diverge. The bar keeps `{ ceiling, content, expected }`: a chain starts with `ceiling = currentSeq()`; Undo reverts to `content - 1`; Redo reverts to `content + 1` and is offered only while `content < ceiling`; the whole cursor is ignored unless `currentSeq() === expected`, so **any other operation ends the chain by arithmetic** with no invalidation plumbing. This fixes D-D and makes Undo and Redo provably never resolve to the same version.

---

## 2. Shared primitives (`frontend/src/app/shared/`)

### `history.ts` — `HistoryStack<T>`
```
remember(snapshot: T): void      // push onto past, drop the future, cap at 100
undo(current: T): T | undefined  // pop past, push current onto future
redo(current: T): T | undefined  // pop future, push current onto past
clear(): void
readonly canUndo / canRedo: Signal<boolean>
```
A pure state machine over two arrays and two signals; it never learns what a snapshot is.

### `shortcuts.ts` — the table and the resolver
```
type ShortcutId =
  | 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'duplicate' | 'delete' | 'save'
  | 'nudge-up' | 'nudge-down' | 'nudge-left' | 'nudge-right'
  | 'context-menu' | 'help' | 'cancel'
interface ShortcutSpec { id: ShortcutId; keys: string[]; label: string; group: string }
const EDITOR_SHORTCUTS: readonly ShortcutSpec[]        // exactly one entry per id
function isTypingTarget(el: EventTarget | null): boolean
function resolveShortcut(e: KeyboardEvent, opts?: { hasTextSelection?: boolean }): ShortcutId | null
```

`Mod` = ⌘ or Ctrl — both accepted everywhere, which is what `annotate.ts` already does with `metaKey || ctrlKey`.

| Action | Keys | Notes |
|---|---|---|
| Undo | `Mod+Z` | |
| Redo | `Mod+Shift+Z`, `Ctrl+Y` | `Ctrl+Y` only *without* `meta`, so ⌘Y stays the browser's |
| Copy / Cut | `Mod+C` / `Mod+X` | skipped while a document text selection is live |
| Paste | `Mod+V` | |
| Duplicate | `Mod+D` | `preventDefault` — inside the workspace this is not "bookmark" |
| Delete | `Delete`, `Backspace` | |
| Save | `Mod+S` | `preventDefault`; never mounted alongside the pdf.js viewer (D5) |
| Nudge | `↑ ↓ ← →`, `Shift` ×10 | physical (D9); `preventDefault` **only** when something is selected, so arrows otherwise still scroll the pane |
| Context menu | `Shift+F10`, `ContextMenu` | opens at the *selected item's rect*, not at 0,0 |
| Shortcuts | `Mod+/` | not `?` — see D5 |
| Cancel | `Esc` | the only binding that survives focus being in a field |

Rules the resolver encodes and the spec asserts: **nothing but `Esc` resolves while an `input`, `textarea` or `contenteditable` has focus**; a bare letter/digit/symbol is never a shortcut; `altKey` disqualifies an event **unless `ctrlKey` is also set** (Windows reports AltGr as `ctrl+alt`, and on German/Nordic/Polish layouts `/` is an AltGr composition — a blanket alt-veto would make `Mod+/` unreachable on those keyboards).

### `editor-clipboard.service.ts` — `EditorClipboard`
`copy(kind, payload)` · `read<T>(kind): T | undefined` · `has(kind): boolean` · `clear()`, over one signal so menus and buttons enable off it. Reading does not consume — paste repeats.

### `nudgeRect` (added to `overlay-model.ts`)
`nudgeRect(rect, dx, dy): NormRect` — translate and clamp so a shape cannot be pushed off the page, mirroring the clamp `page-overlay.ts` `dragRect` already applies to a move.

### `shortcuts-help.ts` — `ShortcutsHelp`
A dialog rendering `EDITOR_SHORTCUTS` grouped. `zenModal role="dialog" aria-modal="true" aria-labelledby="…"` on the scrim (the directive supplies focus trap + Esc + focus restore; the roles are the call site's job, as every existing dialog does). Keys render as `<kbd aria-label="Command">⌘</kbd>` — a screen reader says "place of interest sign" for a bare ⌘. The list is a focusable labelled region (`tabindex="0" role="region"`) because `.modal` is a scroll container and Safari does not make scrollers keyboard-focusable. Opened by `Mod+/` **and** by a Shortcuts button in the workspace bar; the keyboard path focuses that button before opening, because `ZenModal` restores focus to `document.activeElement` **as it was at construction** and that is `<body>` for a bare keypress.

---

## 3. `PageOverlay` — the button guard, the menu, the nudge

**First, D-A.** `onPointerDown` and `onItemPointerDown` gain `if (event.button !== 0) return;`. Nothing else in this phase is safe until they do.

New API (additive — every existing binding keeps working):

```
menuActionsFor  = input<(itemId: string | null) => OverlayMenuAction[]>(() => [])
readonlyHandles = input(false)                   // outline the selection, no resize grips
contextTarget   = output<string | null>()        // emitted before the menu opens
menuAction      = output<{ action: string; itemId: string | null }>()
```
`OverlayMenuAction` is `{ id, label, danger?, disabled?, shortcut? }`.

Behaviour:

- `(contextmenu)` on the surface. It hit-tests **normalized geometry**, not `event.target` ancestry — a locked item is rendered `pointer-events: none`, so the event lands on the surface and ancestry would report "empty page", offering *Paste* over a redaction match. It emits `contextTarget`, asks `menuActionsFor()` for the list, and — **only if that list is non-empty** — `preventDefault()`s and opens.
- Placement: `position: absolute` inside the page box, physical `left`/`top`, **clamped to the page box** so it is never clipped by the pane's `overflow-auto` and never leaves the page. Opened from the keyboard, it anchors to the selected item's rect.
- Markup: `.menu` with `role="menu"`, `aria-label` naming the target, items `role="menuitem"` with **roving tabindex** (one `0`, the rest `-1`). Unavailable items carry `aria-disabled="true"`, **not** `disabled` — a natively disabled button drops out of the accessibility tree, so "Paste (unavailable)" would vanish instead of reading as unavailable — and are skipped by the arrow keys.
- Keyboard: `↑`/`↓` cycle, `Home`/`End` jump, `Enter`/`Space` activate, `Tab` closes, `Esc` closes and returns focus to the overlay host. **The menu's handler calls `stopPropagation()`** on all of those before the host's `onKeyDown` sees them, and **`onKeyDown` early-returns entirely while the menu is open** — otherwise `↓` would nudge the shape while walking the menu, and `Delete` would destroy the item the menu belongs to.
- The active item is highlighted from the component's own index signal (`.menu button.is-active`), **not** `:focus-visible` — the menu is opened by a pointer, and programmatic focus straight after a pointer interaction does not match `:focus-visible` in any engine, so the first item would look unfocused until an arrow press.
- Dismissal: `Esc`, `Tab`, activating an item, or a left-click anywhere on the overlay.
- **Long-press is not implemented.** Touch reaches every action through the rails (D8). A trackpad two-finger tap already arrives as `contextmenu`, so it is covered.
- Arrow keys nudge `selectedId()` through `geometryChanged` when an item is selected, no drag or pending polygon is in flight, and the menu is closed.

**Focus never scrolls (D-E).** Every `focus()` in the overlay — restoring focus when the menu closes, moving focus between menu entries, and the `focusSurface()` a rail list calls so the keyboard follows the selection onto the page — passes `{ preventScroll: true }`. The host is the whole page box, taller than its pane, so the default behaviour drags the page out from under the pointer.

**A click is not a move (D-F).** `onPointerUp` emits `geometryChanged` only when the rectangle actually changed; a selecting click is a zero-distance drag and must not become a history entry.

**Host accessibility.** The host is a bare `tabindex="0"` div with no role or name (`page-overlay.ts:59-63`) and this phase makes it the primary editing control. It gains `role="group"` + `aria-label="Page N — page editing layer"`, and an `aria-live="polite"` status node that announces selection ("Rectangle selected") and the result of a nudge ("Moved left"). Without them a focusable operable element with no name is a WCAG 4.1.2 failure and a silent nudge is a 4.1.3 failure.

**Palette hygiene, since these lines are being rewritten anyway.** The overlay's hardcoded fallbacks are Tailwind rose/slate (`#e11d48`, `#0f172a`) and the feature call sites pass Tailwind indigo (`#4f46e5` in `sign.html` and `request-builder.html`), indigo-200 (`#c7d2fe` in `edit.ts`), cyan (`#0891b2`) and blue-slate (`#111827`). Contract §9 names indigo and blue-slate grays as forbidden outright. Each is swapped for its contract-palette equivalent (`--color-accent` #B23A26, ink #332D24/#211C15, info #3D6478) in the same change. The highlighter's `#facc15` stays — it is Annotate's own working colour (`annotate.ts` `HIGHLIGHT_COLOR`) and the contract's §3 markup value.

---

## 4. Per-surface work

Each surface below gets, in its own page bar: **Undo** and **Redo** ghost buttons, disabled with the contract's dashed treatment when there is nothing to do, `aria-keyshortcuts="Control+Z Meta+Z"` / `"Control+Shift+Z Meta+Shift+Z"` — the attribute takes UI Events key values, not glyphs, and anything else is silently ignored — a `title` carrying the platform's glyph, and `data-test` `<mode>-undo` / `<mode>-redo`. **No existing `data-test` is renamed** (contract §10): Annotate keeps `annot-undo` / `annot-redo`. `aria-keyshortcuts` is declarative only (it creates no binding, VoiceOver ignores it, NVDA is partial) so the help sheet remains the real carrier.

### 4.1 Annotate — the full set
- Menu on a mark: **Copy · Cut · Duplicate · Edit text…** *(only where the mark carries page text — `free_text`)* **· Edit comment… · Delete** (danger).
- Menu on empty page: **Paste**, present only when the clipboard holds a mark.
- Rail/sidebar equivalents (D8): **Copy** and **Duplicate** join Edit/Delete on each comment row; a **Paste** button appears in the palette while the clipboard is loaded.
- Shortcuts: undo, redo, copy, cut, paste, duplicate, delete, save, nudge, context-menu, help, cancel. The hand-rolled ⌘Z listener is replaced by the shared resolver.
- Paste/duplicate mint a fresh `NM` (uuid), offset by +2 % of the page (clamped), and land on the **page being viewed**, not the page copied from. `author`, `created` and `modified` are dropped — the server stamps the real author, and carrying someone else's name onto a copy is the forgery `isOwn()` already guards against in the sidebar.
- Everything routes through `annotations.add/update/remove`, so each is one undo step and the "N unsaved" badge stays honest.

### 4.2 Edit — staged text edits get a history
- `EditFacade` gains a `HistoryStack<Map<string, BlockEdit>>` around `_edits`; `stageEdit` and `discardEdit` remember first. Buttons land in the Edit page bar, titled *"Undo the last text change (not yet saved)"* so they cannot be mistaken for the bar's version-level Undo (D2).
- `[selectedId]` becomes a real signal (it is hard-bound to `null` today) so the right-clicked item is visibly the menu's subject; `[readonlyHandles]="true"` because Edit's items are read-models of the file and cannot be moved (D10).
- Menu on a **text block**: **Edit text… · Copy text · Discard edit** *(only when one is staged)*. On an **image**: **Replace image… · Delete image** (danger). On a **link**: **Copy link · Delete link** (danger).
- `(deleteRequested)` wired. `Delete` on an image uses the existing confirm; **links gain both a selection state and a confirm**, neither of which exists today (§0).

### 4.3 Forms — the builder
- `FormsFacade` gains a history over `_ops`; buttons in the builder's page bar. Gated to the `build` tab, which is also what keeps it clear of the pdf.js listener in `fill` (D5).
- Menu on a field: **Copy · Duplicate · Properties · Delete** (danger). Duplicate and paste mint a unique name through the existing `suggestName` / `nameTaken` pair and offset the rect; a radio group's `rects` are re-laid-out by the existing `radioLayout`.
- `Delete` removes the selected field through the existing confirm. Nudge works already — `(geometryChanged)` is bound.

### 4.4 Protect — the destructive click, and a way to see what is marked
- `SecurityFacade` gains a history over `_areas` **and a `moveArea(id, rect)`** (D10); buttons in the redact page bar.
- `onSelect` **selects**; a `selectedAreaId` signal binds `[selectedId]`, and `(geometryChanged)` is bound so a marked area can be moved and nudged rather than only drawn and destroyed.
- New in the rail (D8, D-C): an **Areas** list — one row per marked area (`Page N · x,y`), the row selects, a 44×44 px ✕ removes. `protect.html`'s `data-test="area-count"` sentence becomes *"N area(s) marked. Select one to move or remove it."*
- Menu on an area: **Remove area** (danger). `Delete` does the same. Pattern matches stay `locked` — removed by unticking in the review list, as today, and they offer no menu (D7).

### 4.5 Sign — and D-B
- `EsignFacade` gains a history over `_placements` **and a `movePlacement(id, rect)`**; buttons in the sign page bar.
- `[selectedId]` bound to a new `selectedPlacementId`; `(geometryChanged)` bound. Because the tool is `rect` whenever a signature is armed, a left-click cannot select — so **the menu and the rail list are the removal paths**, and the dead `onSelect → unplace` is replaced by a real selection handler.
- New in the rail: a **Placements** list, one row per placement with a 44 px ✕. `sign.html`'s `data-test="placement-count"` sentence becomes *"N placement(s). Select one below to move or remove it."*
- Menu on a placement: **Remove signature** (danger). `Delete` the same.

### 4.6 Sign request builder — the same trap, outside the workspace
`request-builder.ts` shares the overlay and the destructive-click pattern; leaving it while fixing its twin would be indefensible. It gets: the `event.button` guard (free, from §3), `[selectedId]`, a context menu (**Remove field**), `Delete`, a **history over the `fields` signal** with visible Undo/Redo in the step-2 bar, and a per-page field list with a 44 px remove per row. Nudge is included — the fields are a local signal, so a move is a one-line update.

### 4.7 Compare — explicitly out of scope
Read-only. `onOverlaySelect` navigates to a diff row; there is nothing to undo, copy or delete. It gets the `event.button` guard and nothing else. Recorded here so the acceptance criteria are not read as covering it.

### 4.8 Workspace bar — Redo, and D-D
- The cursor of D11 replaces `currentSeq() - 1`, fixing repeated Undo.
- **Redo** (`redo-version`) beside Undo, titled *"Redo — forward to vN"*.
- A **Shortcuts** button opening the help sheet; `Mod+/` focuses it and opens it.

---

## 5. Design contract amendments (gap rule — this change, not later)

`docs/design/design-instructions.md`:

1. **§3 — new `Context menu (.menu)` component spec.** The full pattern: raised surface / hairline / `shadow-3` / `--radius-2`; **item min-height 44 px** (a popover is not a dense desktop toolbar, so §6's 36 px exemption does not apply — today's `.menu button` is 8 px padding on a 14/1.4 line ≈ 35.6 px; `.menu` is shared, so **the dashboard's ⋯ menu grows with it**, which is a correction rather than a side effect); `position: absolute` required at the call site (`.menu`'s `z-index: 20` is inert without it); `aria-disabled` + the D5 dashed disabled treatment for unavailable items; a `.menu-key` shortcut column in `--color-ink-faint`; `.menu-sep` hairline; `:focus-visible { outline-offset: -2px }` so the ring draws inside the 4 px padding instead of over the menu's own border; `.is-active` for pointer-opened menus. Roles, roving tabindex and the keyboard contract stated as normatively as §3 already states `.seg`'s.
2. **§3 Headers → Workspace bar** — add **Redo** and **Shortcuts** next to Undo.
3. **§3 Modals** — the shortcuts sheet's width against the fixed 28 rem / 32 rem rule, and its scroll region.
4. **§3 Workspace panes** — the rule D8 rests on, written down: *an action offered only on right-click must also be reachable from a rail.*
5. **§4 Workspace** — every editing mode carries Undo/Redo in its own page bar; arrow keys nudge the selection; Edit's items are not movable.
6. **§6 Accessibility** — the menu's roles/focus-move/focus-return; the overlay host's `role`/`aria-label`/live region; `aria-keyshortcuts` written as UI Events key values; **the no-single-character-shortcut rule (SC 2.1.4)**; the 36 px-vs-44 px question for `btn-sm` in bars that wrap on a phone.
7. **§8 RTL** — the D9 exception: pointer offsets and arrow-key nudge over the page raster are **physical**, and menu placement is physical for the same reason; logical properties remain the rule for layout CSS.

---

## 6. Tests

**Everything new is covered by unit tests** (`ng test` — Vitest 4 + jsdom). Baseline to beat: **258 passing across 38 files.**

| File | What it proves |
|---|---|
| `shared/history.spec.ts` *(new)* | push/undo/redo ordering; a new `remember` drops the future; the cap evicts the oldest, never the newest; `canUndo`/`canRedo` track the arrays; `clear()` empties both |
| `shared/shortcuts.spec.ts` *(new)* | every binding resolves; ⌘ ≡ Ctrl; `Ctrl+Y` is redo but `⌘Y` is not ours; nothing but `Esc` resolves while a text field has focus; `alt` alone vetoes but `ctrl+alt` (AltGr) does not; ⌘C is skipped with a live text selection; **every `ShortcutId` has exactly one `EDITOR_SHORTCUTS` entry and vice versa**; no binding is a bare printable character (the SC 2.1.4 guard, as a test) |
| `shared/editor-clipboard.service.spec.ts` *(new)* | round-trips a payload; refuses a mismatched kind; `read` does not consume; `has`/`clear` |
| `shared/shortcuts-help.spec.ts` *(new)* | renders every row; each key glyph carries an `aria-label`; the dialog has `role`/`aria-modal`/`aria-labelledby`; `Esc` closes |
| `shared/page-overlay/overlay-model.spec.ts` *(extended)* | `nudgeRect` translates, and clamps at all four edges |
| `shared/page-overlay/page-overlay.spec.ts` *(extended)* | **a right-click emits neither `selectionChanged` nor a drag** (the D-A regression); right-click emits `contextTarget` then opens; **no menu when `menuActions` is empty**; a locked item resolves to its own id with no actions; arrow keys emit `geometryChanged` with the right delta, `Shift` ×10, `ArrowLeft` always `-dx`; a nudge at the page edge clamps; arrows do **not** `preventDefault` with nothing selected; **while the menu is open the host handles no keys at all**; `Esc` closes the menu before it clears the selection; arrow navigation skips `aria-disabled` items; roving tabindex; `menuAction` carries the item id; the live region announces selection and nudge |
| `shared/page-overlay/page-overlay.spec.ts` *(the two the browser earned)* | the action list is resolved **inside the event**, from the resolver, with the id of the item under the pointer (D6/the race); and a zero-distance drag reports no geometry change while a real one still does (D-F) |
| `features/workspace/annotate.spec.ts` *(new harness)* | copy→paste mints a new id, offsets, lands on the current page; paste drops a foreign author; cut removes and fills the clipboard; duplicate is one undo step; nudge re-derives quads/ink/vertices, not just `rect`; the action list changes with the type (`Edit text…` only for `free_text`); ⌘S saves; every mutation is undoable |
| `features/workspace/edit.spec.ts` *(new harness)* | staged-edit history undo/redo; block / image / link action lists; `Delete` on an image confirms; `Delete` on a link confirms (new); `readonlyHandles` is on |
| `features/workspace/forms.spec.ts` *(extended → component harness)* | duplicate mints a unique name; radio `rects` re-laid-out; op history undo/redo; the handler is inert on the `fill` tab |
| `features/workspace/protect.spec.ts` *(extended → component harness)* | **a click selects rather than removing** (the D-C regression); the areas list removes; `Delete` removes; undo restores; a locked match offers no menu; `moveArea` moves |
| `features/workspace/sign.spec.ts` *(new harness)* | a placement can be selected and removed — **today neither is possible** (the D-B regression); undo restores; `movePlacement` moves |
| `features/sign/request-builder.spec.ts` *(new harness)* | a click no longer deletes a field; the menu and the list remove; undo restores |
| `features/workspace/workspace-undo.spec.ts` *(new)* | **two Undos in a row go back two versions, not there-and-back** (the D-D regression); `canRedoVersion` only at the expected seq; **Undo and Redo never resolve to the same seq**; any other operation ends the chain |

`protect.spec.ts` and `forms.spec.ts` currently test one pure function each (`strengthOf`; `radioLayout`/`specOf`) — "extended" means **a new TestBed harness**, with the providers `workspace-error.spec.ts` already models (`provideHttpClient` + `provideHttpClientTesting`, the facade, `ConfirmService`, `ToastService`).

**E2E** (`e2e/tests/phase-12.spec.ts`, added to the suite; **not run this session** — it needs the full local stack): draw a rectangle → ⌘C ⌘V → two marks → right-click the copy → Delete → one mark → ⌘Z → two again → arrow-nudge moves it → Save. Plus: in Protect, click an area and assert it is *still there* and selected.

**Deliberately not unit-tested:** the OS's mapping of a trackpad two-finger tap to a `contextmenu` event (jsdom dispatches the event, so the handler is covered; the gesture is the OS's), and the menu's pixel placement near a page edge — checked in a real browser instead (§7).

---

## 7. Acceptance criteria

- [ ] A right-click on the page no longer acts as a left-click (D-A): it does not select, deselect, drag, or delete anything.
- [ ] Right-click (or two-finger tap) on a mark, text block, image, link, form field, redaction area, signature placement or request field opens a menu whose every action works; where a surface offers nothing, the browser's own menu is left alone.
- [ ] The menu is fully keyboard-operable — **openable** with `Shift+F10`, navigable with `↑`/`↓`/`Home`/`End`, activated with `Enter`, dismissed with `Esc` — returns focus where it came from, and never lets a key through to the overlay beneath it.
- [ ] Every menu action is also reachable without a right-click, from a rail or a button (D8).
- [ ] ⌘Z / ⇧⌘Z undo and redo in **all six** editing surfaces, and every locally-staged mutation is a single undo step. Edit's mode-level Undo covers staged text edits and says so; its version-appending operations remain the bar's Undo.
- [ ] Copy, cut, paste and duplicate work on the selected item in Annotate and the Forms builder; a paste never collides with an existing field name; ⌘C with text selected still copies the text.
- [ ] `Delete`/`Backspace` removes the selected item in every editing surface; arrow keys nudge it, cannot push it off the page, and still scroll the pane when nothing is selected.
- [ ] **Undo and Redo are visible controls** in Annotate, Edit, Forms, Protect, Sign and the request builder; the workspace bar carries both, **two Undos in a row go back two versions** (D-D), and Undo and Redo are never the same operation.
- [ ] A redaction area, a signature placement and a request field can each be selected, moved and removed — and a click no longer destroys any of them (D-B, D-C). The copy that told people to click-to-remove is gone from **both** `protect.html` and `sign.html`.
- [ ] `Mod+/` opens a shortcuts sheet listing exactly the implemented shortcuts, and no shortcut in the app is a bare printable character (SC 2.1.4).
- [ ] Every new behaviour has unit tests; the suite is green and larger than 258; `ng lint` clean; `ng build` + 29 prerendered routes + `verify:prerender` green; **zero `data-test` attributes removed**.
- [ ] The contract amendments in §5 are in `design-instructions.md` in the same change.
- [ ] Verified in a real browser in **both themes** at desktop and phone widths (the DoD for UI work in `AGENTS.md`: "build + lint + unit tests pass, and the affected screens were checked in both themes at desktop and mobile widths").

## 8. Risks

- **Taking a key someone needed.** Mitigated by the no-bare-character rule (D5), by the "nothing but `Esc` while typing" rule, by leaving ⌘Y and ⌘+/⌘− alone, by skipping ⌘C/⌘X with a live text selection, and by the fact that our handlers are never mounted beside the pdf.js viewer that owns ⌘S / `+` / `-` / `PageUp`.
- **The `AnnotationsFacade` lift onto `HistoryStack`** touches proven code — done as a pure refactor with the existing spec left unchanged as the regression test.
- **Changing behaviour people learned (D-B/D-C).** Mitigated by the replacement being strictly more capable, by Undo now existing there, by a visible list replacing an invisible gesture, and by the copy changing in the same commit.
- **Menu placement near a page edge** is the classic popover bug — clamped to the page box, and checked in a real browser at both widths.
- **Scope.** Six surfaces × (history + menu + keyboard + list) is the bulk of the work. The generic primitives in §2 are what keep it from being six implementations; if the phase has to be split, §§3–4.1 and 4.8 are the coherent first half (the overlay, Annotate, and the bar), and 4.2–4.6 the second.

---

**Executed** (see PROGRESS.md §Phase 12). Known drifts between this work order and what shipped are recorded in PROGRESS's
Decisions log; this file is the plan, not the record. The acceptance boxes above are unticked by design — PROGRESS holds the ticks, with the evidence beside each.
