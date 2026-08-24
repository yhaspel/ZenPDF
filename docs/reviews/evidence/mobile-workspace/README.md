# Evidence — the phone workspace (2026-08-24)

Branch `feat/mobile-workspace`, prompt 6 of the handoff programme. Everything here was
taken against the local stack with the Chrome DevTools MCP tools.

**The instrument, and why it is not device emulation.** Chrome on macOS refuses to make a
window narrower than about 500 px, so `resize_page` cannot reach 390. The alternative is a
viewport override with `isMobile: false` — the same thing Playwright does — which gives a
real 390 px layout viewport where overflow is measurable. What is *not* used is device
emulation (`isMobile: true`): that gives the page a virtual layout viewport which widens to
fit the content and then scales the app down, and it is exactly the instrument that hid the
2026-08-21 overflow for a day.

## Before — the rescue layout this replaces

| File | What it shows |
|---|---|
| `base-annotate-light-390.png` | 390 px, Annotate, **on `main`**: the tool palette owns the top third, the page bar wraps to two rows, and the document starts about 600 px down an 844 px screen |
| `base-view-light-390.png` | 390 px, View, on `main` |
| `base-annotate-light-1280.png`, `base-annotate-dark-1280.png`, `base-annotate-light-768.png`, `base-annotate-dark-768.png`, `base-view-light-1280.png` | the desktop, on `main` |

## After

| File | What it shows |
|---|---|
| `01-view-light-390.png` | the page is the first thing on screen and fits the width; the bottom bar is the last row |
| `02-pages-drawer-light-390.png` | the View rail as the **Pages** sheet — grip, title, 44 px close, scrim over the page |
| `03-annotate-tools-drawer-light-390.png` | the seventeen-tool palette as a sheet, which is why it is not a compact bottom row |
| `04-annotate-comments-drawer-light-390.png` | the **Comments** sheet, with the D8 per-item actions at 44 px |
| `05-annotate-comments-drawer-dark-390.png` | the same in dark |
| `06-view-dark-390.png` | View, dark |
| `07-more-sheet-dark-390.png` | the workspace bar's cluster in the **More** sheet: Undo, Redo, Split, Compress, Download, Shortcuts |
| `08-protect-drawer-dark-414.png`, `09-protect-drawer-light-414.png` | 414 px, both themes: the Protection panel as a sheet with its primary docked in the bar |
| `10-reduced-motion-drawer-light-414.png` | with the global `prefers-reduced-motion` collapse injected: the sheet is fully placed one frame after the class flips |
| `11-rtl-comments-drawer-light-414.png` | `dir="rtl"`: close at the inline start, opener and title mirrored |
| `after-annotate-light-1280.png` | the desk, unchanged |

## Measurements

**Nine modes at 390 and at 414, both themes** — `document.documentElement.scrollWidth ===
visualViewport.width` and the bottom bar's own bottom edge equal to `innerHeight`, with the
document exactly one viewport tall. Both numbers matter: the first alone stayed green while
Edit, Sign and Protect grew the document to **1348 px against 844** and pushed the bar off
the bottom, because a vertical scrollbar narrows both sides of that equality equally.

**Desktop unchanged, measured rather than eyeballed.** `desktop-768-before.json` /
`desktop-1280-before.json` are geometry fingerprints taken with `main`'s `frontend/src`
checked out over the branch (`git checkout main -- frontend/src`, dev server rebuilt);
`-after.json` are the same script on the branch. Each records, for **all nine modes**, the
bounding boxes of the workspace bar, both rails, the page pane, the pane's toolbar,
Download and Shortcuts, plus the document's scroll size — **0 differences at 768 px and 0
at 1280 px**. The `sanity` key in each `before` file records that neither the bottom bar
nor `⋯` existed there, which is what makes the comparison meaningful.

**Touch targets.** Every control the phone layout adds, and everything inside a sheet,
measured ≥ 44 px. What that found before the fix: the drawer openers and `⋯` at 36, the
comment row's Copy / Duplicate / Delete at **16**, Edit's mode toggles at 30, the panels'
tab rows at 36, checkbox rows at 21. Still under the floor by decision, and listed in the
contract: native checkbox and file inputs, and three number/select fields carrying
`!min-h-9`.

**Keyboard only.** Focus the opener → Enter → focus lands on the sheet's Close without a
Tab → Tab stays inside the sheet → Escape closes it and focus is back on the opener, with
the body scroll lock released.

**Console.** Clean apart from `ngx-extended-pdf-viewer`'s own `[fluent] Missing
translations` warnings, which are vendor and pre-existing.

**One finding that is not ours.** Under `dir="rtl"` the *document* becomes horizontally
scrollable by about 10 000 px. The cause is a live region `ngx-extended-pdf-viewer` appends
to `<body>` with an inline `left: -10000px` — a physical inset, which in RTL extends the
scrollable area to the inline start. Confirmed by locating the string in
`node_modules/ngx-extended-pdf-viewer/fesm2022/ngx-extended-pdf-viewer.mjs`, and it appears
only once the viewer has initialised. The workspace's own layout mirrors correctly and adds
no overflow of its own. Recorded in the Human review queue.
