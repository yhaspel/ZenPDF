# Backend debt — what the browser showed

Produced 2026-08-23 on branch `fix/backend-debt-2026-08` (prompt 4 of the handoff programme,
`docs/reviews/handoffs/TRACKING.md`). The narrative is in `development-plans/PROGRESS.md`, session
log **"2026-08-23 (later still, backend) — Backend debt: counters that could lie, an append nobody
was told about, a reconciler that never existed"**; this folder is the raw material behind it.

Driven through the Chrome DevTools MCP tools against `http://localhost:4200` on the local stack,
in **both themes** at **1280 px** and **390 px**. Console read at the end of the run: **no errors
and no warnings at all**.

Two of the three cases needed a real quota refusal, so `USER_STORAGE_QUOTA_MB` was set to **0** in
`infra/.env` for the duration and **restored byte-for-byte afterwards** (that file is gitignored
and was never part of the change; `diff` against the backup confirms it). The api and all four
Celery services were recreated for the change to reach the worker that runs `finalize` — the
quota is enforced in `_save_new_version`, which runs on `worker-heavy`, not in the API.

Quota 0 is safe for this test and not a blunt instrument: the ceremony's own signature image is
written to `sign/{request}/fields/…` and is **not** charged to the owner (`PublicSignFieldView`
calls `put_bytes` with no `bump_storage`), so the signer can still complete. Only the owner-side
append is refused, which is exactly the path under test.

**On the 390 px shots.** Chrome's window floor is 500 px, so `resize_page` cannot reach a phone
width; these use device emulation (`390x844x3,mobile,touch`), where `document.documentElement.clientWidth`
reads a true 390 and `(min-width: 640px)` does not match. Note that `window.innerWidth` reads 527
under that emulation — the visual viewport, not the layout one. Measure with `clientWidth`.

| File | What it shows |
|---|---|
| `01-request-detail-happy-light-1280.png` | The **happy path**: a completed envelope with no append notice at all. The regression this guards against is a notice that always renders, which would be worse than none. Verified alongside it that the append genuinely landed — the document's versions read `v2 Signed`, `v1 Original`. |
| `02-append-notice-light-1280.png` | The notice with the **real quota reason**, light mode: *"The signed copy could not be added to your document: That would take you past your 0 MB of storage. Empty your trash or delete a document to free some up. The sealed file and certificate are unaffected — download them here."* The sentence after the colon is `QuotaExceeded`'s own copy, not a second version of it. |
| `03-append-notice-dark-1280.png` | The same, dark mode. |
| `04-append-notice-dark-390.png` | The same at phone width, dark. The notice wraps inside the content column (measured 326 px wide in a 390 px viewport) and the two downloads stay reachable below it. |
| `05-append-notice-light-390.png` | The same at phone width, light. |
| `06-trash-undeletable-light-390.png` | **The one shot that shows a pre-existing defect rather than this change.** The dashboard at 390 px keeps its desktop sidebar beside a two-column grid, so cards are ~110 px wide and the meta line `3 pages · 3 KB` already wraps to four lines *on the card with no notice on it*. Measured independently of any notice: with the library empty and no `[data-test=undeletable]` anywhere on the page, `document.documentElement.scrollWidth` is **527 against a 390 px viewport**, and the same 527 overflow appears on `/app/settings`, which this change does not touch. Filed as a queue row; the phone workspace is prompt 6's. |
| `07-trash-undeletable-light-1280.png` | The trash view as designed: three trashed documents, the one with no signature request carrying **no** notice, the two under requests each carrying the info notice. Their menus were read too — `Restore` on all three, `Delete forever` on the first only. |
| `08-trash-undeletable-dark-1280.png` | The same, dark mode. |

## What was checked without a screenshot

* **The notice clears on a successful resume.** With the quota restored, `_finalize_tail` re-ran
  the append: `source_appended_at` went from `None` to a timestamp, `source_append_error` from the
  quota sentence to `None`, and the document gained `v2 Signed`. The page then rendered no notice.
* **The downloads the notice points at work.** `GET /api/sign-requests/{id}/download/final/` →
  200, `application/pdf`, 27 394 bytes; `…/certificate/` → 200, `application/pdf`, 3 944 bytes.
* **`recompute_usage` agrees with production reality.** Against the stack straight after a full
  e2e run — **57 principals**, every one of them created by the product itself — the first dry run
  reported `0 would be corrected`. That is the strongest available check that `charged_bytes`
  models what the code actually charges.
* **…and it reports before it writes.** 40 MB of drift injected by hand:
  `usage_recompute: user 87e56bb7-… drifted -41943040 bytes (42006958 → 63918) [dry run — not written]`,
  the usage panel still reading **40.1 MB of 2048 MB used** afterwards, then `--apply` and the
  panel back to **0.1 MB**. `--apply --dry-run` together is refused:
  `CommandError: --apply and --dry-run contradict each other.`
* **Both beat entries are registered**, read out of the running `beat` container:
  `usage-recompute → apps.core.tasks.usage_recompute <crontab: 0 2 * * *>` and
  `account-assets-purge → apps.core.tasks.account_assets_purge <crontab: 0 3 * * *>`.
* **The saved-signature exemption, live.** A `SavedSignature` and an ordinary asset were created
  in the same prefix and the sweeper run with `days=0` — a window that takes everything by age.
  Result: `{'users': 1, 'blobs': 1, 'bytes': 94, 'kept': 1}`; the signature's blob still exists and
  its row still points at it, the ordinary asset is gone. This is the behaviour the commissioning
  prompt's assumption ("saved signatures live elsewhere") would have got wrong.
* **The 503 headers** were proven against real nginx rather than in a browser — see the queue row.
  The compose stack serves :4200 from the Angular dev server, so the locally-prescribed
  `curl http://localhost:4200/api/config/` would have exercised the dev-server proxy and not
  either nginx config.
