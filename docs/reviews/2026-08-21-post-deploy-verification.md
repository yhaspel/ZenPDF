# Audit — ZenPDF production — 2026-08-21, 09:20–11:05 UTC

Independent verification of the UI-audit deploy (PRs #17, #18), and a full pass over the
feature stack. Method: evidence from the live system only. Every claim below is labelled
**Verified** (measured here), **Inferred** (read from code/config, not confirmed live), or
**Unverified** (could not check, with the reason).

The checklist and its pass criteria were fixed **before** any evidence was gathered; it is
reproduced in Appendix A so the thresholds can be seen not to have been chosen after the fact.

## Verdict

**26 of 28 checks pass. Two failed, both found only by measuring rather than by looking, and
both are fixed in this branch.** The three defects the deploy set out to fix are closed on the
live site, and the whole tool stack — all 24 tools, all 9 workspace modes, every annotation
type, forms, editing, protection, signing, comparison, conversion and verification — works end
to end against the production API.

Two corrections to the record are also part of this audit: one previously-reported bug does not
reproduce in production, and one previously-passing check was passing for the wrong reason.

---

## How this was tested

The deployed site was driven through a **transparent reverse proxy** on localhost that forwards
every request to `https://zenpdf.up.railway.app` and returns the response bytes, status and
headers unchanged — so the browser executes the deployed artefact, with production's own
content types, cache headers and CSP, while being automatable. MIME and cache assertions were
made with **direct `curl` to production**, not through the proxy, so they cannot be an artefact
of it.

Proof the proxy is transparent, and that the site is serving the audited commit:

```
curl .../main-EGLRBRDO.js  | sha256 = 45c5e695b1d64053…   (production)
mirror  /main-EGLRBRDO.js  | sha256 = 45c5e695b1d64053…   (through the proxy)
local `npm run build` at dacf623 → main-EGLRBRDO.js, sha256 45c5e695b1d64053…
                                 → styles-PJ5P6VJ3.css, sha256 4074ddfdeaf14ecc…
```

A local build of the deployed commit reproduces production's bundle hashes **byte for byte**.
The site is running this source, not a stale image. *(Verified.)*

---

## A — Did the deploy land?

**A1. `origin/main` carries the six commits — PASS.** `git log origin/main`: `7022a5b` fix(api)
· `f394323` fix(guest) · `6bc6b88` feat(annotate) · `4241cbc` fix(workspace) · `eea78d9`
fix(tools) · `7b79e5e` docs, merged as #17 and #18. The only difference from the tree handed
over is two documentation commits added by the CLI session; **no application code was
altered in transit** (`git diff` between the handed-over tree and `origin/main` touches
`PROGRESS.md` and `docs/archived/` only). *(Verified.)*

**A2. The deployed frontend is a rebuild of that commit — PASS.** `index.html`
`last-modified: Fri, 21 Aug 2026 07:25:09 GMT`; bundle names changed (`main-RL5Q42VK` →
`main-EGLRBRDO`, `styles-Y4HJLEOL` → `styles-PJ5P6VJ3`); hashes reproduced locally as above.
*(Verified.)*

**A3. The deployed API carries the new middleware — PASS.** Evidence in B2. *(Verified.)*

---

## B — The nine headline fixes, on the live site

**B1. `.mjs` and `.wasm` MIME — PASS.** *(Verified, direct curl 09:21 UTC.)*

```
/assets/pdf.worker-6.0.1169.min.mjs   200 text/javascript
/assets/viewer-6.0.1169.min.mjs       200 text/javascript
/assets/pdf.sandbox-6.0.1169.min.mjs  200 text/javascript
/assets/wasm/openjpeg.wasm            200 application/wasm   (252 032 B)
/assets/wasm/quickjs-eval.wasm        200 application/wasm   (432 499 B)
/assets/wasm/qcms_bg.wasm             200 application/wasm   ( 88 837 B)
```

The `.wasm` half was never exercised before; pdf.js ships three of them and all three are now
served as WebAssembly rather than `application/octet-stream`.

**B2. API caching — PASS.** *(Verified, direct curl.)*

| request | status | `Cache-Control` |
|---|---|---|
| `GET /api/config/` | 200 | `private, no-store` |
| `POST /api/guest/session/` | 201 | `private, no-store` |
| `GET /api/documents/<missing>/` | 404 | `no-store` |
| `GET /api/config/` with a dead token | 410 | `no-store` |
| `GET …/pages/0/thumbnail/` | 200 | `private, max-age=86400` |
| `GET …/content/` | 200 | `private, max-age=0, must-revalidate` |

The last two matter as much as the first four: the middleware fills in only where the view
expressed no opinion, so the deliberately-cached page raster kept its day-long `max-age`. The
rule is "never store an error", not "never cache".

**B3. The viewer draws — PASS.** *(Verified, measured pixels, not a status code.)* On a hard
navigation to `/app/doc/<id>?mode=view` from a cold profile: `/api/documents/<id>/content/`
→ 200; modules loaded `viewer-6.0.1169.min.mjs`, `pdf.worker-6.0.1169.min.mjs`; the canvas is
**1201 × 1699 with 7 distinct sampled colours** — a blank canvas samples one. Zero failed
static assets.

Note on the console: three `net::ERR_ABORTED` entries appear for `/api/config/` and
`/outline/`. Each has a **successful sibling in the same page load** — those are the
prerendered shell's requests being torn down when the SPA takes over, not failures. Recorded
rather than swept under the carpet, since a silent abort is what hid the original defect.

**B4. The returning visitor — PASS.** *(Verified.)* With `zen_guest` set to a dead value, a
full upload → workspace flow: **exactly one 410**, one `POST /api/guest/session/` → 201, every
later API call 200, **no expiry banner** (`guest-expired-notice` count 0), **no error screen**
(`workspace-error` count 0), and a 43-character token in `localStorage` at the end. This is the
failure that took the site down for anyone returning after 24 h; it is closed.

**B5. The text box — PASS.** *(Verified, including the file.)*
- caret lands in `overlay-text-editor` on creation — no hunting for where to type;
- the full 57-character sentence renders in `[data-test=overlay-text]`, **not truncated**;
- computed colour `rgb(51, 45, 36)` = `#332D24` ink, **not** the highlighter's `#facc15`;
- computed font size `9.07563px` against a 450 px-wide render of a 595 pt page — the formula
  `12 / 595 × 450 = 9.0756` to four decimals;
- no badge element anywhere (`overlay-label` count 0);
- Undo empties it, Redo restores it;
- the downloaded file carries `/FreeText` `'A sentence comfortably longer than twenty-four
  characters.'` with `DA = 0.2 0.176471 0.141176 rg /Helv 12.0 Tf`.

**B6. Error copy and chrome — PASS.** *(Verified.)* `/app/doc/00000000-…` renders *"We could
not find that. It may have been deleted, or it may belong to a session that has ended."* — with
a minimal workspace bar (1), a theme toggle (1) and a way out (1). Centred, in both themes.

**B7. Merge order — PASS.** *(Verified from the merged file.)* A 60-page 29 876-byte file added
first, a 1-page 879-byte file second — the ordering that used to invert. The merged PDF has 61
pages; page 1's footer reads *"page 1 of 60"* and the last page reads *"page 1 of 1"*. The
order the visitor chose survived the race.

**B8. Workspace height — PASS.** *(Verified.)* At 1440 × 900 the viewer host is **753 px of the
753 px available — 100 %**. It was 318 px of 753 before.

**B9. The phone — FAIL, now fixed.** *(Verified.)* See Finding 1.

---

## C — The feature stack

**C1. All 24 tool pages, end to end — PASS (24/24).** *(Verified against the production API.)*
Fourteen produce a result with download links, ten hand off to the workspace. Zero uncaught JS
errors, zero 4xx/5xx, zero broken static assets across the whole sweep. `split-pdf` on a
3-page file returned three download rows, as it should.

```
merge result·1dl   split result·3dl   compress result·1dl  rotate result·1dl
delete-pages·1dl   extract-pages·1dl  organize→workspace   annotate→workspace
edit→workspace     watermark·1dl      page-numbers·1dl     fill-form→workspace
pdf-to-word·1dl    pdf-to-jpg·1dl     jpg-to-pdf·1dl       compare→workspace
repair·1dl         protect→workspace  redact→workspace     sign→workspace
unlock→workspace   ocr·1dl            html-to-pdf·1dl      word-to-pdf·1dl
```

**C2. All 9 workspace modes render — PASS.** *(Verified.)* view · organize · edit · annotate ·
forms · convert · compare · sign · protect, each rendering its own panel with no error state.

**C3. Every annotation type — PASS (14/14).** *(Verified from the file.)* All fourteen drawn in
one session, saved as one batch, then **read back through the API after a reload** — i.e. read
out of the PDF, not out of memory:

```
{"highlight":1,"underline":1,"strikeout":1,"squiggly":1,"note":1,"free_text":1,
 "square":1,"circle":1,"line":1,"arrow":1,"polygon":1,"polyline":1,"ink":1,"stamp":1}
```

with the free text carrying `"Audit text box"` in `#332d24`. A fifteenth, `image_stamp`, was
verified separately (below) — it is reached by uploading a custom stamp, which switches the
tool by itself. Crop was applied and produced a new version. Zero JS errors throughout.

*First attempt caveat, recorded because it nearly became a false finding:* the first run
produced 5 of 14 and the missing nine looked broken. They were not — at the default zoom the
lower half of the page is off-screen, so the mouse coordinates landed outside the viewport.
Fitting the page first (what the e2e suite's own `fitPage()` helper exists for) produced 14/14.

**C4. Forms — PASS.** *(Verified from the file.)* A real AcroForm fixture loaded with three
field rows; a value typed and saved; the downloaded file reads back
`full_name = 'AUDIT-FORM-VALUE'`.

**C5. Editing text — PASS.** *(Verified from the file.)* Three editable blocks detected; one
replaced; the downloaded file's page 1 contains `EDITED-BY-AUDIT-2026`.

**C6. Protection — PASS.** *(Verified from the file.)* The download is encrypted;
`PdfReader.decrypt('AuditPass123')` returns 2 (owner match) and yields 2 pages, and a wrong
password returns 0.

**C7. Organize — PASS.** *(Verified.)* 4 tiles, "1 selected" after a click, Rotate → `v2 · 4
pages`, Duplicate → `v3 · 5 pages`.

**C8. Self-sign as a guest — PASS.** *(Verified from the file.)* The signature pad opens by
itself on entering Sign mode (which is why the "Create your signature" button underneath is
covered — correct, not a defect); drawn, kept, placed — *"1 placement(s). Click one to remove
it."* — applied, downloaded. The file carries the signature as a **600 × 200 image XObject
flattened into page 1**, with **zero annotations** — genuinely flattened, not an annotation
that a reader could move — and the original page text intact.

**C9. Compare — PASS.** *(Verified.)* A 2-page against a 4-page document, after pressing
Compare: *"4 of 2 page(s) differ · 4 text change(s)"* with 4 clickable change rows.

**C10. Convert — PASS.** *(Verified.)* The tool-page path produced downloads for
`pdf-to-word`, `pdf-to-jpg`, `html-to-pdf`, `word-to-pdf` and `ocr-pdf` in C1; the workspace's
own export panel renders.

**C11. Verify — PASS.** *(Verified.)* `POST /api/verify/` → 200, and the report is honest about
an unsigned file: *"This PDF has no signature — that is not a fault; most PDFs are not
signed."*

**C12. Versions and the new Undo — PASS.** *(Verified.)* Undo is **disabled at v1**; after
deleting a page the header reads `v2 · 4 pages`; Undo returns `v3 · 5 pages` (a revert is
itself a new head version, as designed); the History tab lists 3 versions.

**C13. Download — PASS.** Every downloaded artefact in C3–C8 parsed as a valid PDF.
*(Verified.)*

**C14. Guest limits — PASS.** *(Verified.)* `/api/config/` quotes the guest tier to the client:
`max_upload_mb 25 · max_pages 300 · max_concurrent_jobs 1 · metered_ops_per_hour 5 ·
ocr_pages_per_day 50 · library false`. `ads.enabled: false`, `consent_required: false`.

---

## D — Cross-cutting

**D1. Themes, RTL, phone — PASS.** *(Verified.)* Light and dark screenshots of the landing, a
tool page and the workspace; RTL mirrors correctly with no overflow (1440/1440); the mobile
landing and tool pages do not scroll sideways (390/390). *(The workspace on a phone was the
exception — Finding 1.)*

**D2. Console and network sweep — PASS.** *(Verified.)* 34 pages × 2 themes = **68 loads**.
Problems: 2, both the deliberate 404 page correctly answering HTTP 404 with the h1 *"That page
is not here"* — a real 404 status is the intended behaviour, so a crawler is told the truth.
No other console errors, no failed assets, every page has an `h1`.

**D3. Security headers — PASS.** *(Verified.)* The full set — CSP, HSTS, `nosniff`,
`X-Frame-Options: DENY`, `frame-ancestors 'none'`, Referrer-Policy, Permissions-Policy — is
present on HTML, on hashed assets, on **the new `.mjs`/`.wasm` locations**, and on `/api/`
(with its stricter `default-src 'none'; sandbox` policy). This was a real risk: nginx's
`add_header` in a new location *replaces* the parent's set, so the new blocks could have
silently dropped CSP on exactly the files that carry executable code. They did not.

*Observation, not a failure:* hashed assets return two `Cache-Control` headers
(`max-age=31536000` from `expires` and `public, immutable` from `add_header`). Valid when
combined, and pre-existing — the conf's own comment acknowledges the pattern.

**D4. The repo's own gate at the deployed commit — PASS.** *(Verified.)* `ng lint` clean ·
**250 unit tests, 250 passed** · build + 29 prerendered routes + `verify:prerender` green ·
`ruff` clean · `mypy` clean on 173 files · backend `pytest` **1029 passed**, with the failure
set **byte-identical to the pre-patch baseline** (the OCR language packs, Ghostscript, unpaper
and admin-allowlist absences this sandbox always shows). The CLI's run on the full local stack
was 1061 passed / 4 skipped with none of those absences, which corroborates.

---

## Findings

### 1 — The toolbar above the page overflowed a phone. *(FAIL on B9; fixed in this branch.)*

At a true 390 px layout, `document.documentElement.scrollWidth` in Annotate is **609** — the
document scrolls sideways. Eight of the nine modes are clean; Annotate is not.

The cause is one missing utility. Seven panes carry the same toolbar row above the page; the
organize one has always had `flex-wrap` and the other six never did. Annotate's row needs
609 px, and **445 px of that without Undo and Redo** — so the row was already wider than a
phone before this session, and the two new buttons made it plainly so.

**Why the earlier check missed it, which matters more than the bug.** Under mobile emulation
Chrome answers an overflowing page by widening its own layout viewport — to 609 — and drawing
the app at about 64 %. The previous session compared `documentElement.scrollWidth` against
`window.innerWidth` and got `609 <= 609`, and passed. The measurement has to be against the
*device* width (`visualViewport.width`), or taken with mobile emulation off. Both the check and
the code were wrong; the check is why the code stayed wrong.

Fixed by giving all seven rows `flex-wrap`, matching the organize toolbar that always had it.
Wrapping rather than scrolling because these rows end in **Save** — a primary action must not
sit off an edge nobody knows to drag. The workspace bar stays the deliberate exception; nine
mode buttons wrapped would push the page down on every screen. **After: all nine modes report
`scrollWidth === 390` at a 390 px layout.**

### 2 — "Organize pages" did not open the page grid. *(Pre-existing; fixed in this branch.)*

`/organize-pdf` — the tool whose entire subject is the page grid — landed the visitor in the
reading view, with the grid one unexplained click away. Two halves, and either alone is a
no-op: `tool-page.ts` maps each interactive tool to its mode and `organize` was the one entry
with an empty object; and the workspace's query-param handler accepted seven modes with
`organize` (and `view`) not among them, so even an explicit `?mode=organize` rendered the
reading view. Presumably why the map entry was left empty.

**After:** `/organize-pdf` lands at `?mode=organize` with the grid, the toolbar and 6 tiles
rendering, and no overflow at 390 px. A new spec asserts the landing mode for **all eight**
interactive tools, not only the one that was wrong.

### 3 — A correction: the `separate`-extraction bug does not reproduce in production.

Recorded on 2026-08-21 from an e2e failure as *"`separate` extraction returns one document
where two were asked for"* and *""Do another one" does not re-arm the dropzone"*. Neither
reproduces against the live site:

- `separate` extraction of "2, 4" from a 5-page file returns **two** result rows,
  `audit — page 2.pdf` and `audit — page 4.pdf`;
- after "Do another one", re-picking a file leaves **1 file row with the CTA enabled**;
- the radio selects both by clicking its label and by clicking the radio itself
  (`radioViaLabel=true`, `radioViaRadio=true`).

The e2e failure is therefore in the harness, not the product — Playwright's `check()` not
taking on that native radio, after which `separate` was never set and one document was the
correct answer to what was actually sent. The queue row should be re-scoped to the test.
*(Verified; the underlying e2e run was not re-executed here — see Scope limits.)*

### 4 — Smaller observations, not failures

- **The palette does not show `image_stamp` as the active tool.** Uploading a custom stamp
  switches the tool to `image_stamp` (correctly — the whole flow works and the annotation
  lands in the file), but no palette button lights up, so the palette shows "Select" while
  something else is armed. There is also no way back to it without re-uploading.
- **"4 of 2 page(s) differ"** in the compare summary reads like an arithmetic bug when the
  two documents have different page counts, even though the number is defensible.
- **A malformed PNG is refused with the right words.** `POST /api/uploads/image/` → 400 *"That
  image could not be read."* for a truncated file, and a well-formed 8-bit RGB PNG uploads
  normally. Confirmed against the same library the server uses (`fitz.Pixmap` raises
  *"premature end of data in png image"*). Correct behaviour, recorded because it looked like a
  defect until it was checked.

---

## Scope limits

Read this section before concluding anything from the rest.

- **Nothing requiring an account was tested.** Creating accounts and entering passwords is not
  something this audit does on a live service, so the library, folders, saved signatures,
  multi-party signature requests, settings and the claim-on-signup flow are **Unverified** —
  not "fine", not "skipped", *unchecked*.
- **Multi-party e-signing is unreachable in production regardless:** SMTP is deliberately off,
  so every mail is dropped. The platform signing certificate has still never sealed a document
  (handoff item H1). Unchanged by this deploy and still open.
- **The e2e suite was not run here.** It needs the full local stack, which this environment
  cannot host. Finding 3 disputes an e2e *result* on live evidence; it does not re-run the
  suite, and the suite should be corrected and re-run.
- **The two fixes in this branch are verified against a local build**, not against production —
  they have not been deployed. Production still overflows in Annotate on a phone and still
  opens the reading view for "Organize pages".
- **Timing and throttling.** All of this ran from one egress against production's real rate
  limiter. Several checks were re-run after a throttle; none of the recorded results is a
  throttled response. Per-IP throttle behaviour itself was not audited.
- **Not covered:** Lighthouse/Core Web Vitals, screen-reader behaviour, keyboard-only
  traversal, print, PDF/A conformance beyond the claim, OCR accuracy on real scans, and
  anything about how the site behaves under concurrent load.

---

## Appendix A — the checklist, as fixed before evidence was gathered

A1 deploy identity · A2 frontend rebuilt · A3 API middleware live · B1 `.mjs`/`.wasm` MIME ·
B2 API cache headers · B3 viewer draws (measured pixels) · B4 returning-visitor recovery ·
B5 text box (rendering, colour, size, undo, and the file) · B6 error copy and chrome ·
B7 merge order · B8 workspace height ≥ 90 % · B9 no horizontal scroll in any mode at 390 px ·
C1 24/24 tools · C2 9 modes · C3 every annotation type read back from the file · C4 forms ·
C5 editing · C6 protection · C7 organize · C8 self-sign · C9 compare · C10 convert · C11 verify ·
C12 versions and Undo · C13 downloads parse · C14 guest limits · D1 themes/RTL/phone ·
D2 console sweep · D3 security headers · D4 repo gate.

Out of scope, stated up front: anything requiring an account; multi-party signing (SMTP off);
the platform certificate.
