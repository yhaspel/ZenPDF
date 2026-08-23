# Workspace debt — what the browser showed

Produced 2026-08-23 on branch `fix/workspace-debt-2026-08` (prompt 3 of the handoff programme,
`docs/reviews/handoffs/TRACKING.md`). The narrative is in `development-plans/PROGRESS.md`, session
log **"2026-08-23 (later still) — Workspace debt: five things the record had been carrying"**;
this folder is the raw material behind it.

Driven through the Chrome DevTools MCP tools against `http://localhost:4200` on the local stack,
in **both themes** at **1280 px** and **390 px**. Console read after every step: no errors at all,
and the only warnings are pdf.js's pre-existing `[fluent] Missing translations` for the sidebar
buttons the workspace hides by config.

The two throttled cases needed a real 429, so `THROTTLE_USER` was lowered in `infra/.env` for the
duration and **restored byte-for-byte afterwards** (that file is gitignored and was never part of
the change). The guest scope could not carry them: a guest is capped at 300 pages and the fixture
is 500, so the *user* scope was lowered to the same rates instead — first to 8/min, then to
40/min, which is production's **guest** rate. The behaviour under test is what a tile does with a
429, and that does not depend on which scope produced it.

| File | What it shows |
|---|---|
| `01-rail-500-light-1280.png` | A 500-page rail, healthy. 14 tiles fetched of 500 mounted — the phase-10 visibility gate — filled in ~105 ms, and a fast full-height scroll produced **no retry buttons**. |
| `02-rail-throttled-8min-light-1280.png` | The same rail at a deliberately brutal 8/min against 12 tiles on screen. It backs off, most tiles arrive, and the four that genuinely spend all four attempts fall to the labelled retry — which is the specified floor, not a regression. |
| `03-rail-throttled-filled-light-1280.png` | The same rail at 40/min (production's guest rate) with the window already spent: **12 refused tiles, 0 failed, all still "loading"**, then all 12 filled by themselves at ~47 s. No retry button ever appeared. |
| `04-stamp-palette-armed-light-1280.png` | The `image_stamp` entry after an upload: pressed, wearing the 24 px image, ink-stamp treatment. |
| `05-stamp-palette-armed-dark-1280.png` | The same in dark — the ink stamp inverts (`#F8F3E7` on `#171310`, 16.7:1). |
| `06-stamp-palette-dark-390.png` | 390 px, dark. Palette wraps to 9 rows of 2, smallest hit target **44 px**, no horizontal overflow. |
| `07-stamp-palette-light-390.png` | The same in light. |
| `08-ocr-completed-after-leaving-light-1280.png` | Settings → usage after an OCR that was started, then abandoned by navigating away mid-poll: **`ocr succeeded`**, "Pages OCR'd this month 4". The job finished; only the polling stopped. |
| `09-compare-summary-light-1280.png` | "Compared 2 pages against 4 — 4 pages differ (2 only exist in the other document) · 4 text changes". |
| `10-compare-summary-dark-1280.png` | The same in dark. |
| `11-compare-summary-dark-390.png` | The same at 390 px, no overflow. |
| `12-undo-bar-after-refused-redo-dark-1280.png` | The bar **after** a Redo that drew a 429: still "Undo the last change — back to v3" / "Redo — forward to v5", both enabled, `v6` unchanged. On the previous code this read "back to v5" / "Nothing to redo". |
| `13-undo-bar-advanced-light-1280.png` | The same Redo pressed again once the window passed: `v7`, "back to v4" / "Nothing to redo" — the chain reached its ceiling, which is where the person started. |

## Numbers worth keeping

* **Subscriptions.** OCR started, then the workspace left by router navigation: **5 job polls while
  the panel was alive, 0 in the eight seconds after it was destroyed**, and no toast on the screen
  the person landed on. The job still succeeded.
* **The healthy rail pays nothing.** 14 visible tiles, 14 requests, ~105 ms, `paused === false`.
* **Contrast, measured from the computed styles** (relative-luminance math): pressed palette entry
  15.0:1 light / 16.7:1 dark; disabled entry text 6.7:1 light / 8.3:1 dark — both well past the
  ≥3:1 the contract asks of a disabled control. The disabled *dashed border* is 1.8:1 in dark,
  which is `--color-border-strong` doing exactly what §3's D5 treatment specifies everywhere in the
  product: the pattern (dashed vs solid) and the text carry the state, not the border's contrast.
  Recorded because it was measured, not as a finding of this change.
* **A page reload starts a new session**, so the stamp entry is disabled again — by design, and the
  §3 spec says "in the session". Leaving Annotate and coming back does **not** lose it (verified:
  the panel was confirmed gone from the DOM in between).
