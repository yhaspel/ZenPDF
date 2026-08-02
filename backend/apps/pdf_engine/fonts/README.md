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
