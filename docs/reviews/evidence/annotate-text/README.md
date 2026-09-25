# Evidence — Annotate text boxes: one layout, drawn twice (2026-09-25)

Owner report: *"Annotate feature is very fragile. Text cut off constantly and shifts when
PDF is downloaded so text is not exactly aligned."* Spec: `docs/archived/2026-09-25-annotate-text-PROMPT.md`
(RCA, decisions, acceptance gate). Handoff: `docs/reviews/handoffs/handoff-to-cli-annotate-text-wysiwyg.md`.

Produced by the Cowork sandbox against a **local stack running this branch on both sides**
(Django `runserver` with eager Celery and filesystem storage; the built frontend served
with `/api` proxied to it; Playwright on Chromium 1194). Not production.

| File | What it is |
|---|---|
| `screen-vs-file.png` | The pixel gate's own measurement, drawn: for four of the eight runs, each box's **screen** ink (overlay screenshot minus the same screenshot with the drawn text hidden) in red over the **file**'s ink (the engine's raster of the saved version minus the same raster without annotations) in blue. Dark = both. Five boxes: 9 pt line, name, two-line address, Hebrew with digits and a comma, a line that reaches the page's right edge and wraps. |
| `measurements.json` | Every box in every run (2 themes × dpr 0.75 / 1 / 1.5 + 390 px phone = 8 runs × 5 boxes): screen and file ink bboxes (and ink centres, recorded not asserted) in device px, their deltas, and the shape shift (cross-correlation peak, `dx`/`dy`, with its score). |
| `desktop-1x-light-overlay.png` / `desktop-1x-light-file.png` | The raw pair behind one run: the editor's page as shown, and the saved file as the engine renders it at the same device width. |
| `annotate-text-evidence.png` | The spec's own picture (§1, §3), delivered with it. **Left:** before this change — the editor's boxes (red outlines) above the same boxes as the downloaded file draws them, in a different face and with every line at a different height. **Right:** the prototype — browser ink (red) over file ink (blue), dark where they coincide. |
| `freetext_ap_prototype.py` | The spec's prototype (§3): a custom FreeText `/AP /N` drawn line by line with `fitz.TextWriter`, which first measured the ≤ 0.5 pt residual. Kept as delivered; not run by any gate. |

**Result (final full-suite run):** worst ink-bbox delta **1 device px** on any edge of any
box in any run (the gate: ≤ 1); worst **shape shift** — the cross-correlation peak between
the screen's and the file's ink — **0.93 device px** (the guard: ≤ 1.25; most boxes under
0.2 horizontally and 0.5 vertically). The residual is vertical and is the browser snapping
each text run's baseline to a whole pixel while MuPDF places it exactly — the spec's own
prototype measured the same ≤ 0.5 pt (§3).

**On the compose stack (CLI, 2026-09-25).** The spec's first run against `infra/` — Postgres, SeaweedFS, real Celery workers, the Angular dev server — on Playwright 1.61.1's **Chromium 1228** (the sandbox's was 1194): **8 / 8** green first time, tolerances untouched. Over the 40 boxes the ink-bbox delta was 0 device px on 28 and 1 px on 12; the worst shape shift **0.993 px**, vertical, on the Hebrew box at 1.5× (horizontal ≤ 0.099 px everywhere; at 1× every box ≤ 0.053 px); both themes measured identically, as they should — the page is white in both.

**The gate discriminates.** With the engine's baseline deliberately moved by 1.5 pt, all
four light-theme runs failed; the shape shift read 1.0–3.0 px.

**Measurement notes** (why the numbers are what they are):

- *Ink* is a pixel at least ~15 % covered (luminance difference > 40). A higher cut
  measures only glyph cores, which a 5 px phone glyph has in one rasteriser (Skia) and
  not in the other (MuPDF) — at the 390 px phone's 9 pt (≈ 5 CSS px) a 1/3-coverage cut
  produced 15 px "deltas" between two renderings that overlay perfectly by eye.
- A centre of mass was tried first and dropped as an assertion (still recorded as
  `cx`/`cy`): two rasterisers shade the same glyph differently enough to move it ~0.9 px
  with the shapes exactly aligned, and one full-suite run reported 1.25 px that way.
  The cross-correlation asks only where the shapes line up.
- A per-size "baseline nudge" (measuring Blink's rounded first baseline with a probe and
  moving the box by the difference) was tried and **reverted**: it improved the phone's
  9 pt line and made two 1.5× boxes worse — the probe's layout baseline is not where the
  glyphs are painted. Recorded so nobody tries it again without measuring paint.
