# Annotate defect run — evidence

Two sets. `01`–`03` are the **Cowork sandbox's**, taken while validating the fix: the new
frontend served against the *production* API, which still ran the old backend. They prove the
overlay half — every mark drawn the file's own way — and nothing about the engine half, because
on that harness a reloaded stamp still came back aspect-fitted at **3.80** with its contents
overwritten to "Approved". The handoff said so in the open.

`04`–`08` are the **CLI's**, taken after PR #48 merged and Railway published
`main-PMI4V7BP.js`. They are the engine half, on production, as a guest.

| | What it shows |
|---|---|
| `01-all-marks-drawn-light.png` | Sandbox: all six marks drawn — four markups distinct, stamp as bordered capitals, image stamp as its actual pixels |
| `02-after-save-reload-light.png` | Sandbox: after save + reload, light |
| `03-after-save-reload-dark.png` | Sandbox: after save + reload, dark |
| `04-production-after-save-reload-dark.png` | **Production, dark.** After Save + full reload: both stamps at the shape drawn, the comment reading "second pass, please" — not "Approved" |
| `05-production-after-save-reload-light.png` | The same, light |
| `06-production-view-mode-the-file-itself.png` | **The file's own rendering** (pdf.js): `APPROVED` inside its border at the drawn shape, and the image stamp's real pixels beside it — neither squashed |
| `07-production-view-mode-four-markups.png` | The file's own rendering of the four markups: wash, wave, line under, line through |
| `08-production-390-tools-drawer.png` | Production at a true 390 px: the Tools sheet, every entry at 44 px, **Image stamp live rather than dashed-disabled** — which was defect 2 |

**The measurement `04`–`06` are evidence for**, taken from the live DOM rather than the pixels:
a stamp and an image stamp each drawn at ratio **1.5** came back out of the file at **1.5** and
**1.5**. The defect saved them at roughly **4:1**.
