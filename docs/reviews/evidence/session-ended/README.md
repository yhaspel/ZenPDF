# Evidence — a session that ends now says so (2026-08-24)

Branch `fix/session-ends-out-loud`. Taken against the local stack with the Chrome DevTools
MCP tools, by giving a real signed-in session a credential the server refuses and no
refresh token to spend — the state that genuinely ends a session.

| File | What it shows |
|---|---|
| `01-public-light.png` | `/merge-pdf`, light: the toast, and the page **still `/merge-pdf`** |
| `02-public-dark.png` | the same in dark |
| `03-gated-dark.png` | `/app/dashboard` → **`/auth/login?next=%2Fapp%2Fdashboard`** — "Welcome back", with the toast saying why |

## What was measured

**The toast**, light mode: text `rgb(51, 45, 36)` (`--color-ink`) on the raised surface
with a `rgb(111, 102, 86)` (`--color-ink-faint`) inline-start spine — §3's info toast
exactly, ink on paper with a coloured rule, no fill. `role="status"`, which is what §3
requires for anything that is not an error.

**The two halves of the behaviour:**

| where the session dies | before | after |
|---|---|---|
| `/merge-pdf` (public) | silent; token gone; header changes with no explanation | toast; **stays on `/merge-pdf`**; token cleared |
| `/app/dashboard` (gated) | silent, then `/auth/register` at the next click — as a stranger | toast + **`/auth/login?next=%2Fapp%2Fdashboard`** |

The public case is the one §10 cares about: every public route works without an account,
so redirecting there would have been the login wall the contract forbids. The gated case
is the one the person cares about: they *had* an account, so they get **login**, carrying
`next` to land back where they were — not the register page's "here is what an account is
for".

## Not shown here, because it is deterministic in the suite

- `phase-10-debt.spec.ts` — the same two scenarios, asserted.
- `account.guard.spec.ts` — parses `app.routes.ts` and fails if `ACCOUNT_GATED_PREFIXES`
  ever disagrees with the routes `accountGuard` is actually applied to, so the second
  reader of that list cannot go stale.
- `auth.facade.spec.ts` — the toast fires once however many requests report the same 401.
