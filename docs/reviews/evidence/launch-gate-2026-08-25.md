# Launch-gate evidence — 2026-08-25

Produced by `docs/reviews/handoffs/handoff-to-cli-launch-gate-evidence.md` (prompt 8) on
branch `docs/launch-gate-evidence`. **No product code changed**; where this found a defect
it filed a queue row.

Text, not screenshots of terminals. The Lighthouse JSON and HTML sit beside this file.

---

## 1. Lighthouse

Lighthouse **13.4.1**, 2026-08-25. Reports: `lighthouse-*.report.{json,html}`.

| Page | Where | Form factor | Perf | A11y | Best practices | SEO |
|---|---|---|---|---|---|---|
| `/` | **production** | desktop | **100** | **100** | **100** | **100** |
| `/` | **production** | mobile | **94** | **100** | **100** | **100** |
| `/merge-pdf` | **production** | desktop | **100** | **100** | **100** | **100** |
| `/guides/how-to-merge-pdf-files` | **production** | desktop | **100** | **100** | **100** | **100** |
| `/app/dashboard` | local **production build** | desktop | **96** | **96** | **100** | **69** |
| `/app/dashboard` | local **dev server** | desktop | 65 | 96 | 100 | 66 |

Landing desktop metrics: FCP 0.5 s, LCP 0.6 s, TBT 0 ms, CLS 0, Speed Index 0.8 s.
Landing mobile LCP 2.6 s under Lighthouse's mobile throttling, which is the whole of the
6-point performance difference.

**Why there are two dashboard rows.** The dashboard cannot be measured on the deployed host
without logging a real account into the live service, which the prompt forbids. Measured
locally instead — and on the dev server it scores **65** for performance, which is not a
fact about the product: `ng serve` is unminified, unbundled and HTTP/1.1, and Lighthouse's
own `modern-http` insight attributes 1,030 ms to the last of those. Serving `frontend/dist`
behind the repo's **own `frontend/nginx.conf`** — the conf the Railway image uses — against
the local API, the same page scores **96**. Both are kept because the pair is the argument.

```bash
# how the production-build dashboard row was produced
docker run -d --name zenpdf-lh-nginx --network zenpdf_default -p 8099:80 \
  -v "$PWD/frontend/dist/zenpdf-web/browser:/usr/share/nginx/html:ro" \
  -v "$PWD/frontend/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine
# log in once into a persistent Chrome profile, then point Lighthouse at it:
npx lighthouse http://localhost:8099/app/dashboard --preset=desktop \
  --chrome-flags="--headless=new --user-data-dir=<profile>"
```

**Two things the dashboard does not score 100 on. Only one is a defect.**

- **SEO 69 is correct.** The sole failing audit is `is-crawlable`: `/app/dashboard` is
  deliberately not indexable (§7 — `/app/**` is client-rendered and has no SEO value). A
  criterion demanding ≥ 90 SEO on a noindex app route is asking for the wrong thing, and
  ticking it would require making the product worse.
- **A11y 96 is a real gap.** The sole failing audit is `target-size`, on all six document
  cards. Measured in the browser rather than taken on Lighthouse's word: the card's select
  checkbox (`[data-test=select-doc]`) is **17 × 17 px** and its ⋯ menu
  (`[data-test=doc-menu]`) is **28 × 28 px**, against the design contract's non-negotiable
  **≥ 44 px**. Queue row filed 2026-08-25.

---

## 2. Three consecutive full runs

Each run preceded by `./infra/reset.sh --yes && ./infra/up.sh` from a clean stack, and by
clearing virtiofs strays (see the note below). `./infra/test.sh --pg --e2e`.

| Run | Exit | Duration | pytest | `--pg` | Frontend unit | Playwright |
|---|---|---|---|---|---|---|
| 1 | **0** | 8m23s | 1164 passed, 6 skipped (86.3 s) | 6 passed, 1164 deselected | 66 files / 576 tests | **86 passed**, 1 skipped (5.0m) |
| 2 | **0** | 8m37s | 1164 passed, 6 skipped (105.7 s) | 6 passed, 1164 deselected | 66 files / 576 tests | **86 passed**, 1 skipped (4.7m) |
| 3 | **0** | 8m27s | 1164 passed, 6 skipped (103.6 s) | 6 passed, 1164 deselected | 66 files / 576 tests | **86 passed**, 1 skipped (4.5m) |

Coverage identical across all three: apps **91.54 %** (gate 85), pdf_engine **91.87 %**
(gate 90). The 6 pytest skips are the Postgres-only query-plan tests, which `--pg` then
runs — so nothing in the suite went unexercised. The 1 Playwright skip is the 404-status
test `ng serve` cannot express.

**Three consecutive fully green runs, with no flake to record.** The 2026-08-02 row's
`phase-3:43` flake did not appear in any of the three; the e2e-gate-hardening prompt's work
holds.

⚠ **The first attempt at these three runs aborted in 0 s each**, and the cause is worth
keeping: `infra/test.sh`'s stray-duplicate guard found
`backend/apps/core/tests/test_throttle_says_when 2.py` — a virtiofs duplicate of a file
created earlier the same day. The guard did exactly its job. It is blind in two other
places, which is a separate queue row (2026-08-25): it prunes `dist`, and its pattern
requires an extension, so a stray *directory* like `dist/…/assets/wasm 2` both escapes it
and breaks `ng build`'s output clean. The three runs above clear both shapes first.

### Cross-browser

`BROWSERS=all ./infra/test.sh --e2e`. **264 passed, 8 failed, 3 skipped across five projects,
20.2 min.** chromium and firefox **completely green**.

⚠ **The first attempt was worthless and is worth recording as a trap.** firefox and webkit
binaries were not installed on this machine, so **179 of 181 "failures" were
`Executable doesn't exist`** — a run that looks catastrophic and proves nothing. The numbers
above are after `npx playwright install firefox webkit`. `docs/ops/release.md` now names that
install as a prerequisite, because a nightly reporting 179 failures for a missing download
will be ignored by the second week.

The eight real failures split into two shapes, both first observations rather than
regressions, and both filed as queue rows:

| Engine | Spec | First error |
|---|---|---|
| webkit | `phase-10-a11y:137` ceremony by keyboard | **`[data-test=agree] is not reachable with the keyboard`** |
| webkit | `phase-10-mobile:315` | `toHaveCount` |
| webkit | `phase-7:157` search discards review list | `toHaveURL` |
| mobile-chrome | `phase-1:33` | `toHaveURL` |
| mobile-chrome | `phase-2b:16` | `page.click` timeout 20 s |
| mobile-safari | `phase-1:33` | `toBeVisible` |
| mobile-safari | `phase-2b:16` | `page.click` timeout 20 s |
| mobile-safari | `phase-8:91` | `toHaveURL` |

**The WebKit keyboard one is the serious one** and has its own row: the control it cannot
reach is the ceremony's **consent checkbox**, the single interaction the ESIGN disclosure is
about. It is *not yet* established whether that is our markup or WebKit's default of leaving
non-text controls out of the Tab order unless Full Keyboard Access is on — which is both a
real Safari behaviour and a known Playwright-webkit trap. The row says what has to be
checked in real Safari to tell them apart, and does not claim more than was seen.

**The five mobile failures point at the viewport, not the engine** — both mobile projects
fail the *same two* library-heavy specs, which drive dashboard controls the phone layout
moves, and which predate the phone workspace.

---

## 3. `@smoke` against production

```bash
cd e2e && BASE_URL=https://zenpdf.up.railway.app npx playwright test --grep @smoke
```

**5 passed, 2 failed — and both failures are environmental. Zero real.**

| Spec | Result | Classification |
|---|---|---|
| `phase-0` register/login/session guard | ✅ | — |
| `phase-1` upload, view, search, rename, trash, restore | ✅ | — |
| `phase-2b` guest merges, registers, keeps the files | ✅ | — |
| `phase-10-a11y` public pages, no serious a11y failures | ✅ | — |
| `phase-8:91` guest signs from `/sign-pdf`, no login | ✅ | **was environmental on 2026-08-21; now passes in-suite** |
| `phase-8:135` two signers, sealed, certified, verifiable | ❌ | **(a)** polls Mailpit on `localhost:8025`, which production has no equivalent of while SMTP is off |
| `smoke-viewer` a cold guest opens a PDF and the page draws | ❌ | **(a)** the whole suite runs from one IP against production's real rate limiter |

**The `smoke-viewer` failure was classified, not assumed** — it is the spec that exists
because production once rendered nothing for ten days, so "probably environmental" would not
do. Its page snapshot at the timeout shows `/annotate-pdf` with the dropzone still reading
*"Drop PDFs here"*: the **upload** stalled and the viewer was never reached, which is not a
rendering failure. Run standalone against **production** it passes in **3.8 s** and prints
`canvas 1056×1494, 64 distinct colours` — production's viewer draws. Same mechanism that hit
`phase-8:91` on 2026-08-21.

**Both (a) specs re-run against the local stack to prove the specs are sound:**
`smoke-viewer` ✅ 2.7 s, `phase-8:135` ✅ 9.3 s.

---

## 4. The p95

`infra/perf/`, profile-gated, throttles off for the run and **restored immediately after**
(verified: `THROTTLES_DISABLED=false`, `THROTTLE_GUEST=240/min`). Local stack, seeded
four-document library, 50 users, spawn rate 10, 2 minutes.

**All six §10.2 endpoints PASS against the 150 ms budget.** 3079 requests, **0 failures**
(the locustfile aborts on any 429 — a p95 over rate-limit rejections is not a p95).

| Endpoint | n | p95 |
|---|---|---|
| `GET /api/config/` | 626 | **9 ms** |
| `GET /api/documents/` | 738 | **12 ms** |
| `GET /api/documents/{id}/versions/` | 153 | **10 ms** |
| `GET /api/jobs/` | 1072 | **9 ms** |
| `GET /api/sign-requests/` | 142 | **6 ms** |
| `GET /api/users/me/usage/` | 278 | **11 ms** |

Aggregated p95 18 ms, max 154 ms, 25.7 req/s.

**The production p95 is still owed, and this run does not supply it.** It is a laptop
running `manage.py runserver` against a four-document library — it proves the *shape* and
the query plans, not the figure. The production run needs `PERF_EMAIL` pointed at a real
account on the live service plus a decision to aim a load generator at it; there is no
`PERF_EMAIL` in `infra/.env`, and `docs/ops/launch-handoff-owner.md` item 8 lists that run
as the **owner's**. Not run, and not simulated.
