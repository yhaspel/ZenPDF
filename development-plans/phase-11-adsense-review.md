# Phase 11 — AdSense review readiness (approval pass)

**Goal:** get the AdSense application **approved** — the account-side gate that
phase 9 deliberately decoupled from launch. Phase 9 shipped the product
ad-ready (slots, consent, legal pages, `ads.txt`, SEO surfaces, all dark by
default); this phase does the remaining *site-side* work that makes the
application credible, then runs the application loop until approval. Ads stay
`ADS_ENABLED=false` throughout — **switching on remains
`docs/09-adsense-readiness.md` territory** and is out of scope here.

Depends on: Phase 9 (ad plumbing + SEO surfaces + legal pages), the production
deployment (live since 2026-08-08), and prerequisite P1 below. Phase 10's
v1.0.0 tag is **not** a dependency — approval work and the launch checklist
proceed independently.

> **⚠ What this phase is not.** It is not an SEO/growth phase and not a content
> farm. Every page it adds must clear the same bar as the tool pages: honest
> copy, written against real system behaviour, useful with the ads off. AdSense
> rejections for "low value content" are the norm for tool sites that skip
> this; the counter is a small number of genuinely good pages, not a large
> number of thin ones.

> **⚠ Approval is not deterministic.** Google's review is opaque and takes
> days to 2–4 weeks per cycle. The phase therefore ends in a **loop** (11E)
> with an explicit protocol for rejections, and its terminal acceptance
> criterion is external. Everything before the loop is fully in our control.

> **⚠ This phase amends the design contract.** *(Count corrected 2026-08-22 — this said "exactly two post-redesign additions", which the contract itself said and which stopped being true on 2026-08-20.)* The contract sanctions, as of 2026-08-22: the **theme toggle** and the **landing filter** (2026-08-06); **version-level Undo** and **annotate Undo/Redo** (2026-08-20); and Phase 12's additions (2026-08-21) — the **context menu**, **per-mode Undo/Redo in all six editing surfaces**, **Redo and Shortcuts on the workspace bar**, the **shortcuts sheet**, the **Areas / Placements / Fields rail lists**, **Copy/Duplicate on comment rows** and **Paste in the palette**. It also pins the route set, the 24 tool slugs and the footer's five links
> (`docs/design/design-instructions.md` grounding, §3 Footer, §10 Invariants, and the Amendment log at the end of that file).
> **Phase 11 adds `/contact` and `/guides` to that list** — and must add them to the Amendment log in the same change, which is what stops the grounding sentence ageing again.
> Adding `/contact`, `/guides` and the guide routes is therefore a
> **contract amendment, owner-sanctioned by commissioning this phase**, made
> in the same changes as the implementation (gap rule) — never silently.
> Amendment sites: the grounding's sanctioned-additions list, §3 Footer (the
> new seven-link set), §4 (two new screen entries: guides index, guide
> article), §10 (routes + footer invariants). The ceremony footer's own link
> set stays **verbatim** per §3; the legal pages' in-page crosslink row also
> stays unchanged — `/contact` and `/guides` enter through the site footer
> only.

## Prerequisites

- **P1 (hard, owner): a custom root domain is purchased.** AdSense only
  accepts root domains the applicant controls; `zenpdf.up.railway.app`
  belongs to Railway and fails on ownership before content review (the
  vercel.app/github.io wall — `docs/09-adsense-readiness.md`, "Before
  applying"). Everything in 11A hangs on this. **Decide the canonical origin
  now: the apex** (`https://<domain>`), with `www` added as a redirecting
  alias — both choices are baked into `SITE_URL`, nginx and DNS below.
  Recommended: put the domain on **Cloudflare DNS** (free) — it gives CNAME
  flattening at the apex (Railway hands us CNAME targets; plain apex CNAMEs
  don't exist at most registrars) and free inbound **Email Routing**, which
  11B needs with SMTP off.

  **Owner: one Cloudflare session, in order** (everything below is one
  sitting once the domain exists):
  1. Point the domain's nameservers at Cloudflare (registrar side).
  2. In Railway → `web` service → add **both** custom domains: apex and
     `www.<domain>` (workspace is Pro — the 2-domain allowance covers it).
  3. For each, create the DNS records Railway shows — **the CNAME and the
     ownership TXT record. Both are required; with the TXT missing the
     domain never verifies and requests 404.** Keep the Cloudflare proxy
     **off** (grey cloud / DNS-only) so Railway provisions TLS itself.
     *Railway's docs nominally prescribe orange-cloud + SSL mode "Full";
     ignore that for this setup — grey cloud is the verified path for
     Railway-issued certificates. If the proxy is ever enabled later, SSL
     mode must be Full (never Flexible).* Certificate usually issues in
     under an hour; DNS propagation can take up to 72 h.
  4. Add the Google Search Console **domain property** TXT record (11A uses
     it; doing it in the same sitting saves a second session).
  5. Enable **Email Routing**: `support@<domain>` and `abuse@<domain>` →
     the owner's mailbox; click the destination-confirmation mail. Note:
     routing is inbound-only — replies will egress from the personal
     mailbox address, which is acceptable for v1.
- **P2 (hard): production is live and healthy** — true since 2026-08-08
  (`docs/ops/railway-deploy-report-2026-08-08.md`).
- **P3 (soft): the compact-landing change is committed and deployed** before
  11A's cutover, so the domain swap lands on a clean baseline instead of
  mixing two working-tree changes.
- **P4 (existing GATE, owner): legal pages human-reviewed.** Already the open
  GATE in `PROGRESS.md`; the AdSense reviewer reads exactly these pages. One
  addition to that review: the privacy policy must carry the disclosure
  AdSense **requires** of participating sites — that third-party vendors,
  including Google, use advertising cookies, with the opt-out pointers
  (Google Ads Settings / aboutads.info). The current copy is close
  ("Advertising cookies, set by Google, only after you allow…") but the
  review should check it against the required-content list
  (support.google.com/adsense/answer/1348695); forward-looking wording is
  fine while ads are dark.
- **P5 (constraint): SMTP stays off** (owner decision). Everything here must
  work without outbound mail: the contact surface is a `mailto:` address with
  inbound forwarding, never a form.

## 11A — Domain cutover & canonical URLs

The single-source-of-truth design from §21.6 makes this small: the origin is
written down once.

- **Frontend:** change `SITE_URL` in `frontend/src/app/core/site.ts` to
  `https://<apex>`. `npm run build` regenerates `public/sitemap.xml` and
  `public/robots.txt` via the `generate:seo` prebuild step; commit the
  regenerated artifacts (`seo-artifacts.spec.ts` pins them byte-for-byte and
  fails the build on drift). Canonicals, `og:url` and JSON-LD `url` all read
  the same constant — no other frontend edit.
- **nginx** (`infra/railway/nginx.railway.conf`): the config is a **single
  server block with `server_name _`**, which matches nothing and works only
  because it is the sole (hence default) server. Keep it that way: mark its
  listen directive `listen 80 default_server;`, then add the redirect block
  **after** it:
  `server { listen 80; server_name zenpdf.up.railway.app www.<domain>; return 301 https://<apex>$request_uri; }`
  Placing the redirect block first (or leaving `default_server` implicit)
  would make it the default server — the apex Host matches no `server_name`,
  falls into the redirect, and production 301-loops; Railway's healthcheck
  (its own Host header, `location = /health`) would 301 too and fail every
  deploy. The absolute URL is written out on purpose: `$scheme` is `http`
  behind Railway's TLS edge — the same trap `absolute_redirect off` fixed
  for directory redirects.
- **Backend env sweep** (Railway, env-var-only change): `ALLOWED_HOSTS` and
  `CSRF_TRUSTED_ORIGINS` gain the new origin; **`FRONTEND_BASE_URL` and
  `API_BASE_URL` move to the new origin — every signing, verification and
  unsubscribe link is built from them** (`docs/10-launch-checklist.md`), so
  missing these leaves invitation links minting on the old host;
  `ABUSE_CONTACT_EMAIL` and `DEFAULT_FROM_EMAIL` move to `abuse@<domain>` /
  `no-reply@<domain>` (addresses appear in copy and headers even with SMTP
  off); `CORS_ALLOWED_ORIGINS` updated if set (nginx same-origin-proxies
  `/api/`, so it is belt-and-braces). Frontend `SITE_URL` env stays unset —
  it is a preview-host escape hatch, not the production path.
- **Deploy model:** a push to `main` **is** the deploy (auto-deploy from
  `yhaspel/ZenPDF@main` with watch patterns — note `infra/railway/**`
  triggers web *and* the five Django services, so the nginx commit fans out).
  `serviceInstanceDeployV2` is needed only for the env-var sweep, which
  changes no code (`docs/ops/railway.md` traps still apply: not `redeploy`).
- **Docs sweep (same commit):** update the hardcoded old host in
  `docs/ops/railway-handoff-claude-cli.md` (H2's `BASE_URL`, the custom-
  domain row) and anywhere else `zenpdf.up.railway.app` appears as "the
  site"; tick the custom-domain item in `docs/09-adsense-readiness.md`.
- **Verify (all mechanical):** `curl -I` on the old host and on
  `https://www.<domain>` → 301 to the apex; Railway healthcheck still green
  (deploy succeeds); the served HTML of `/`, one tool page and `/about`
  names the apex in `<link rel="canonical">`; `/ads.txt`, `/robots.txt`,
  `/sitemap.xml` answer on the apex and the sitemap's `<loc>` URLs use it;
  `/api/health/` green; a guest upload→download round-trip works on the new
  origin.
- **Search Console (owner):** the domain property (verified via the TXT from
  P1) covers apex + www + both protocols; submit `sitemap.xml`; use URL
  Inspection to request indexing for the landing page, the ten highest-value
  tool slugs and `/about`. (`/guides` and `/contact` are requested in 11D,
  after they exist.) The old host was never a GSC property, so there is no
  change-of-address to file — the 301s plus new canonicals consolidate
  whatever Google had picked up from the old host; optionally spot-check
  `site:zenpdf.up.railway.app` a few weeks after cutover.

## 11B — Trust surfaces: contact & identity

An ad-network reviewer who cannot find a way to reach a human reads the site
as anonymous and disposable. Fixing that does not require publishing anyone's
identity — it requires a working address.

- **`/contact` page** on the existing `features/legal/legal-page` component,
  the way `/about` is served today (route `data: { kind: 'contact' }`). The
  mechanics are three small edits, not one: extend the `LegalKind` union;
  add a `'contact'` entry to the constructor's title/meta map (**the map is
  indexed by kind and throws on a missing entry — this is not optional**);
  add an explicit `@case ('contact')` in `legal-page.html` — and while
  there, convert About from the `@switch`'s `@default` into a real
  `@case ('about')` so future kinds fail loudly instead of silently
  rendering About. Content: the support address as a `mailto:` link, what
  to include in an abuse report (the abuse address, mirroring the
  ceremony's report flow), and honest expectations (independent product,
  best-effort replies). No form — P5. Layout reuses the legal pages'
  640 px reading-column pattern (§4) — **not** `.sheet`, which the contract
  reserves for trust/retention notices.
- **`SUPPORT_EMAIL`** lands next to `SITE_URL` in `core/site.ts` as the
  single written-down copy of the address.
- **About page:** one short "who runs this" paragraph in the (newly
  explicit) about case — an independent product, operated by its developer,
  contact via `/contact`. No names required.
- **Wiring:** route in `app.routes.ts` and a `RenderMode.Prerender` entry in
  `app.routes.server.ts` — both **inserted before the `'**'` catch-alls**
  (first match wins; an entry after them is dead); `'contact'` added to
  `CONTENT_PAGES` in `frontend/tools/seo.mjs` (sitemap + spec pin update).
  New `data-test` attributes are additive.
- **Footer:** gains **Contact** and **Guides** — the seven-link set specced
  in the contract amendment (see banner) before `site-footer.ts` changes.
  Ceremony footer and legal-page crosslink row: unchanged.
- **Verify:** send a real mail to `support@<domain>` and see it arrive in
  the owner's inbox — forwarding proven, not assumed.

## 11C — Editorial layer: guides

The heart of the phase. Tool pages already carry unique titles/H1s,
canonicals, `FAQPage` + `SoftwareApplication` JSON-LD — presence mechanically
enforced by `verify-prerender.mjs` — with intros measured at 218–381 words
(median 277) and 3–5 FAQs. What the site lacks is any page whose *primary
content is prose*. That absence is what "low value content" rejections are
made of.

- **Content model — mirror the tool-page pattern exactly.**
  `core/guide-pages.ts` exports `GUIDE_PAGES: GuidePageDef[]` with
  `slug`, `title`, `metaDescription`, `h1`, `published`/`updated` (fixed ISO
  strings — prerender output must be deterministic), `sections:
  { heading?, paragraphs[] }[]`, `relatedTools: ToolKind[]`. Slug lines
  formatted so `extractSlugs()` in `tools/seo.mjs` parses the file
  unchanged.
- **Routes:** `/guides` (index: every guide, one-line description each) and
  one literal route per slug under `/guides/<slug>`, generated from the
  table the same way `toolRoutes` is — and, like 11B's routes, inserted
  before the `'**'` catch-alls in both route files. Unknown slugs fall
  through to the real 404 (nginx preserves the 404 status; Angular renders
  NotFound).
- **Components:** `features/guides/guides-index.ts` + `guide-page.ts`,
  presentation-only, on the legal pages' reading-column pattern per the §4
  amendment. Each guide page: canonical + `og:` tags via `setCanonical`,
  `Article` JSON-LD (headline, datePublished, dateModified), a
  related-tools link block, the site footer.
- **SEO artifacts (explicit code changes, not config):**
  `generate-seo.mjs` reads `guide-pages.ts` alongside `tool-pages.ts`;
  **`buildSitemap` changes signature** — today it hardcodes
  `priority = slug ? '0.8' : '1.0'` and knows nothing of path prefixes — to
  accept the guide set (locs under `guides/`, priority 0.6, plus the
  `/guides` index). `seo-artifacts.spec.ts`'s byte-for-byte pins and its
  `<url>`-count arithmetic update in the same commit. `robots.txt` needs no
  change — `/guides` is already allowed.
- **Verification:** `verify-prerender.mjs` extended: every guide slug must
  be prerendered with its unique `<title>`, its H1, a canonical, and
  `"@type":"Article"` JSON-LD; `/guides` and `/contact` prerendered; still
  green for the 24 tool pages.
- **Tool-page top-up — honestly sized, and sequenced *before* the floor
  tests land.** Measured today: 4 intros under 250 words (`jpg-to-pdf` 218,
  `extract-pdf-pages` 223, `add-page-numbers` 223, `pdf-to-jpg` 247) and
  **15 of 24 pages carry only 3 FAQs**. The work: bring those 4 intros to
  ≥ 250 (additive paragraphs — H1/SEO copy semantics are contract-pinned,
  so extend, don't rewrite), and write a 4th FAQ for the 15 — real
  questions with honest answers, same bar as the existing ones. Then land
  the floors so the bar can't silently erode.
- **Mechanical quality floor (unit tests in `core/`, landing after the
  top-up):** every guide ≥ 700 words of body prose and ≥ 3 sections; every
  guide's `relatedTools` resolve to real `ToolKind`s; slugs unique across
  tools + guides; every `TOOL_PAGES` intro ≥ 250 words and FAQ count ≥ 4.
  Floors against accidental thinness, not targets.
- **The twelve initial guides** (each maps to shipped behaviour — no
  aspirational features, per the no-dead-affordances rule):
  1. `how-to-merge-pdf-files` — order, batches, bookmarks caveat → merge
  2. `compress-pdf-without-losing-quality` — what compression trades → compress
  3. `fill-and-sign-pdf-without-printing` — forms + self-sign flow → fill-form, sign
  4. `are-electronic-signatures-legally-binding` — ESIGN/eIDAS/Israeli
     e-sign law overview, what the PAdES seal proves, **"general
     information, not legal advice"** note, links `/legal/esign-disclosure`
     → sign
  5. `what-is-ocr-make-a-scanned-pdf-searchable` — OCR, languages incl.
     Hebrew, limits → ocr
  6. `pdf-to-word-conversion-explained` — what converts cleanly, what
     cannot → pdf-to-word
  7. `how-to-redact-a-pdf-properly` — why covering text fails, true
     redaction, verification pass → redact
  8. `password-protect-pdf-what-encryption-actually-does` — AES-256 vs
     permission flags → protect, unlock
  9. `organize-scanned-pages-split-reorder-rotate` → organize, split, rotate
  10. `email-a-pdf-thats-too-big` — compress vs split strategies → compress, split
  11. `pdf-page-numbers-and-bates-stamping` — where each is used → page-numbers
  12. `flatten-pdf-what-it-means` — annotations/forms flattening, when to → annotate, fill-form
- **Copy rules:** written in the product's voice (contract §1 Voice); every
  factual claim about limits or behaviour checked against the real system
  (guest limits, retention, engine behaviour) exactly as tool-page copy
  was; interlink guides ↔ tool pages; no keyword stuffing, no invented
  statistics, no competitor disparagement. Author line: "the ZenPDF team".
  **Owner skims all twelve before 11E submits** — AI-flavoured filler is a
  rejection vector, and a human read is the cheap defence.
- **Docs (same commits):** amend `01-architecture.md` §21.6 (guides +
  `/contact` join the public prerendered surface list); extend the
  "substantive public content" item in `docs/09-adsense-readiness.md` with
  the new pages; add this phase to `development-plans/README.md`'s index.

## 11D — Indexing & bake

Applying the week the content ships is the classic premature rejection. This
workstream is mostly calendar time, deliberately.

- After 11A–11C deploy: confirm in Search Console that the sitemap is read
  and pages move Discovered → Indexed. Request indexing for `/guides`,
  `/contact` and the guide slugs now that they exist (GSC re-reads the
  updated sitemap; resubmission is optional). **Submission gate, timeboxed:**
  apply once the landing page, `/guides`, a majority of guides and ≥ 10 tool
  pages are indexed — **or after 4 weeks with zero crawl errors, whichever
  comes first.** Indexing breadth is our quality proxy, not an AdSense
  requirement; it keeps improving during review, and a fresh domain can sit
  in "Discovered – currently not indexed" for a while regardless of merit.
- **Soft acquisition trickle (owner, optional but valuable):** a site with
  zero human visits reads as unlaunched. Reddit/HN-style organic posts
  pointing at genuinely useful pages (the redaction and e-signature guides
  are the shareable ones) — per `docs/09-adsense-readiness.md` "Other ad
  sources": Reddit is an acquisition channel, not a revenue one.
- **No analytics gets added for this.** Consent-first posture stays; Search
  Console impressions are the only traffic signal we need pre-approval.
- Lighthouse SEO/a11y/best-practices stay ≥ 90 on landing + one tool page +
  one guide (prod build) — re-run after 11B/11C land.

## 11E — Application & review loop (owner-executed, agent-supported)

- Create the AdSense account (payee details must match real identity/bank;
  Israel is not in the 6-month-site-ownership country list).
- Add the site (the apex domain). **Site verification via `ads.txt`:** set
  `ADSENSE_CLIENT_ID` on the `api` service **and `serviceInstanceDeployV2`
  it** (env-only change; no code, no frontend rebuild) — `/ads.txt` then
  names the publisher; allow AdSense up to ~a day to detect it before
  falling back to the meta-tag method (prerendered `index.html`, one commit).
  **`ADS_ENABLED` stays `false`** — verification proves control of the
  site; no ad code needs to load for review, and the product keeps loading
  zero third-party bytes.
- **Freeze during review:** no restyles, no copy rewrites, no route changes
  while a review is pending. Bug fixes are fine. The site a reviewer sees on
  day 3 should be the site we applied with on day 1.
- **Review timelines:** typically days, officially up to 2–4 weeks. Check
  the AdSense Sites page, not email, for state changes.
- **On rejection — the loop protocol:**
  1. Record verdict + stated reason verbatim in `PROGRESS.md` (session log +
     Human review queue entry).
  2. Classify: *policy violation* (fix the named thing), *low value content*
     (extend guides toward 20, deepen the thinnest tool pages, re-check
     indexing counts), or *site not found/down* (re-run 11A's verify list).
  3. Fix, wait for the fix to be crawlable (GSC re-inspection), then request
     re-review from the Sites page. Never resubmit unchanged — repeat
     identical submissions are the one pattern that reads as spam.
  4. 1–3 cycles is normal for tool sites. After 3 rejections with "low value
     content", stop and reassess with the owner (content strategy, or the
     fallback networks in `docs/09-adsense-readiness.md` "Other ad
     sources").
- **On approval:** hand off to `docs/09-adsense-readiness.md` → "Switching
  on" (slot ids, CMP, CSP ad hosts). Not this phase.

## Tests

- Unit (`core/`): guide table validation (word floor ≥ 700, ≥ 3 sections,
  unique slugs across tools+guides, `relatedTools` resolve); tool-page
  floors (intro ≥ 250 words, ≥ 4 FAQs) landing **after** the 11C top-up;
  `seo-artifacts.spec.ts` re-pinned for guides + `/contact`; footer renders
  the seven contracted links.
- `verify:prerender` extended: guides (title/H1/canonical/`Article`
  JSON-LD) + `/guides` + `/contact`; still green for the 24 tool pages.
- Component: guide page renders sections + related tools; contact page
  renders the `mailto:` and no form; both themes (contract DoD).
- Manual/e2e-lite: click every site-footer link from landing, a tool page
  and the ceremony (whose own footer is unchanged); every guide's
  related-tool links resolve; unknown guide slug → real 404.
- Post-deploy (11A verify list): 301s (old host + www), healthcheck green,
  canonicals, ads.txt/robots/sitemap on the apex, health, guest round-trip.

## Acceptance criteria

- [ ] Old host and `www` 301 to the apex; deploys still pass healthcheck;
      canonicals, `og:url`, JSON-LD, sitemap and robots all name the apex;
      `seo-artifacts.spec.ts` green on regenerated artifacts;
      `FRONTEND_BASE_URL`/`API_BASE_URL` mint links on the new origin.
- [ ] Search Console: domain property verified, sitemap submitted and read.
- [ ] `/contact` live, prerendered, in the sitemap, linked from the site
      footer everywhere; a real mail to `support@<domain>` arrived in the
      owner's inbox.
- [ ] About page answers "who runs this" and links `/contact`.
- [ ] 12 guides + `/guides` index live, prerendered, in the sitemap, each
      passing the mechanical floor and the extended `verify:prerender`.
- [ ] All 24 tool pages meet the intro/FAQ floors (4 intros topped up, 15
      fourth-FAQs written).
- [ ] Design contract amended at all four sites (grounding, §3, §4, §10) in
      the same changes as the UI work; `01-architecture.md` §21.6 amended;
      README index row added; both themes verified on every new/changed
      surface.
- [ ] Privacy policy carries the AdSense-required advertising-cookie
      disclosure (checked against answer/1348695 as part of the P4 review).
- [ ] Submission gate met (11D — indexing target or the 4-week timebox).
- [ ] Owner has skim-read all guides before submission.
- [ ] Application submitted with ads dark; review-freeze observed; any
      rejection recorded + classified + acted on per the loop protocol.
- [ ] **Terminal (external):** AdSense Sites page shows the domain
      **approved/ready**. Phase closes only on this; until then it parks at
      🟠 with the loop live.

## Risks

- **Approval remains a black box** → the loop protocol + the 3-strike
  reassessment keep it from becoming an open-ended grind; fallback networks
  are documented in `docs/09-adsense-readiness.md`.
- **AI-written guides read as filler** → honesty rules + claims checked
  against the running system + owner skim before submission.
- **Domain choice is a one-shot** → renaming later resets canonicals,
  Search Console history and the AdSense site entry; pick once, before 11A
  starts. Apex CNAME needs Cloudflare-class flattening, and Railway needs
  its TXT verification record — both are P1 steps, not afterthoughts.
- **Indexing lag on a fresh domain** → 11D's explicit bake with
  request-indexing *and* the 4-week timebox, so the phase cannot park
  forever on a metric AdSense doesn't check.
- **Scope creep toward a blog/CMS** → guides are a static table in `core/`,
  exactly like tool pages; 12 at launch, extended only if a rejection
  demands it. No CMS, no comments, no tags, no RSS.
- **Contract drift** → the amendment is specced first (banner above), then
  implemented; footer/data-test changes are additive.
- **Cutover misconfiguration** → the redirect-block ordering note in 11A
  exists because getting it wrong 301-loops production and fails
  healthchecks; the verify list is the proof, not the intention.

## Out of scope

Enabling ads, slot ids, the CMP, CSP ad hosts (all
`docs/09-adsense-readiness.md` "Switching on"); billing; analytics; a blog
platform; SMTP; ads on guide pages (a future contract decision); any change
to the editor/ceremony/verify surfaces.
