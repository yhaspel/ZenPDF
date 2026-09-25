# Vendored signature fonts

Four cursive faces used to render a **typed** signature to PNG
(`engine/signatures.py::render_typed`).

They are vendored rather than loaded from Google Fonts at runtime for a
specific reason: a signing ceremony that fetches a font from a third party
tells that third party who is signing what, and when. Nothing on `/s/:token`
makes an outbound request.

| File | Family | Licence |
|---|---|---|
| `Caveat-Regular.ttf` | Caveat | SIL Open Font License 1.1 |
| `DancingScript-Regular.ttf` | Dancing Script | SIL Open Font License 1.1 |
| `GreatVibes-Regular.ttf` | Great Vibes | SIL Open Font License 1.1 |
| `Sacramento-Regular.ttf` | Sacramento | SIL Open Font License 1.1 |

All four are OFL-1.1, which permits bundling and redistribution provided the
licence travels with them; the upstream `OFL.txt` for each is at
<https://github.com/google/fonts> under `ofl/<family>/`. Caveat and Dancing
Script are variable fonts (`wght` axis); the default instance is what renders.

## Page text — Arimo

| File | Family | Licence |
|---|---|---|
| `Arimo-Regular.ttf` | Arimo | SIL Open Font License 1.1 (`Arimo-OFL.txt`) |

The **one** face Annotate's text boxes are set in, on screen and in the file
(design contract §3 "Text on the page"; `engine/annotations.py`
`_prepare_text_aps`). Metric-compatible with Helvetica/Liberation Sans, and it
covers Hebrew. Fetched 2026-09-25 from
`https://fonts.gstatic.com/s/arimo/v36/P5sfzZCDf9_T_3cV7NCUECyoxNk37cxsBw.ttf`
(v1.341, upm 2048, hhea/typo ascent 1854, descent 434, `USE_TYPO_METRICS` on),
sha256 `e5717ff6c2063b0e596176ddad929b0a98a6d8db694f43a8ba26c99675625b67`.

**The frontend serves the same bytes** — `frontend/public/fonts/Arimo-Regular.ttf`
is this file, and `Arimo-Regular.woff2` is a lossless woff2 of it (fontTools).
`infra/test.sh` fails the gate if the two `.ttf` copies drift (a pytest could
not: the api container mounts `backend/` only); the
metrics above are pinned in `styles.scss` with ascent-/descent-override and in
`frontend/src/app/core/text-layout.ts`, whose advance-width table is generated
from this file. Replacing the font means regenerating that table.

The engine subsets fonts on save, so a saved document carries only the glyphs
its text boxes use (a few KB), not the whole ~310 KB face. Like Edit mode's
save, it is `Document.subset_fonts()` — every embedded font in the document,
not only this one; appearance streams keep the glyphs they draw.
