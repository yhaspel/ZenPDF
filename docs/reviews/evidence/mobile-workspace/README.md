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

**Contrast, both themes**, computed from the rendered colours: the mode row's 11 px label
**6.71:1** light / **8.32:1** dark on the bar; the selected mode's ink stamp **14.99 / 16.68**;
a drawer opener **6.71 / 8.32**; a sheet title **15.95 / 15.74**. The grip is
`--color-border-strong` on the sheet, which is a hairline value and reads as one — it is
`aria-hidden` decoration beside a title and a close button, not a control.

**No layout thrash on open.** A performance trace over **four open/close cycles** records
**CLS 0.00**: the sheet is `position: fixed` and moves by `transform`, so nothing under it
is measured or moved.

**Console.** Clean apart from `ngx-extended-pdf-viewer`'s own `[fluent] Missing
translations` warnings, which are vendor and pre-existing.

**One finding that is not ours.** Under `dir="rtl"` the *document* becomes horizontally
scrollable by about 10 000 px. The cause is a live region `ngx-extended-pdf-viewer` appends
to `<body>` with an inline `left: -10000px` — a physical inset, which in RTL extends the
scrollable area to the inline start. Confirmed by locating the string in
`node_modules/ngx-extended-pdf-viewer/fesm2022/ngx-extended-pdf-viewer.mjs`, and it appears
only once the viewer has initialised. The workspace's own layout mirrors correctly and adds
no overflow of its own. Recorded in the Human review queue.

## Lighthouse (mobile preset)

| route | `main` | this branch |
|---|---|---|
| `/app/doc/<id>` — View, pdf.js on screen | **87** | **86** |
| `/app/doc/<id>?mode=annotate` — this layout's own markup | — | **100** |

The three failing audits are identical on both sides and every node in them belongs to
`ngx-extended-pdf-viewer`: `aria-required-attr` on six `pdf-shy-button`s missing
`aria-checked`, and `tabindex > 0` plus `target-size` on `#primaryZoomOut` /
`#primaryZoomIn` — the same defects `phase-10-a11y.spec.ts` excludes as vendor.

The 87 → 86 is an **accounting artefact**. The only audit whose state differs between the
two runs is `image-alt` (weight 10), which goes from *applicable and passing* on `main` to
`notApplicable` here, because the thumbnails now sit inside a closed sheet: the same
numerator over a smaller denominator. A **snapshot** audit taken with the Pages drawer open
has `image-alt` applicable and passing again, which is the proof rather than the story.

## Production, after the merge

`https://zenpdf.up.railway.app`, same instrument, 390 × 844 with emulation off, once the
`web` service had the new bundle (`styles-*.css` containing `.ws-bottom-bar`).

| File | What it shows |
|---|---|
| `12-production-pages-drawer-390.png` | dark, View, the **Pages** sheet open over the page |
| `13-production-annotate-light-390.png` | light, Annotate, the page at fit-to-width with the bar as the last row |

Measured there, as a guest, from `/annotate-pdf` → upload → workspace: the nine modes all
report `scrollWidth === visualViewport.width === 390`, the bar's bottom edge at **844** and
the document exactly **844** tall; the drawer openers read Pages / Edit tools / Tools +
Comments / Fields / Convert & OCR / Compare with / Signature / Protection as they should;
`viewer-drew` is present; opening a sheet traps focus on its Close, locks the body and
hands focus back to the opener on close; the **More** sheet carries all six rows and there
is still exactly **one** `[data-test=download]` in the document; and the theme toggle
cycles Light → Dark → System on the shrunken bar. Console: clean apart from the same
vendor `[fluent]` warnings.

**One thing production made visible that the local run had not been asked.** Inside the
page pane the scroller is 15 px narrower than its content (`scrollWidth` 390,
`clientWidth` 375) whenever the browser draws a classic vertical scrollbar: the annotate
zoom seed is `min(900, innerWidth − 48)` and `innerWidth` counts a scrollbar the *pane*
does not have. The document never scrolls sideways and a phone with overlay scrollbars fits
exactly; it is a desktop-browser artefact of a pre-existing line. Recorded in the Human
review queue.
