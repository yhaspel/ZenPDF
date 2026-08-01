# Phase 2B — Anonymous Access (guest sessions)

**Goal:** the whole product works with **no account**. A visitor lands on a public tool page, drops a PDF, gets a result, and downloads it — never seeing a login form. Accounts become an upgrade (persistent library, higher limits, sending signature requests), and signing up *claims* the work already done.

**Inserted 2026-07-31** between Phase 2 and Phase 3 (owner decision — see 01-architecture §21, normative). Numbered `2B` deliberately so phases 3–10 keep their numbers and every existing cross-reference stays valid.

Depends on: Phases 0–2 (complete). Conventions: 01-architecture §§9, 11, 13, 16, **21**.

## Why this phase exists, and why *here*

The gate contradicts the business model: revenue is advertising, ad revenue scales with sessions, and a login wall in front of "merge PDF" converts search traffic into competitors' traffic (§21.1).

It runs *before* Phase 3 because every remaining phase adds ownership-coupled code. The principal refactor touches ~every queryset in `documents`, `jobs` and `core`; doing it now costs one focused phase, doing it after Phase 8 is a rewrite across eight phases of accumulated `filter(owner=request.user)`.

## Backend

### Models (§9)
- **`core.GuestSession`** — new (fields per §9). Token stored **hashed**; raw token never persisted.
- **`documents.Document`** — `owner` → nullable; add `guest_session` FK null, `expires_at` null; `CheckConstraint` exactly-one-of(owner, guest_session).
- **`jobs.Job`** — `user` → nullable; add `guest_session` FK null; same constraint.
- **`core.UsageCounter`** — repoint to principal (nullable user + nullable guest_session, one-of); add `heavy_ops`.
- Unchanged (account-only): `Folder`, `SavedSignature`, and all of `esign`.

Migrations must be **backfill-safe**: existing rows all have `owner` set, so the constraint holds on day one. Verify idempotent-from-zero *and* forward-from-current-dev-data.

### The choke point
`apps/core/principals.py` — `owned_by(qs, principal)` / `assert_owned(obj, principal)` / `principal_of(job)` / `owner_kwargs(principal)` (§21.2). Every existing ownership expression in `documents`, `jobs` and `core` migrates to it.

**The worker layer is the easy thing to miss, and the dangerous one.** Ownership in Celery tasks flows through `job.user`, not `request.user` — `documents/tasks.py` does `Document.objects.get(id=…, owner=job.user)` (split/merge/alternate_mix source lookups) and `_create_document_from_bytes(owner=job.user, …)` (every op that produces new documents). For a guest job `job.user is None`, which fails two ways:

1. creating a document with `owner=None` **and** `guest_session=None` violates the new exactly-one-of `CheckConstraint` → `IntegrityError` on every guest split / merge / extract / alternate_mix / convert — i.e. precisely the `/merge-pdf` and `/split-pdf` pages this phase exists to ship;
2. `filter(owner=None)` compiles to `owner_id IS NULL`, so the worker-side ownership re-check silently degenerates into "*any* guest's document with that id" — a cross-tenant read.

**The grep test must therefore cover `request.user`, `job.user` and `owner=` — not `request.user` alone**, and fail the build on any occurrence outside `principals.py`. A test scoped to `request.user` passes while both bugs above are live.

### Storage accounting & quota call sites (currently User-only)
`GuestSession` has its own `storage_bytes_used` (§9), but the built code writes only the `User` row: `documents/services.py` (ingest bump), `documents/tasks.py::_bump_storage(user_id, …)` and its call sites, `documents/views.py` (quota read `user.storage_bytes_used`, decrement on permanent purge). Left alone, `_bump_storage` becomes `UPDATE users … WHERE id IS NULL` — a silent no-op that makes the 200 MB guest cap unenforceable. All of these move to the principal.

### Limits not currently enforced at all
- **`MAX_PAGES` is never checked.** It exists in `settings` and in the `/api/config/` payload, but `services.ingest_pdf` never inspects `info["pages"]`. §17 describes a page cap in the upload chain that does not exist. **2B adds it** (tier-resolved: 300 guest / 2000 free) — it is not a re-route of existing code.
- **`_check_concurrency` uses the global `settings.MAX_CONCURRENT_JOBS`** (`documents/views.py`); it becomes tier-resolved (1 / 3 / 6, §16).

### Auth & permissions
- `PrincipalAuthentication` (DRF): JWT first, else `X-Guest-Token`, else anonymous-no-principal.
- `IsPrincipal` becomes the default permission; `IsAccount` marks account-only endpoints → 403 `account_required`.
- Lazy minting on first write; new token returned in the `X-Guest-Token` response header (§21.2).
- Expired guest token → 410 `guest_expired` (distinct from 404 — the client must be able to tell "your session ended" from "not yours").

### Tiered limits
`core/limits.py` → `for_principal(principal) -> Limits`, backed by `settings.TIERS` (guest / free / pro per §16). Every quota check in ingest, operations and jobs routes through it. `pro` is config-only — **no billing, no purchase path, no upgrade UI** (§21.7). `User.plan` field added, default `free`, admin-settable only.

### Endpoints
| Method/Path | Behavior |
|---|---|
| `POST /api/guest/session/` | mint (or inspect current) guest session → `{id, expires_at, limits}` |
| `POST /api/guest/claim/` | authenticated: transfer this guest token's documents/jobs to the account |
| `POST /api/users/register/` · `POST /api/auth/login` | accept optional `X-Guest-Token` → claim inline on success. ⚠ The built register route is `/api/users/register/`, **not** `/api/auth/register/` — the frontend interceptor already matches on it |
| `GET /api/config/` | now returns **the current principal's** tier limits + `guest_access_enabled` |
| `GET /api/users/me/usage/` | works for a guest principal too (session storage, ops used, time remaining) |

Claim is metadata-only reparenting in one transaction, idempotent, with a pre-flight quota check that reports overflow rather than partially claiming (§21.5). It moves **documents, jobs and usage counters** — not documents alone. Leaving jobs behind means a user who registers mid-operation loses the poll on the very file they signed up to keep; leaving counters behind lets a monthly quota be reset by laundering work through a guest session. After a successful claim the **client discards its guest token** and the session is expired server-side (replays → 410 `guest_expired`), so `guest_purge` can never cascade into rows the user now owns.

### Retention
Beat `guest_purge` hourly → hard-delete expired sessions and every artifact they own (documents, versions, thumbs, exports, blobs). No trash for guests.

### Abuse controls (moved forward from Phase 9 — they are load-bearing now, not polish)
Guest throttles keyed on `(guest_token, ip_hash)` with the stricter winning; Turnstile challenge once per session before the first **`METERED_OPS`** operation only, behind `CAPTCHA_ENABLED` (off in dev); tier caps bound worst-case compute; **no anonymous party can ever choose a recipient address** (creating/sending sign requests is account-only — the precise invariant, since Phase 8 legitimately mails fixed addresses on ceremony actions). Full rationale in §17.

**⚠ `METERED_OPS = {ocr, convert_from, convert_to, compare}` is NOT the `heavy` queue.** The queue also holds `merge`, `alternate_mix`, `compress` and `repair` — flagship tool pages that must never be metered or challenged. Implementing the cap or the CAPTCHA off `op.queue` would put a CAPTCHA in front of a guest's first merge, which is the exact outcome §21.1 exists to prevent. Short windows (per-hour/per-day) are **Redis scoped-throttle counters**; `core.UsageCounter` is month-granular only (§9, §16).

## Frontend

- **`GuestFacade`** — holds the token, exposes `principal()` (`'guest' | 'user' | null`), `expiresAt()`, `limits()`. The HTTP interceptor attaches JWT *or* `X-Guest-Token`, and captures a returned token on first write.
- **Two credential paths bypass the interceptor and must be handled explicitly** (both already exist in the built code): `features/workspace/workspace.ts` builds an `authHeaders` object fed to ngx-extended-pdf-viewer's `httpHeaders` input — the viewer fetches outside `HttpClient`, so interceptors never run; and `shared/pdf-thumbnail.ts` exists precisely because an `<img>` tag cannot carry a JWT. Both need an `X-Guest-Token` branch, or guests get a working workspace with a blank viewer and no thumbnails.
- **401 handling** — the existing interceptor's `401 → refresh → redirect /auth/login` must fire only for a **JWT** principal. A guest 401 means the session expired: clear the token, mint a fresh one on next write, show an inline "your files expired" notice. Redirecting a guest to a login form reinstates exactly the wall this phase removes.
- **After claim, discard the guest token** and use the JWT alone (§21.5).
- **Guards** — the app-wide auth guard is **removed**. `accountGuard` now protects only `/app/dashboard`, `/app/sign*`, `/app/settings`. `/app/doc/:id` renders for either principal. Rejections route to `/auth/register?next=…&reason=…` with the reason rendered as human copy, never a bare wall.
- **Public tool pages** (§21.6) — Phase 2's seven slugs land here: `/merge-pdf` `/split-pdf` `/compress-pdf` `/rotate-pdf` `/delete-pdf-pages` `/extract-pdf-pages` `/organize-pdf`. Each is SSR/prerendered, is itself the working tool (dropzone above the fold → job → download in place → "open in workspace"), and carries its own title/meta/H1/FAQ JSON-LD. `sitemap.xml` generated from the route table.
- **`@angular/ssr`** added; `/app/**`, `/s/:token`, `/verify` stay client-rendered.
- **Guest workspace affordances** — session banner with time remaining (calm, not alarming) + "Create a free account to keep these files"; `account_required` errors render as an inline upgrade prompt explaining what the account unlocks.
- **Signup/login** send the guest token; on success the claimed documents appear in the new library — the payoff moment must be visible, not silent.

## Infra
No new services. New env block per §19 (`GUEST_*`, `CAPTCHA_ENABLED`, `TURNSTILE_*`, `GUEST_IP_HASH_SALT`). `seed_dev` gains an expired-guest-session fixture so `guest_purge` is exercisable locally.

## Tests
**⚠ Superseded existing tests/criteria — update, do not silently break:** `phase-00` acceptance "`/app/**` redirects unauthenticated users" (now: only the three account-only routes redirect) and `backend/apps/core/tests/test_core.py::test_error_shape_on_unauthenticated`, which asserts `GET /api/documents/` → **401** for an anonymous client; under `IsPrincipal` an anonymous read is no longer an auth error. Rewrite both deliberately as part of this phase.

**Backend:** guest mint on first write (not on read); every document/job endpoint reachable as a guest; **worker-path ownership** — a guest-owned split/merge/extract/convert job creates documents owned by the *same* guest session and cannot read another session's source document (this is the `job.user is None` trap above, and needs its own test, not just the grep test); **router-wide guest isolation fixture** (guest A ↛ guest B, guest ↛ user, user ↛ guest — mirroring `test_isolation.py`); expired token → 410 not 404; grep-test asserting no ownership check references `request.user` outside `principals.py`; tier limits enforced at exact boundaries for guest vs free; guest upload over 25 MB → 413, over 300 pages → rejected; heavy-op hourly cap; throttle key falls back to IP when the token rotates; `guest_purge` deletes rows **and** blobs (assert storage empty); claim transfers everything, is idempotent, and refuses cleanly when it would overflow quota; sign-request creation as guest → 403 `account_required`; no email sent on any guest path.
**Frontend:** GuestFacade token capture/persistence; interceptor picks the right credential; `accountGuard` allows guest on `/app/doc/:id` and redirects with a reason on `/app/dashboard`; tool page renders and completes a merge with no auth state.
**E2E (`phase-2b.spec.ts`):** cold browser, no account → land `/merge-pdf` → drop 2 PDFs → merged file downloads → "open in workspace" → rotate a page → register → **claimed documents appear in the library** → log out → log back in → still there.

## Acceptance criteria
- [ ] A cold browser with no account completes merge, split, compress, rotate, delete-pages, extract and organize end-to-end from the public tool pages, and downloads the results — with zero login prompts in the path.
- [ ] `/app/doc/:id` is fully usable as a guest; only `/app/dashboard`, `/app/sign*`, `/app/settings` redirect, and each redirect states *why*.
- [ ] Guest isolation proven router-wide by tests (guest↛guest, guest↛user, user↛guest); expired token yields 410 `guest_expired`.
- [ ] No ownership check outside `apps/core/principals.py` references `request.user` (proved by test, not by review).
- [ ] Guest tier limits enforced at their boundaries; exceeding yields the standard error shape with copy that names the account upgrade.
- [ ] `guest_purge` hard-deletes an expired session's rows *and* its storage blobs; nothing orphaned.
- [ ] Register-from-guest claims every document in one transaction; over-quota claim is refused whole with an itemized message.
- [ ] **no code path lets an anonymous party choose a recipient address** (system mail to addresses already fixed by an account-owned request is expected and allowed). ⚠ *Amended 2026-08-01:* the positive half — "sign-request creation as a guest returns `account_required`" — is **verified in Phase 8**, because sign requests do not exist until then. 2B lands the enforcement primitive (`IsAccount` → 403 `account_required`) and a standing test that fails the build if a recipient-address route ever appears without it.
- [ ] ⚠ *Deferred to Phase 8 (amended 2026-08-01).* A guest can complete a `self_sign` using an ephemeral uploaded/drawn signature (`signature_upload_ref`, §10) without a `SavedSignature` row. The `self_sign` operation is Phase-8 work and is absent from this phase's own Backend/Frontend scope sections above; 2B makes it guest-accessible *by construction* (`IsPrincipal` is the default permission, so a new op is guest-reachable unless it declares `IsAccount`) and §10 already records `signature_upload_ref`. Nothing here can be demonstrated until the op exists.
- [ ] `MAX_PAGES` is enforced at ingest for both tiers (it was not enforced at all before this phase).
- [ ] All seven Phase-2 tool pages are server-rendered with unique title/meta/H1 and appear in a generated `sitemap.xml`; `robots.txt` disallows `/app/`, `/s/`, `/api/`.
- [ ] Existing Phase 0–2 acceptance criteria still pass for authenticated users (no regression from the refactor), **except the two listed as superseded under Tests above**, which are rewritten in this phase rather than re-ticked as written.

## Risks
- **Refactor blast radius** — ownership touches nearly every queryset. Mitigated by funnelling through one module and by the grep-test that fails the build if a call site is missed.
- **Anonymous compute abuse** — the login wall was doing free abuse filtering. Mitigated by §17's layered controls; the Turnstile flag exists so it can be tightened without a deploy of new code.
- **Storage growth from guests** — bounded by the 200 MB/session cap × hourly purge. Watch actual numbers before launch; `GUEST_TTL_HOURS` is the tuning knob.
- **SSR added mid-project** — `@angular/ssr` on an existing zoneless v22 app can surface hydration mismatches in the viewer. Mitigation: tool pages are SSR'd, the viewer/workspace is explicitly **not** — the split is deliberate, not incidental.
