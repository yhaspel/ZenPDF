# AdSense readiness checklist (owner-executed)

Phase 9 ships the product **ad-ready, not ad-dependent**: `ADS_ENABLED=false` is
the shipped default and with it the product loads no third-party code at all.
Everything below is account and domain work that only the owner can do, and
none of it blocks a launch.

Turning ads on is one environment change (`ADS_ENABLED=true` plus the ids), with
no rebuild and no code change.

## Before applying

- [ ] **Domain live on HTTPS**, serving the real product — AdSense will not
      review a staging URL or a parked domain.
- [ ] **Substantive public content reachable by a crawler.** Already shipped:
      the landing page, 24 tool pages, `/about`, `/legal/privacy`,
      `/legal/terms`, `/legal/esign-disclosure`. All are prerendered and listed
      in `sitemap.xml`; `robots.txt` allows them and disallows `/app/`, `/s/`
      and `/api/`.
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
