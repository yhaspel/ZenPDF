**Executed 2026-08-24 — 11B/11C landed; 11A/11D/11E remain owner-gated (see PROGRESS §Phase 11). Historical.**

# Handoff — Phase 11, the half that needs no domain: contact, identity, twelve guides, the floors, and a one-line cutover (2026-08-21, revision 2 after Phase 12)

**For:** Claude CLI on the Mac in `~/Documents/Claude/Projects/ZenPDF`.
**Branch:** `feat/phase-11-guides-and-contact`. **Depends on:** `handoff-to-cli-docs-reconciliation.md` merged (it rewrites the design contract's sanctioned-additions sentence into the real dated list, which this phase extends) and `handoff-to-cli-e2e-gate-hardening.md` merged (host-side `ng test`/`ng build` on this node-25 Mac).
**Source of truth:** `development-plans/phase-11-adsense-review.md` (the work order — 11B, 11C in full; 11A only as parameterisation), `docs/reviews/status-review-2026-08-21.md` §2 (Phase 11 row) and §5; PROGRESS status table row 11.
**Deploys on merge?** Yes — frontend (`web` rebuilds). The new pages go live on the Railway host immediately; that is fine — they are honest content with ads dark.

---

```text
You are implementing the part of Phase 11 that does not depend on the owner buying a
domain: 11B (contact + identity), 11C (the editorial layer), the mechanical quality
floors, the tool-page top-up, and the design-contract amendment those require. 11A
(domain cutover), 11D (indexing bake) and 11E (the application loop) stay owner/calendar
work — you only make 11A a one-line change for the day the domain exists.

Read, in order: AGENTS.md; docs/design/design-instructions.md — all of it, it is law and
you are amending it at four sites; development-plans/phase-11-adsense-review.md — the
work order, every line; development-plans/01-architecture.md §21.6 (public surface) and
§20 (DoD); docs/09-adsense-readiness.md; docs/reviews/status-review-2026-08-21.md §2 and
§5; the newest PROGRESS entries. Then the code: frontend/src/app/core/tool-pages.ts,
core/site.ts, app.routes.ts, app.routes.server.ts, features/legal/*, shared/site-footer.ts,
tools/seo.mjs, tools/generate-seo.mjs, tools/verify-prerender.mjs, core/seo-artifacts.spec.ts,
core/tool-pages.spec.ts.

## 0. Preflight

    cd ~/Documents/Claude/Projects/ZenPDF
    git status --porcelain && git switch main && git pull --ff-only origin main
    ./infra/up.sh && docker compose -f infra/docker-compose.yml restart worker-default worker-heavy worker-render beat
    git switch -c feat/phase-11-guides-and-contact

TRACKING: in docs/reviews/handoffs/TRACKING.md set row 5 to
`🔵 in progress — `feat/phase-11-guides-and-contact`, <today>` (Status column) and put the branch name in
the next column; include that edit in your FIRST commit on the branch. Touch no other row.

PROGRESS: set Phase 11 to 🔵 with today's date; copy its Acceptance criteria verbatim
into a new phase section (protocol step 2); note in the section that 11A/11D/11E are
owner-gated and which criteria this branch can and cannot tick.

## 1. First commit — the contract amendment (gap rule: spec before UI)

docs/design/design-instructions.md, exactly the four sites the phase banner names:
- grounding (:5): the dated list of sanctioned additions (as rewritten by the
  docs-reconciliation prompt — theme toggle, landing filter, the Undo/Redo family, Phase
  12's context menu, shortcuts sheet and rail lists) gains `/contact`, `/guides` and
  `/guides/<slug>`;
- §3 Footer: the seven-link set (About · Privacy · Terms · E-sign disclosure · Verify a
  signed PDF · Contact · Guides) — order, separators, wrap behaviour at 390 px; the
  **ceremony footer stays verbatim** and the legal pages' in-page crosslink row is
  unchanged;
- §4: two new screen entries — guides index and guide article — on the legal pages'
  640 px reading-column pattern, with `Article` byline "the ZenPDF team", a related-tools
  link block (reuse the tool-card tokens, do not invent a new component), dates in the
  product's format; both themes; RTL-safe logical properties;
- §10 invariants: routes + footer invariants updated.
Also amend 01-architecture.md §21.6 (guides and `/contact` join the prerendered surface;
sitemap priorities 0.6 for guides) and README's index row text if needed. Commit:
`docs(design): phase 11 — contact, guides and the seven-link footer enter the contract`.

## 2. 11B — contact and identity

Follow the work order literally; the traps it already names are real:
- `core/site.ts`: add `SUPPORT_EMAIL` beside `SITE_URL`. Until the domain exists the
  owner has no `support@<domain>` — **stop and ask me for the address to use** if it is
  not in the repo or in `infra/.env.example`; do not invent one. (A `mailto:` to the
  owner's existing address is acceptable for now; the cutover prompt replaces it.)
- `features/legal/legal-page.{ts,html}`: extend `LegalKind` with `'contact'`; add the
  title/meta entry (**the map throws on a missing key**); add `@case ('contact')`, and
  convert About from `@default` to an explicit `@case ('about')` so unknown kinds fail
  loudly; About gains the "who runs this" paragraph linking `/contact`. No form (SMTP is
  off — P5). Layout: reading column, not `.sheet`.
- Routes: `app.routes.ts` + `RenderMode.Prerender` entry in `app.routes.server.ts`,
  both **before the `'**'` catch-alls**; `'contact'` added to `CONTENT_PAGES` in
  `tools/seo.mjs`; `seo-artifacts.spec.ts` pins updated in the same commit.
- Footer: `shared/site-footer.ts` gains Contact and Guides (`data-test="footer-contact"`,
  `data-test="footer-guides"` — additive). Ceremony footer untouched — add a spec that
  asserts it still has exactly its original links.

## 3. 11C — the editorial layer

- `core/guide-pages.ts`: `GUIDE_PAGES: GuidePageDef[]` with slug, title, metaDescription,
  h1, published/updated (fixed ISO strings), sections `{heading?, paragraphs[]}`,
  relatedTools: ToolKind[]. Slug lines formatted so `extractSlugs()` in `tools/seo.mjs`
  parses the file unchanged — read that function first.
- The twelve guides named in the work order (11C list), ≥ 700 words of body prose each,
  ≥ 3 sections, in the product's voice (contract §1), **every factual claim checked
  against the running system before you write it** — guest caps from
  `backend/config/settings/base.py` TIERS, retention from `core/retention.ts`, OCR
  languages from `engine/ocr.py`, what compression/redaction/flatten actually do from the
  engine modules and their tests. Guide 4 (e-signature legality) carries the "general
  information, not legal advice" note and links `/legal/esign-disclosure`; it describes
  SES + platform seal and explicitly not QES, matching `apps/esign/legal.py`. No
  invented statistics, no competitor disparagement, no keyword stuffing. Interlink
  guides ↔ tool pages.
- Routes: `/guides` index + one literal route per slug, generated from the table like
  `toolRoutes`, inserted before the catch-alls in both route files; unknown slug → real
  404 (nginx preserves the status — verify with curl on the built image or the dev
  server's SSR output).
- Components: `features/guides/guides-index.ts`, `guide-page.ts` — presentation-only,
  canonical + `og:` via `setCanonical`, `Article` JSON-LD (headline, datePublished,
  dateModified, author "the ZenPDF team"), related-tools block, site footer.
- SEO artefacts: `generate-seo.mjs` reads `guide-pages.ts`; `buildSitemap` changes
  signature to accept path prefix + priority (guides 0.6, `/guides` index, `/contact`);
  `seo-artifacts.spec.ts` byte-for-byte pins and `<url>` arithmetic updated in the same
  commit; commit the regenerated `public/sitemap.xml` and `robots.txt` (no change
  expected to robots).
- `verify-prerender.mjs`: every guide slug prerendered with unique `<title>`, H1,
  canonical, `"@type":"Article"`; `/guides` and `/contact` prerendered; still green for
  the 24 tool pages. Expect "Prerendered 43 static routes" (29 + 12 + 2) — confirm the
  arithmetic against your route files rather than trusting this number.
- New UI on these pages must respect Phase 12's contract rules: no single-character
  keyboard shortcuts (§6), and any menu uses the §3 Context menu spec (44 px rows).

## 4. Tool-page top-up, then the floors

Measure first (write a tiny script, paste its output into PROGRESS): intro word counts
and FAQ counts for all 24 `TOOL_PAGES`. The work order measured 4 intros under 250 and
15 pages with 3 FAQs on 2026-08-10 — re-measure, do not assume. Bring every intro to
≥ 250 words with **additive** paragraphs (H1/SEO copy semantics are contract-pinned —
extend, never rewrite) and write a 4th FAQ for every page with 3 — real questions,
honest answers, checked against behaviour. Then land the floors as unit tests in
`core/`: guides ≥ 700 words / ≥ 3 sections / `relatedTools` resolve / slugs unique
across tools+guides; tool pages ≥ 250 words / ≥ 4 FAQs. Floors land AFTER the top-up
in commit order so the suite is never red on `main`.

## 5. 11A, parameterised only

Do NOT change `SITE_URL` (the domain does not exist). Make the cutover a one-line change:
- confirm every canonical, `og:url`, JSON-LD `url`, sitemap `<loc>` and `robots.txt`
  Sitemap line derive from `SITE_URL` (grep for the literal host in `frontend/src` and
  `frontend/tools`; the only literal allowed is `core/site.ts`);
- in `infra/railway/nginx.railway.conf` add, **commented out and placed after the
  existing server block with `listen 80 default_server;` marked on it**, the redirect
  block from the work order, with the ordering warning in the comment;
- write `docs/ops/domain-cutover.md`: the exact steps (SITE_URL, nginx block, the env
  sweep `ALLOWED_HOSTS`/`CSRF_TRUSTED_ORIGINS`/`FRONTEND_BASE_URL`/`API_BASE_URL`/
  `ABUSE_CONTACT_EMAIL`/`DEFAULT_FROM_EMAIL`/`CORS_ALLOWED_ORIGINS`, the docs sweep, the
  verify list from 11A) so the owner's Cloudflare session and one CLI run finish it.

## 6. Tests and gate

Unit: floors, guide table validation, footer (seven links; ceremony footer unchanged),
legal-page kinds (contact renders `mailto:` and no `<form>`; about has the identity
paragraph; unknown kind throws), guide page + index component specs (sections, related
tools, JSON-LD present), `seo-artifacts.spec.ts`, `tool-pages.spec.ts`. e2e: new
`phase-11.spec.ts` — from landing, a tool page and the ceremony's status page click every
footer link (ceremony footer must NOT have Contact/Guides); `/guides` lists twelve; one
guide's related-tool links resolve; `/guides/does-not-exist` → 404 page with HTTP 404
(assert the response status); `/contact` has a `mailto:` and no form; `phase-10-a11y.spec.ts`
extended to scan `/contact`, `/guides` and one guide (zero serious/critical). Gate:
`npm test`, `ng lint`, `npm run build && npm run verify:prerender`, `./infra/test.sh --e2e`
fully green (63 + your new specs; unit baseline 396); data-test parity additive only; Lighthouse on the built bundle served
locally for landing, one tool page, one guide (≥ 90 SEO/a11y/best-practices) — paste the
scores.

## 7. UI testing via the Chrome MCP tools

On http://localhost:4200, **both themes, 1280 px and 390 px**, console after each step:
1. Footer on landing, `/merge-pdf`, `/legal/privacy`: seven links, wrap clean at 390.
2. `/contact`: reading column, `mailto:` opens the mail handler (read the href), no form.
3. `/about`: identity paragraph, link to `/contact`.
4. `/guides` and three guides (the redaction, e-sign legality and OCR ones): typography
   matches the legal pages, related tools render as the contract's cards, dates render,
   RTL spot-check (`document.dir='rtl'`) shows logical properties holding.
5. Open a ceremony status page from a Mailpit link (send a request to yourself on the
   local stack): its footer is unchanged.
6. View-source of a prerendered guide from the BUILT bundle (`npx http-server dist/…`
   or the nginx image): `<title>`, canonical, `Article` JSON-LD present in the HTML
   before hydration.
Screenshot each; one line per finding in PROGRESS. After merge, on
https://zenpdf.up.railway.app: `/contact`, `/guides`, one guide, the footer, the sitemap
URL count — once Railway shows the `web` deploy live.

## 8. Record, self-archive, ship

PROGRESS: Phase 11 section — tick the criteria this branch satisfies with evidence
(`/contact` live + prerendered + sitemap + footer; About identity; 12 guides + index +
floors + verify:prerender; 24 tool pages at floor; contract amended at four sites; §21.6;
both themes verified) and leave the owner-gated ones (`support@<domain>` mail test, 301s,
Search Console, privacy cookie wording, submission gate, skim, application, terminal)
unticked with a one-line reason each; status stays 🔵 (or 🟠 "awaiting owner: domain")
— it is NOT ✅. Decisions log: every place you interpreted the work order. Update
docs/09-adsense-readiness.md's "substantive public content" item and the README index
row. Then:

    git mv docs/reviews/handoffs/handoff-to-cli-phase-11-adsense-review.md docs/archived/$(date +%F)-handoff-to-cli-phase-11-adsense-review.md

prepend "**Executed <date> — 11B/11C landed; 11A/11D/11E remain owner-gated (see
PROGRESS §Phase 11). Historical.**".

TRACKING: after the merge and the `git pull --ff-only` below, set row 5 of
docs/reviews/handoffs/TRACKING.md to `✅ merged — PR #<n> (<merge sha>), <date>, archived at
docs/archived/<date>-handoff-to-cli-phase-11-adsense-review.md`, fill the PR/merge column, and put the PROGRESS anchor
(your session-log heading and the queue rows you closed) in the Evidence column. Commit that
one edit directly on `main` as `docs(tracking): prompt 5 merged` and push — docs only, no
deploy, the same way `f34800f` recorded Phase 12. This is the last commit of the run — do it
before you report. (The README carries no status; the board does.)

Commit in chunks (the contract first, then `feat(legal): /contact and the identity
paragraph`, `feat(guides): …`, `feat(seo): …`, `content(tools): intro top-up and fourth
FAQs`, `test(core): quality floors`, `docs(ops): domain cutover`, `docs(progress): …`);
push; `gh pr create --base main --head feat/phase-11-guides-and-contact --title "feat(phase-11): contact, identity, twelve guides and the content floors (pre-domain half)" --body "<What / What is deliberately not here (11A/11D/11E) / Verification numbers / Contract amendments / Chrome evidence / Lighthouse scores>"`.

Self-review with four lenses — *honesty* (read every guide as a sceptical reviewer: is
any claim about the product untrue or unverifiable? is any sentence filler?), *contract*
(tokens only, both themes, RTL, hit targets, no dead affordances, ceremony footer
verbatim), *SEO mechanics* (canonicals, sitemap arithmetic, 404 status for unknown
slugs, no duplicate titles), *regression* (the 24 tool pages' H1/SEO semantics unchanged
— diff them). Fix what is real; re-run the gate; `gh pr merge --merge --delete-branch &&
git switch main && git pull --ff-only origin main`; production check; revert on `main` if
production regresses. Report, and list for me exactly what the owner must do next (the
domain session from the work order's P1, the support mailbox test, the skim).
```
