# ZenPDF — agent instructions (repo-local)

Monorepo: `backend/` (Django 6), `frontend/` (Angular 22 + Tailwind CSS v4, signals, 3-layer core → abstraction → features, OnPush), `e2e/` (Playwright), `infra/` (full local stack via `infra/up.sh`), `development-plans/` (plan docs — `01-architecture.md` is normative; amend it when architecture changes), `development-plans/PROGRESS.md` (canonical execution tracker — it is **not** at the repo root), `docs/reviews/` (QA findings, status reviews and the CLI handoff prompts under `docs/reviews/handoffs/`, with `TRACKING.md` as their board), `docs/ops/` (runbooks; production is Railway — `docs/ops/railway.md`).

Local env quirks: `.env` overrides `API_PORT=8010`, `DB_PORT=15432`; Angular 22 needs Node ≥ 22.22.3. SSR is build-time prerender (`outputMode: static`) — verify with `npm run verify:prerender`.

## Design governance — read this before ANY UI or client-facing change

**Canonical design contract: `docs/design/design-instructions.md`.** Mockups in `docs/design/mockups/` are reference; where they disagree, the contract wins.

**The rule:** before you edit, add, remove, restyle, or rearrange ANY user-visible surface — Angular components, templates, styles, `index.html`, favicon/OG assets, error pages, UX copy, user-facing emails — read `docs/design/design-instructions.md` first and conform to it. This applies to one-line tweaks as much as to new screens.

The contract landed on 2026-08-06 and has been amended many times since — **§11's Amendment log is the register; this sentence deliberately does not carry the number.** *(Corrected 2026-08-23: it said "eight times", which was true when it was written and was wrong again one amendment later. The contract itself already made this mistake and fixed it — its grounding paragraph stopped counting sanctioned additions and started listing them, "because a count goes stale silently and a list does not". The same reasoning applies here.)* Its **Amendment log** (§11) is where a new amendment gets recorded, and the grounding paragraph at the top is where a new sanctioned addition gets listed. Both, in the same change. *(The bootstrap note that stood here until 2026-08-22 told you what to do if the contract did not exist yet, and pointed at `docs/design/claude-design-prompt.md`, which does not exist. The contract does. It is law.)*

Non-negotiables (hold even where the contract is silent):

- **Semantic tokens only.** Once the token layer exists, components never hardcode colors, shadows, radii, or font sizes — they consume the semantic CSS custom properties (Tailwind v4 `@theme`). New values go into the token layer, not inline.
- **Both themes, every time.** Every visual change must be implemented and visually verified in BOTH light and dark mode before it is done. Never remove, hide, or break the header theme toggle (Light / Dark / System, persisted, no first-paint flash).
- **Accessibility floor:** WCAG 2.1 AA contrast in both modes (≥ 4.5:1 body text, ≥ 3:1 large text/UI — including disabled states), visible `:focus-visible` ring, ≥ 44 px hit targets, `prefers-reduced-motion` respected (the global collapse in `frontend/src/tailwind.css` stays).
- **Ads:** only via `<app-ad-slot>` on exactly three surfaces (`landing`, `dashboard-rail`, `tool-result`), always with reserved height (zero CLS). Never on `/s/`, `/verify`, `/legal/`, `/app/doc`.
- **No dead affordances.** Every rendered button, link, or menu item must have a wired, working action in the current build — no placeholder/no-op controls, no "coming soon", and no debug-only controls in production templates. Don't design or implement UI for features that don't exist.
- **Don't break the contract with tests and SEO:** keep `data-test` attributes, routes and tool slugs, tool-page H1/SEO copy semantics, and legal / e-sign disclosure texts verbatim.
- **RTL-ready:** CSS logical properties (`padding-inline`, `margin-inline-start`, `text-align: start`) — no hardcoded left/right that would break a future Hebrew locale.
- **Gap rule:** if the contract lacks a pattern you need, extend `docs/design/design-instructions.md` in the same change (spec the pattern with both-mode token values), then implement it. Never improvise silently.

**Definition of done for UI work:** build + lint + unit tests pass, and the affected screens were checked in both themes at desktop and mobile widths.

## Working agreements

- Track execution in `PROGRESS.md`; architectural decisions go through `development-plans/01-architecture.md`.
- Anonymous-first is a product law (architecture §21): no login walls; ownership funnels through `apps/core/principals.py`.
- Frontend state via signals in facades (`app/abstraction/`); components stay presentation-only.

## Installable app (PWA)

Chrome offers *Install ZenPDF*; the design side is contract §5 *Installable app*. What an agent must not break:

- **Manifest:** `frontend/public/manifest.webmanifest`, linked from `src/index.html` (so every prerendered page carries it).
- **Worker:** `provideServiceWorker('zen-sw.js')` is in `src/main.ts`, **not** `app.config.ts`, because the prerenderer merges `app.config.ts` and has no `navigator.serviceWorker`. Browser-only providers go in `main.ts`'s `mergeApplicationConfig`.
- **`public/zen-sw.js` wraps Angular's `ngsw-worker.js`** and stops the fetch event for `/api/` and every other origin before Angular's listener sees it, so those requests run exactly as with no worker. Uploads and pdf.js range reads are not held inside a worker event, and cross-origin requests are not subjected to the worker's own CSP (`connect-src 'self'`). Keep it registered first and keep the rule that narrow.
- **`ngsw-config.json`:** `index` is `/index.csr.html`, because `outputMode: static` makes `index.html` the *prerendered landing page*, and serving that for every navigation would flash the landing page. **No `dataGroups`, ever**: `/api` is per-user. Verify on production that no `ngsw:*` cache holds an `/api/` key.
- **nginx:** `zen-sw.js`, `ngsw-worker.js`, `ngsw.json` and `manifest.webmanifest` have their own `no-cache` location **above** the long-cache asset regex, in both `frontend/nginx.conf` and `infra/railway/nginx.railway.conf`.
- **Icons:** `npm run icons:pwa` rasterizes `tools/pwa-icon*.svg` into `public/icons/` (committed). Changed artwork: **bump `ICON_VERSION`** in `tools/generate-pwa-icons.mjs`, which renames every file and rewrites the references. The script refuses to overwrite changed pixels under an existing name, because `/icons/*.png` is cached immutable for a year.
- **Updates:** `core/services/app-update.service.ts` reloads at the next navigation once a new version is ready, never on `/app/doc/*`, `/app/sign/new/*` or `/s/*`, and never while a dashboard upload runs. It also asks the worker to check at most every 15 min, since ngsw looks by itself only on a full page load or a worker restart. Silent by design: no prompt. A new unsafe route goes in `UNSAFE_URL` there.
- **Verify:** from `e2e/`, `node tools/pwa-check.mjs https://zenpdf.up.railway.app` must print an active `sw` (`script` ending `zen-sw.js`), `manifestErrors: []` and `installabilityErrors: []`, and exit 0. `beforeinstallprompt` never fires under automation, so the address-bar icon is confirmed in a real Chrome profile, not by editing the manifest.
