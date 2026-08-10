# AdSense readiness checklist (owner-executed)

Phase 9 ships the product **ad-ready, not ad-dependent**: `ADS_ENABLED=false` is
the shipped default and with it the product loads no third-party code at all.
Everything below is account and domain work that only the owner can do, and
none of it blocks a launch.

Turning ads on is one environment change (`ADS_ENABLED=true` plus the ids), with
no rebuild and no code change.

The site-side work to *pass the review* — domain cutover, contact page, the
guides editorial layer, and the application loop — is planned in
`development-plans/phase-11-adsense-review.md`; this checklist stays the
owner-side account view.

## Before applying

- [ ] **Own root domain live on HTTPS**, serving the real product — AdSense
      will not review a staging URL or a parked domain, and it will not
      accept a platform subdomain: sites are added as root domains you own
      (plus a short partner list like blogspot). `zenpdf.up.railway.app`
      belongs to Railway, so an application from it fails on ownership
      before content is even looked at — the same wall vercel.app /
      netlify.app / github.io sites hit. The serious alternative networks
      (Mediavine, Ezoic, Media.net) apply the same rule, and SEO equity is
      currently accruing to Railway's domain, not ours. Concretely:
      - buy the domain (~$10/yr) and attach it to the Railway `web`
        service (CNAME; Railway provisions TLS automatically);
      - 301 the `zenpdf.up.railway.app` host to it in nginx;
      - sweep everywhere the base URL is baked: `sitemap.xml` and the
        `robots.txt` Sitemap line, canonical/OG metas in the prerendered
        pages, backend `ALLOWED_HOSTS`/`CSRF_TRUSTED_ORIGINS`/CORS;
      - verify the property in Search Console, submit the sitemap, and
        give it crawl time **before** applying.
- [ ] **Substantive public content reachable by a crawler.** Already shipped:
      the landing page, 24 tool pages, `/about`, `/legal/privacy`,
      `/legal/terms`, `/legal/esign-disclosure`. All are prerendered and listed
      in `sitemap.xml`; `robots.txt` allows them and disallows `/app/`, `/s/`
      and `/api/`.
- [ ] **Editorial layer against the "low value content" rejection** — the
      most common AdSense failure mode for tool sites, which read to the
      reviewer as thin templates (mostly UI, little crawlable prose). The
      24 tool pages + about + legal are a real base; strengthen it with
      how-to/FAQ prose on the tool pages themselves and on the order of
      10–20 short guides (800–1,200 words) before applying. Applying the
      week the content ships is a known way to collect this rejection —
      let Search Console see it first.
- [ ] **Legal pages reviewed by a human.** They are honest drafts written
      against real system behaviour, not lawyer-reviewed text — this is the
      open GATE item in `PROGRESS.md`.
- [ ] **`/ads.txt` answers at the site root.** It already does: nginx proxies
      `/ads.txt` to the API, which renders it from `ADSENSE_CLIENT_ID`. Until
      that variable is set the file honestly says no seller is authorised yet.

## Applying

- [ ] Create the AdSense account and add the site.
- [ ] Verify ownership (the meta-tag method works with the prerendered
      `index.html`; the `ads.txt` method works once the publisher id is set).
- [ ] Pass the policy review. The one that matters for this product is the
      **user-generated content** policy: ads must never render on a page
      showing somebody's document. Our placements already comply and the rule
      is enforced in code — `AdSlot.FORBIDDEN` refuses `/app/doc`, `/s/`,
      `/verify` and `/legal/`, with a unit test and a route-level e2e assertion.

## Switching on

- [ ] `ADSENSE_CLIENT_ID=ca-pub-…`
- [ ] `ADS_SLOT_DASHBOARD_RAIL`, `ADS_SLOT_DASHBOARD_INLINE`,
      `ADS_SLOT_TOOL_RESULT`, `ADS_SLOT_LANDING` — the unit ids from the
      AdSense UI. A slot with no id renders nothing, so they can be filled in
      one at a time.
- [ ] `ADS_ENABLED=true`.
- [ ] Confirm `/ads.txt` now names the publisher.
- [ ] Add the ad domains to the CSP. The exact list is written down in
      `frontend/nginx.conf` next to the policy; phase 10 owns turning CSP on.

## Consent (EEA/UK/CH)

- [ ] Enable a **Google-certified CMP** (Privacy & messaging / Funding
      Choices) in the AdSense account for TCF regions.

The wiring is already in place and correct without it: Consent Mode defaults are
pushed **denied** before any tag can load, nothing loads until a choice exists
where consent is required, and the built-in banner calls the same
`ConsentService.set()` the CMP will. `CONSENT_REQUIRED_REGIONS` is the list the
server compares against, and the client reports its **IANA timezone** rather
than its locale (`en-US` is the most common language tag on machines in Berlin).

## Known deviation from the phase plan

The plan says a declined consent yields **non-personalized ads**. We ship
"declined means no ads at all" until the certified CMP is wired, because
serving NPA correctly under TCF requires the CMP's signal — guessing at it is
the kind of wrong that is a compliance failure rather than a lost impression.
Outside the consent regions, where nothing is asked, ads do load.

## Other ad sources (reviewed 2026-08-10)

**Reddit is not an ad source.** Reddit Ads is buy-side only — advertisers
pay Reddit to show ads *on Reddit*. There is no Reddit network that pays
outside sites to display ads, and the 2026 "publisher toolkit" in Reddit
Pro is organic-distribution tooling (see which subreddits circulate your
links, seed new ones) with explicitly no monetization attached. Reddit
belongs in an **acquisition** plan — organic posts and possibly paid ads
pointing at the tool pages — not in this document's revenue column.

Networks that could actually serve ads here, judged against where the site
is today (brand-new domain, ~zero traffic, general office audience — not
developers):

- **AdSense stays primary.** Self-serve, no traffic minimum, accepts tool
  sites that carry enough editorial content, and monetizes a general
  audience. Nothing below removes the need to pass its review.
- **Media.net** — contextual ads, no published traffic minimum, wants
  mostly US/UK/CA/AU traffic. The plausible second application if AdSense
  stalls.
- **Journey by Mediavine** — 1,000 sessions/month and site ≥4 months old,
  but the program is built for content/blog sites (About page, article
  structure, editorial cadence); a web app may simply not qualify.
  Re-check once the guides section exists.
- **Monumetric** — 10,000 pageviews/month, net-60 payouts. The realistic
  second step once there is traffic.
- **Ezoic** — now requires **250k monthly active users** for new
  publishers (policy change 2026-02; an "Incubator" program exists below
  that). No longer the no-minimum on-ramp it used to be.
- **Mediavine proper / Raptive / Playwire** — 50k sessions up to 500k+
  pageviews. The "later, if this works" tier.
- **EthicalAds / Carbon** (phase 9 named them as swap candidates) —
  developer/designer audiences only; EthicalAds wants dev-focused sites at
  50k+ pageviews/month, pays ~$2.50 CPM, allows a single placement and no
  coexisting networks on the page. Our audience is office users, not
  developers — keep these off the roadmap unless analytics says otherwise.
- **Adsterra / PropellerAds / Monetag** — no minimums precisely because
  the formats are popunders, push and interstitials. Those violate this
  product's own placement rules (phase 9: no popups/interstitials) and the
  trust posture; not acceptable here at any revenue.

Mechanics if a second source is ever added: `AdSlotComponent` renders one
provider chosen by `/api/config/`, so a **swap** is config-level, but
running networks **simultaneously** is new work — and `/ads.txt` currently
renders only the AdSense line from `ADSENSE_CLIENT_ID`, so a second seller
also means extending that template.

Sequence: custom domain → AdSense → (if approval stalls for ~a month)
Media.net → at 10k pageviews/month compare Monumetric / re-check Journey →
revisit the premium tier at 50k+. Diversifying before there is traffic is
optimizing the empty set; until then the leverage is content and
acquisition, not a second network.
