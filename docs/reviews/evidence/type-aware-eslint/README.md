# Evidence — type-aware ESLint and `apiError()` (2026-08-24)

Branch `chore/type-aware-eslint` (prompt 7). This change is meant to alter **no** behaviour,
so the browser pass is not a tour of new UI — it is five error paths that go through
`core/api-error.ts`, checked against what they said before. Everything here was taken
against the local stack with the Chrome DevTools MCP tools, both themes, 1280 px and 390 px,
console read after each.

**The thing worth checking is which sentence appears.** At four of these five screens the
server writes the copy and the component only supplies a fallback. So a screen showing the
*server's* wording is proof the §6 envelope was read; a screen showing the component's
fallback would be proof it was not — which is exactly the regression
`instanceof HttpErrorResponse` caused mid-branch, and exactly what `workspace-error.spec.ts`
caught.

| Screen | Server's sentence | Fallback it did **not** fall back to |
|---|---|---|
| `/app/doc/00000000-…` | "We could not find that. It may have been deleted, or it may belong to a session that has ended." | "That document could not be found." |
| `/merge-pdf`, non-PDF | "Not a PDF (missing %PDF header)." | "Something went wrong. Try again." |
| `/auth/login`, wrong password | "No active account found with the given credentials" | "Invalid email or password." |
| workspace, 429 | "Request was throttled. Expected available in 60 seconds." | "That document could not be opened." |

## 1 — A guest hits a 429, and the countdown runs

| File | What it shows |
|---|---|
| `01-workspace-throttled-light-1280.png` | the throttled workspace: the server's sentence, the `workspace-throttled` copy, and **"Try again in 54s"**, disabled |
| `01b-workspace-throttled-dark-1280.png` | the same at **40s** — the countdown is live, not a static string |
| `01c-workspace-throttled-dark-390.png` | 390 px, dark |
| `01d-workspace-throttled-light-390.png` | 390 px, light, at **29s** |

This is the whole `retryAfter` path: `Retry-After`/`details.retry_after_seconds` →
`apiError()` → `ViewerFacade.describe()` → `Workspace.retryIn()` → the disabled button.

**How it was staged, and why the obvious way does not work.** `THROTTLE_GUEST` was lowered
to `2/min` in `infra/.env` and `api` recreated (restored immediately afterwards, and
verified restored: five consecutive 200s at `240/min`). Simply hammering the workspace gets
you a 429 **with no wait in it** — the screen renders, the countdown does not:

```
{"error":{"code":"throttled","message":"Request was throttled.","details":{}}}   # no Retry-After header
```

That is DRF, not this change: `SimpleRateThrottle.wait()` returns `None` once
`available_requests <= 0`, and `Throttled`'s message drops the "Expected available in N
seconds" clause when it does. `main` renders that case identically — `Number(undefined)` is
`NaN`, which was never finite either. To see the countdown you need the **first** refusal,
so: wait 65 s for the window to roll over, spend exactly two requests with `curl`, then
reload — the document `GET` is then refusal #1 and carries `Retry-After: 60`.

Measured directly, which is what pins the distinction:

```
req 1: 200  [no Retry-After]
req 2: 200  [no Retry-After]
req 3: 429  [Retry-After: 60]  {"…","details":{"retry_after_seconds":60}}
req 4: 429  [Retry-After: 60]
```

## 2 — `/app/doc/00000000-0000-0000-0000-000000000000`

`02-doc-404-light-1280.png` · `03-doc-404-dark-1280.png` · `04-doc-404-dark-390.png` ·
`05-doc-404-light-390.png`

The 404 copy is unchanged, `role="alert"` is still on the container, and both ways out
("Try again", "Upload a file") are still offered.

Console carries the three expected 404s and one `[object HttpErrorResponse]`. The latter is
**pre-existing and not from this branch**: `ViewerFacade.loadVersions` subscribes with a
`next` and no `error`, so its 404 reaches the global handler. That code is untouched here.

*(Fixed 2026-08-25, `fix/api-error-followups`. Recording it here and doing nothing was the
wrong disposition — and the console noise turned out to be the smaller half. A failure of
this one request while the document itself loads left the **previous** document's versions
in the panel, offering "Revert to this" against version ids from a file the person had
navigated away from. `loadOutline`, three lines below, had handled its own error since the
day it was written.)*

## 3 — A non-PDF to `/merge-pdf` (415)

`06-merge-415-light-1280.png` · `07-merge-415-dark-1280.png` · `08-merge-415-dark-390.png` ·
`09-merge-415-light-390.png`

The site of `ToolPage.fail`, whose parameter was `{ error?: { error?: { message?: string } } }`
and is now `unknown`. Console: the two expected 415s, one per file, and nothing else.

## 4 — A wrong password

`10-login-401-light-390.png` · `11-login-401-dark-390.png` · `12-login-401-dark-1280.png` ·
`13-login-401-light-1280.png`

Inline, in `[data-test=login-error]`, in the server's words. Console: one 401.

## 5 — The claim flow

`14-claim-dashboard-light-1280.png` · `15-claim-dashboard-dark-1280.png` ·
`16-claim-dashboard-dark-390.png` · `17-claim-dashboard-light-390.png`

A guest merged two PDFs on `/merge-pdf`, then registered. This is the path whose navigation
changed — `next: () => { void this.router.navigateByUrl(this.next()); }`, a sync wrapper
where an arrow used to hand rxjs a promise. **The order of events did not change:**

- landed on `/app/dashboard`
- `zen_access` present, **`zen_guest` gone** — the guest token discarded on claim (§21.5)
- the banner reads **"3 files from your guest session are now saved to your account."**
- all three documents listed: `Merged — claim-one (+1)`, `claim-one`, `claim-two`
- **console completely clean**

## After the merge — production

`18-PROD-doc-404-1280.png` · `19-PROD-merge-415-1280.png`

Steps 2 and 3 repeated on <https://zenpdf.up.railway.app> once the deploy was live,
which was confirmed by the bundle hash rather than by a clock: production went from
`main-R6WL3ZXN.js` (the hash of a build of `main` taken before any of this work) to
**`main-XNN7UJ7I.js`** — byte-for-byte the same name the local production build produced,
so the deployed artefact is a build of this source and not a cached previous one. Both
screenshots carry that hash, read out of the served `<script src>`.

| Check | Production |
|---|---|
| `/app/doc/00000000-…` | "We could not find that. It may have been deleted, or it may belong to a session that has ended." · `role="alert"` · "Try again" · "Upload a file" — identical to local |
| non-PDF to `/merge-pdf` | "Not a PDF (missing %PDF header)." — identical to local |
| console | the two expected 415s, nothing else |

## Filed from this pass

One queue row, and it is a pre-existing backend observation rather than anything this branch
caused: **a guest who keeps retrying stops being told how long to wait.** The first refusal
carries `Retry-After`; later ones do not, so `workspace-throttled` renders its "nothing is
lost" copy beside a `Try again` button that is immediately pressable — which is precisely the
"press it and get the same message" loop the countdown was added to prevent. The frontend is
already correct for both shapes; the fix, if wanted, is server-side.

**Two other things this pass flagged were closed on 2026-08-25** (`fix/api-error-followups`,
PR #39 `9fbff95`), because a flag is not a disposition: the `loadVersions` observation above,
and `isApiError()`, which PR #38 shipped exported, tested and with no caller anywhere in the
app. See the PROGRESS session log "2026-08-25 — The two things PR #38 flagged and did not fix".

`20-PROD-doc-404-after-followup-1280.png` is the same production screen as
`18-PROD-doc-404-1280.png` after that deploy (`main-XNN7UJ7I.js` → `main-ZKRKLCOM.js`), and
the point of it is what is **no longer in the console**. Before: three 404s *and* an
`[object HttpErrorResponse]` from the unhandled `loadVersions` error. After: the three 404s
and nothing else. The screen itself is unchanged — same server sentence, same `role="alert"`,
same two ways out — which is the other half of what needed showing.
