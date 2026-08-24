# Evidence — the phone follow-ups (2026-08-24)

Branch `fix/phone-follow-ups`: the six items flagged when the phone workspace merged
(PR #31). Everything here was taken against the local stack with the Chrome DevTools MCP
tools, signed in, with two real documents uploaded through the API.

**The instrument, and why it is not device emulation.** Same as
`../mobile-workspace/README.md`: a viewport override with `isMobile: false`, because
Chrome on macOS will not make a window narrower than ~500 px, and because device
emulation (`isMobile: true`) gives the page a virtual layout viewport that widens to fit
the content and then scales the app down — the instrument that hid the 2026-08-21
overflow for a day. Every number below is `documentElement.scrollWidth`,
`visualViewport.width`, or a `getBoundingClientRect()` on the element named.

## The dashboard and the app shell (item 2)

| File | What it shows |
|---|---|
| `01-dashboard-before-light-390.png` | **on `main`**: the desktop sidebar keeping its 224 px column beside a two-column grid at 390 px, and the header nav running off the side |
| `02-dashboard-after-light-390.png` | the same screen, empty library: header on two lines, sidebar a wrapping band |
| `03-dashboard-card-light-390.png` | one real document — the card, its ⋯, star and select checkbox |
| `04-dashboard-card-dark-390.png` | the same in dark |
| `05-dashboard-band-light-768.png` | 768 px — below `xl`, so still one column with the sidebar as a band. This is a width the change deliberately alters |
| `06-dashboard-desk-light-1280.png` | 1280 px — the three-column desk, unchanged |
| `15-settings-header-wrap-light-390.png`, `16-settings-header-wrap-dark-390.png` | `/app/settings`, both themes: the same header wrap on the route that has no dashboard in it |

**Measured.** `/app/dashboard` and `/app/settings` both drew a **546 px** document at a
390 px viewport before; both are **375** now (375, not 390, because a desktop Chrome
window reserves a classic scrollbar — the same reason `phase-10-mobile.spec.ts` compares
against `visualViewport` rather than pinning 390).

| | before | after |
|---|---|---|
| document width, `/app/dashboard` and `/app/settings` | 546 | **375** |
| header height at 390 | one line, overflowing | **106** (two lines) |
| main column | 110 | 343 |
| a file card | **47** | **164** |
| ⋯ / star | 28 × 28 / 15 × 15 | **44 × 44** each |
| select checkbox | 17 × 17, with a 17 × 17 target | 17 × 17, in a **44 × 44** label |

The nav's second line starts at y = 46 under the brand at y = 14; the address ellipsises
(`scrollWidth > clientWidth`) and carries its full value in `title`. At 1280 the header
is back to 58 px on one line and the sidebar to its 224 px column.

**The checkbox is the one place the floor is a target and not a size**, and `03`/`04` are
the second version of that. Sizing the input itself to 44 px was implemented, seen in the
browser and reverted: a native checkbox stretched to 44 px paints a 44 px empty square
over the thumbnail. It sits in a 44 px `<label>` now, anchored at the card corner below
`md` so the box centres at **(15, 15)** against the **(12, 12)** it has always had — and
on the desk at 1280 it is measured back at exactly **(293, 413)**, unmoved, because the
first fix had shifted it 6 px there.

The ⋯ menu no longer sits on the button that opens the document. That was never a
separate defect, just arithmetic downstream of 47 px: `elementFromPoint` at the centre of
`[data-test=open-doc]` now returns the thumbnail `<img>` inside it, where every click was
previously refused with *"doc-menu subtree intercepts pointer events"*.

## The page fits the pane it is drawn in (item 4)

| File | What it shows |
|---|---|
| `07-edit-fits-light-390.png`, `08-edit-fits-dark-390.png` | Edit at 390, both themes — the page at 342 in a 390 px pane |
| `10-compare-stacked-light-390.png` | Compare at 390: the two documents **stacked**, 343 each |
| `11-compare-desk-light-1280.png` | Compare at 1280: 420 × 2 side by side, unchanged |
| `12-annotate-fits-light-1280.png` | the one deliberate desk change — Annotate at **753 in an 801 px pane** |
| `17-annotate-fits-dark-414.png` | 414, dark |

**All nine modes swept at 390 and at 414, both themes.** Nothing in `.ws-pane-main` is
wider than its own box in any of them, the document equals the visual viewport
throughout, and the bottom bar's bottom edge is exactly the viewport height.

| mode | drew at, before | at 390 | at 414 |
|---|---|---|---|
| Edit, Forms | 750 | 342 | 366 |
| Protect, Sign | 680 | 342 | 366 |
| Annotate | 342 | 342 | 366 |
| Compare | 420 × 2 + 16 gap = **856** | 343, stacked | — |

*(Compare is measured at 390 only: the 414 sweep ran on a document with no comparison
selected, so there were no two pages to measure. The clamp is the same call with
`columns: 1`, and `page-fit.spec.ts` locks its arithmetic.)*

The pane is 390 wide at a 390 viewport and 414 at 414 — no rail stands beside it — and
`Compare` on the desk still draws 420 × 2 at the same y in a 992 px pane.

**Annotate on the desk is the one thing that moved:** 900 → **753**, because 900 never
fitted the 801 px pane the two rails leave it. Its `scrollWidth` now equals its
`clientWidth`.

## The viewer (item 5)

| File | What it shows |
|---|---|
| `09-forms-viewer-dark-390.png` | Forms' fill tab in dark — the second viewer nobody had ever looked at |
| `lighthouse-a11y-after.json` | the audit extract |

Forms' fill tab rendered a second `<ngx-extended-pdf-viewer>` with **no `show*` inputs and
no `[theme]`**: pdf.js's download, print, open-file, rotate and editor buttons on screen
inside Forms, drawn from the light palette in dark mode. All five are `present: true,
shown: false` now and the toolbar is `rgb(56, 56, 61)` — pdf.js's own dark chrome —
against our `rgb(23, 19, 16)`.

**Measured live on `/app/doc/:id`:** elements with a positive `tabindex` **152 → 0**, and
visible `pdf-shy-button[role=radio]` hosts **6 → 0**.

**Lighthouse accessibility, mobile preset, navigation mode: 86 → 96.** One audit still
fails and it is refused rather than patched — `target-size` on
`#primaryZoomOut`, pdf.js's own 24 px zoom button. Padding the vendor margin would buy the
tick and leave a 24 px control, 20 px short of §6's floor; the honest fix is upstream and
§5 records it.

Console on the workspace: **no errors**. The only warnings are pdf.js's own
`[fluent] Missing translations` for the sidebar buttons we do not render.

## RTL (item 1)

`13-rtl-annotate-light-414.png` — `document.documentElement.dir = 'rtl'` at 414 px.

| | before | after |
|---|---|---|
| `documentElement.scrollWidth` | **10 400** | **414** |
| `scrollingElement.scrollLeft = -5000` | sticks | returns **0** |

And the region is still doing its job: `display: block`, `visibility: visible`,
`aria-live="polite"`, not inside any `aria-hidden`. The vendor's inline `left: -10000px`
is still on the element — it is `position: fixed` that takes it out of the document's
scrollable overflow, and `inset-inline-start: 0` that wins the logical axis.

## The compact field (item 3)

`14-convert-compact-fields-light-390.png` — Convert's DPI and image-format fields inside
the panel-as-sheet.

| | desk (1280) | sheet (390) |
|---|---|---|
| `export-dpi` | **36** | **44** |
| `export-image-format` | **36** | **44** |

Which is the whole point of `.input-compact`: the desk keeps the dense size the fourteen
`!min-h-9` were protecting, and a sheet gets §6's floor. The `!w-20` / `!w-auto` width
importants stay — folding those into the class would re-break them for exactly the reason
the height one broke.

Nothing else in the open sheet is under 44 px except the four native OCR checkboxes,
whose boxes are 17 px and belong to the platform. Their `<label>` rows measure **44**,
which is what §3 requires.

## What is not here

The desktop-unchanged proof for the *workspace bar and rails* is
`../mobile-workspace/desktop-{768,1280}-{before,after}.json` — this branch does not touch
that geometry, and the two desk shots above (`06`, `11`, `12`) are the surfaces it does.
