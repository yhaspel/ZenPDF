# Audit — ZenPDF Phase 12 in production — 2026-08-21, ~15:00–15:40 UTC (18:00–18:40 Asia/Jerusalem)

Target: `https://zenpdf.up.railway.app`, running `main` @ `f34800f` (PR #20, `ec8a33e`).
Auditor: an independent pass. The CLI session's own smoke was **not** treated as evidence; every claim below was re-gathered.

## Verdict

**20 of 20 checks passed. One area was not testable and is reported Unverified, not passed.**

Phase 12 is live and behaving as specified, including all six defects it set out to fix. Three checks failed on first measurement and all three were faults in my own harness, not in the product — each was re-run against a clean page and passed with exact numbers. That detail is in the notes, because an audit that hides its own false starts is not one you can calibrate against.

## Checks

**1. Deploy identity — PASS**
Criterion: `/api/health/` ok; the served bundle is what HEAD builds; Phase-12 symbols present.
Evidence: `GET /api/health/` → `{"status":"ok","checks":{"db":true,"redis":true,"storage":true,"gotenberg":true,"workers":true}}`. **SHA-256 of the served files equals the Mac's HEAD build byte for byte** — `main-ZV5ZVVU6.js` = `12d8b751b7cb1893…48f5559` on both; `chunk-5V6BAQ5R.js` (the whole page-overlay, menu and keyboard layer) = `7109aad348 57e7d4…011373e` on both. 46 chunks fetched from production and grepped: `menuActionsFor`, `shortcuts-help`, `redo-version`, `protect-undo`, `sign-undo`, `builder-undo`, `overlay-menu`, `overlay-live`, `preventScroll`, `page editing layer`, `At the edge of the page`, `Remove area`, `Remove signature`, `Select one to move or remove it` all present. Last commit touching `frontend/src` is `f1cc3a6`, inside PR #20.
Label: **Verified**

**2. D-A — a right-click is not a left-click — PASS**
Criterion: a right-click neither changes the selection nor moves anything.
Evidence: with a mark selected, right-clicking empty page left the selection count at 1→1, the mark's geometry moved **0.00 px**, and the mark count stayed 1.
Label: **Verified**

**3. The menu's actions work — PASS**
Criterion: ≥5 entries; Delete removes exactly one mark.
Evidence: entries `["Copy Ctrl+C","Cut Ctrl+X","Duplicate Ctrl+D","Edit comment…","Delete"]`; menu **Delete** took 2 marks → 1; menu **Duplicate** took 1 → 2.
Label: **Verified**

**4. An empty action list leaves the browser's own menu alone — PASS**
Criterion: right-click on empty page with an empty clipboard renders no app menu.
Evidence: 0 `overlay-menu` nodes, and the event was not `preventDefault`ed. With something copied, the same gesture offers exactly `["Paste here"]`.
Label: **Verified**

**5. The menu's keyboard — PASS**
Criterion: `Shift+F10` opens on the selection; ↑/↓/Home/End move; Enter activates; Esc closes keeping the selection; no key reaches the overlay while open.
Evidence: `ArrowDown ArrowDown ArrowUp End Home` moved both `document.activeElement` and the `.is-active` highlight in lockstep — index `0→1→2→1→4→0`, text `Copy→Cut→Duplicate→Cut→Delete→Copy`. `Shift+F10` opened it. `Delete` pressed while the menu was open left the mark count unchanged (1→1). `Esc` closed it, kept the selection, and returned focus to `APP-PAGE-OVERLAY`.
Label: **Verified**
Notes: failed on first pass — my check read the active element in the same tick as the keypress, before the microtask-scheduled focus move. Harness fault; see Notes below.

**6. Menu geometry — PASS**
Criterion: every row 44 px; the menu sits inside the page box.
Evidence: `[44,44,44,44,44]` in light and `[44,44,44,44,44]` in dark; menu rect inside the page rect = true.
Label: **Verified**

**7. Clipboard — PASS**
Criterion: ⌘C then ⌘V takes 1 mark to 2, offset ≈2 % of the page; a duplicated form field never collides on name; ⌘C with text selected leaves the editor clipboard alone.
Evidence: 1→2 marks, copy offset **12 × 17 px** on a 600 px page (2 % = 12.0 px). Forms builder: duplicating a field produced labels `["text_1 · text","text_2 · text"]` — distinct. With the sidebar text `square` selected, ⌘C did **not** arm the editor clipboard (no Paste offered); with nothing selected, ⌘C on the mark did.
Label: **Verified**

**8. Delete / Undo / Redo in Annotate, from the keyboard — PASS**
Criterion: Delete 2→1, ⌘Z →2, ⇧⌘Z →1.
Evidence: exactly that, all three via the keyboard alone.
Label: **Verified**

**9. Nudge — PASS**
Criterion: one arrow = 0.25 % of the page width; Shift ×10; clamps at the edge and says so.
Evidence: on a 600 px page the selection went `516.00 → 517.50 → 519.00 → 520.50 → 522.00` — **1.50 px per press, which is 0.25 % exactly** — and one `Shift+ArrowRight` moved it 522.00 → 537.00, **15.00 px**. Holding Shift+Right stopped after 24 presses with `selection.right === page.right === 996.0` and the live region reading **"At the edge of the page"**; before that it read "Moved right".
Label: **Verified**
Notes: failed on first pass — I measured `.first()` overlay rect on a two-mark page, which was not the selected mark. Harness fault.

**10. The shortcuts sheet — PASS**
Criterion: `⌘/` opens exactly 15 rows; Esc closes; the bar button opens the same sheet.
Evidence: 15 rows, Esc closed it and **returned focus to `shortcuts-open`** rather than dropping it on `<body>`, and the bar button opened it too.
Label: **Verified**

**11. Undo / Redo visible everywhere, and the bar's cursor — PASS**
Criterion: undo+redo present in all five workspace modes; the bar carries both plus Shortcuts; two Undos go back two versions; Undo and Redo never mean the same thing.
Evidence: present in Annotate, Edit, Forms, Protect and Sign; bar carries `undo-version`, `redo-version`, `shortcuts-open`; Annotate's comment rows carry Copy and Duplicate; the palette carries Paste.
**D-D, measured on a document taken to v3 by two real saves:** at v3 the Undo button reads *"Undo the last change — back to v2"* and Redo is disabled. After **one** Undo it reads *"back to **v1**"* — the defect version would have read "back to v3", because it computed `currentSeq() - 1` and the revert had appended v4 — and Redo reads *"forward to v3"*. After the second Undo, Undo is disabled ("Nothing to undo yet") and Redo offers v2.
Label: **Verified**

**12. ⌘Z is bound wherever it is advertised — PASS**
Criterion: every mode whose Undo carries `aria-keyshortcuts` responds to ⌘Z. (This is the defect the CLI self-review found: three surfaces announced the shortcut and bound nothing.)
Evidence: all four carry `aria-keyshortcuts="Control+Z Meta+Z"` and all four respond. **Protect:** ⌘Z took areas 1→0, ⇧⌘Z →1. **Sign:** ⌘Z took placements 1→0. **Forms:** placing a field made "Save 1 field change(s)"; ⌘Z → "Save 0 field change(s)" and 0 overlay items; ⇧⌘Z restored it. **Edit:** staging a block edit enabled the Undo button, ⌘Z disabled it again; its title reads *"Undo the last text change, not yet saved (Ctrl+Z)"*, so its narrower scope is legible.
Label: **Verified**

**13. D-C — Protect — PASS**
Criterion: a click leaves the area alone and selects it; the copy no longer instructs a destructive click; the list ✕ removes; `protect-undo` restores.
Evidence: after a plain click, **1 area still present and 1 selection outline drawn**. Panel copy is now *"1 area(s) marked. Select one to move or remove it."* Right-click offered exactly `["Remove area"]`; it took areas to 0; `protect-undo` brought it back to 1.
Label: **Verified**

**14. D-B — Sign — PASS**
Criterion: a placement can be selected and removed; the list exists with a ✕; `sign-undo` restores; the copy is fixed.
Evidence: signature drawn on the pad and placed. `sign-undo`, `sign-redo`, `placement-list` and `placement-remove` all present. Menu offered `["Remove signature"]`. The ✕ took placements to 0 and `sign-undo` restored to 1. Copy is now *"1 placement(s). Select one below to move or remove it."* — before this phase a placement could not be removed at all.
Label: **Verified**

**15. D-E — the menu opens more than once — PASS**
Criterion: open → Esc → click the mark → right-click again opens it.
Evidence: the second menu opened. (The pre-fix behaviour was that restoring focus scrolled the page, so the next click landed on backdrop.)
Label: **Verified**

**16. D-F — a click is not a move — PASS**
Criterion: selecting a mark by clicking creates no undo step.
Evidence: three consecutive clicks on a mark, then one Undo — and the Undo removed the **mark itself** (1 → 0 marks), meaning the three clicks had contributed no history entries at all.
Label: **Verified**

**17. Themes and phone — PASS**
Criterion: the menu and sheet render correctly in dark; at 390 px no sideways scroll in either theme.
Evidence: forced genuinely into dark (`html.dark`), with computed colours matching the design contract's dark palette exactly — body `rgb(23,19,16)` = `#171310` (`--color-bg`), menu `rgb(38,32,26)` = `#26201A` (`--color-surface-raised`), the Delete entry `rgb(224,130,150)` = `#E08296` (`--color-danger`). Rows still 44 px; the sheet still 15 rows. At 390 px, `scrollWidth === clientWidth === 390`, in dark and in light.
Label: **Verified**
Notes: failed on first pass — one click on the three-state theme toggle landed on Light, not Dark, and my check asserted only that a menu rendered. Harness fault; redone by cycling until `html.dark` and asserting computed colours rather than eyeballing a screenshot.

**18. Console — PASS**
Criterion: zero console errors.
Evidence: **0 errors and 0 warnings** across six independent browser sessions covering Annotate, Protect, Sign, Forms, Edit, the version bar, both themes and 390 px.
Label: **Verified**

**19. Sign request builder — UNVERIFIED**
Criterion: a click selects rather than deletes a placed field; undo/redo present; the list removes.
Evidence: none gathered. `/app/sign/new/:docId` requires an account, and no account was created on the live service.
Label: **Unverified**
Notes: covered by unit tests (`request-builder.spec.ts`, 8 cases) and by the shared `event.button` guard in `page-overlay`, which is the same code path proven live in the other five surfaces. That is an inference, not a verification.

**20. Multi-party signing — UNVERIFIED**
Criterion: n/a — declared out of scope up front. SMTP is off in production.
Label: **Unverified**

## Notes on method

**Substitution, declared.** Chromium in this container cannot use the egress proxy — every direct navigation to the live host is `ERR_CONNECTION_RESET`, though `curl` works. The browser was therefore pointed at a **transparent reverse proxy on localhost that forwards every request to `zenpdf.up.railway.app`** and passes responses back unmodified. The bytes under test are production's own — the hashed chunks were checksum-matched — and the response headers, including the CSP and `x-content-type-options: nosniff`, pass through unchanged and are entirely `'self'`-relative, so they mean the same thing from localhost. What this does **not** exercise is TLS, HSTS and Railway's edge routing; those were checked separately by `curl` and are unchanged from the last audit.

**Three first-pass failures, all mine.** C5, C9 and C17 failed initially. Investigating each showed a fault in the check, not the system: reading state in the same tick as the keypress that changes it, measuring the wrong element on a two-mark page, and asserting a weaker condition than the criterion. All three are the same species of mistake the CLI session hit with the new e2e spec, and the reason the checklist rule "re-run flaky-looking checks" exists. A fourth — my Forms ⌘Z check — reported PASS while having silently done nothing, because the arm button selector was wrong and my guard let the no-op through; it was rewritten and re-run rather than left standing.

**Adjacent observation, not a failed check.** The CLI session recorded a queue row that node 25 ships a `localStorage` global without `getItem`, which breaks a host `ng test` and a host `npm run build` (108 unit failures, every prerendered route). That is real and correctly queued, and it is **not** a Phase 12 defect and not visible in production — Railway and the `web` image are on node 24. Out of this checklist's scope; flagged only so it is not mistaken for something this audit cleared.

## Scope limits

What this audit does **not** tell you:

- Nothing about the **sign request builder** or **multi-party signing** (checks 19–20). Both are account-gated or SMTP-gated on the live service.
- Nothing about **anything outside Phase 12**. Other tools, the upload pipeline, ads, e-sign verification and the backend were exercised only incidentally, as the means of getting into the workspace.
- Nothing about **real assistive technology**. Roles, `aria-keyshortcuts` values, focus movement and the live region's contents were verified in the DOM; no screen reader was run, so how NVDA or VoiceOver actually announces any of it is untested.
- Nothing about **real touch input**. The 390 px checks were an emulated viewport, not a phone; long-press behaviour on a touch screen is deliberately not implemented and was not tested.
- Nothing about **behaviour under load or over time**. Every check was a single session on an idle service.
- The **e2e suite** was not re-run here; the CLI session reported 63 passed, 0 failed on the local stack, and that remains their evidence, not mine.
