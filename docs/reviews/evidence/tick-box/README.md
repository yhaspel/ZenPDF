# Evidence — the Tick box tool (2026-08-28)

Branch `feat/annotate-tick-box`, row 11 of the handoff programme
(`docs/reviews/handoffs/TRACKING.md`). The narrative is in
`development-plans/PROGRESS.md`, session log **"2026-08-28 — The Tick box tool"**; this
folder is the raw material behind it. Everything here was taken against the local stack
at `http://localhost:4200`, **as a guest** (the tool page hands over into the workspace —
§21.6), on a scratch document that auto-deletes.

**The instrument, and why it is Playwright rather than the Chrome DevTools MCP.** Placing
a mark is a *click at a page coordinate*, and the overlay takes it through `pointerdown`
with `setPointerCapture` — which refuses a synthetic event, so a dispatched `PointerEvent`
places nothing. The MCP's `click` targets an element's centre and can therefore place
exactly one mark, in one place. Playwright drives the same Chromium through CDP's Input
domain, which produces trusted events at arbitrary coordinates: it is the only instrument
here that can put ✓ ✓ − ✗ at four different points and then read the file back. It is also
what `docs/reviews/evidence/mobile-workspace/README.md` already names as the equivalent of
the 390 px viewport override, for the same reason: Chrome on macOS will not make a window
narrower than about 500 px, and device emulation (`isMobile: true`) is the instrument that
hid the 2026-08-21 overflow for a day. `isMobile` is left at chromium's default `false`.

The script is not committed — it is a one-shot harness, and the behaviour it drives is
covered for good by `e2e/tests/phase-3.spec.ts` ("phase 3: tick box places the chosen mark
with one click") and `frontend/src/app/features/workspace/annotate-tick.spec.ts` (9 tests).

## The desk — 1280 px, both themes

| File | What it shows |
|---|---|
| `01-armed-light-1280.png`, `01-armed-dark-1280.png` | Tick box armed: the palette entry pressed (§3 tool-palette-button), the rail hint under the grid, and the mark selector in the page bar with **✓ Check preselected**. Nothing placed yet. |
| `02-bar-light-1280.png`, `02-bar-dark-1280.png` | The page bar alone, so the `.seg` treatment is legible in both modes: the active mark is `--color-ink-strong` on `--color-bg` — the ink stamp §3 tabs specifies, dark-on-light in light mode and light-on-dark in dark. |
| `03-marks-light-1280.png`, `03-marks-dark-1280.png` | ✓ ✓ − ✗ placed with four clicks, the tool still armed, **four comment rows reading "ink"**, "4 unsaved". The marks are page content, so they are ink-on-paper in both themes — the dark theme is the app around them, not the document. |
| `04-reloaded-light-1280.png` | After **Save** and a full **reload**: `(4)`. The marks came out of the file, not out of the session. |
| `05-view-mode-light-1280.png` | **View mode — pdf.js**, an independent renderer, drawing the four marks from the real PDF at `v2`. This is the check that matters most: the overlay and the file agree. |
| `06-flattened-light-1280.png` | After **Flatten**: the comments rail is empty and the count is `(0)` — the marks stopped being annotations. |
| `07-flattened-view-light-1280.png` | The same document at `v3` in View mode: the four marks are still there, now as page artwork. Ink bakes. |
| `11-bar-light-1600.png` | The bar at a 1600 px window (1136 px pane): one row. See the measurement below. |

## The phone — 390 × 844, both themes

| File | What it shows |
|---|---|
| `08-drawer-light-390.png`, `08-drawer-dark-390.png` | The **Tools drawer** (§3 Phone workspace — the palette is a sheet here, not a row): "Tick box" is the eighteenth entry, armed. |
| `09-bar-light-390.png`, `09-bar-dark-390.png` | The sheet closed: the selector is in the **wrapped page bar**, Undo/Redo are in the **bottom bar** (the `.ws-hoisted` pair the bar draws instead), Save is the bottom bar's primary. The selector is deliberately outside `.ws-hoisted`, which is why it is still here. |
| `10-marked-light-390.png`, `10-marked-dark-390.png` | One click on the page at 390: "1 unsaved". It places on a phone too. |

Measured at both themes, 390 px: `documentElement.scrollWidth` **390** against
`visualViewport.width` **390** — no sideways scroll, which is the assertion
`phase-10-mobile.spec.ts` exists to make. The selector measures **229 × 36 px**: 36 px is
§6's dense-toolbar exemption, which §3 Tick box names.

## The one thing the browser corrected

§3 "Tick box" was written saying the bar wraps "below `md`". It wrapped on the desk too,
and the section now says what was measured instead:

| Window | Annotate pane | Bar unarmed | Bar armed | |
|---|---|---|---|---|
| 1280 px | 816 px | 53 px | **97 px** | wraps — badge, Save and Flatten take a second row |
| 1440 px | 976 px | 53 px | 53 px | one row |
| 1600 px | 1136 px | 53 px | 53 px | one row |

The wrap is the bar working — `flex-wrap` is how it is built, nothing is clipped or
hidden, and the 44 px costs only while the tool is armed. It is recorded rather than
designed around because the alternative (a narrower, glyph-only selector) would make
*which mark am I about to place* harder to read at the moment of placing it. The contract
carries the numbers now, in §3 Tick box and in the §11 row.

## Console

`console.txt` — every console message and page error from all four passes, 34 lines,
**zero errors**. What is there is pre-existing and already documented in
`../workspace-debt/README.md`: pdf.js's `[fluent] Missing translations` for the sidebar
buttons the workspace hides by configuration, and one headless-only
`No available adapters.` (WebGPU, absent in the headless runner).
