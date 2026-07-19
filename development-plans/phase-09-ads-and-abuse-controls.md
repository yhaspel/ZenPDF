# Phase 9 — Ads & Abuse Controls (free-to-use revenue model)

**Goal:** monetize with ads (owner decision 2026-07-19: free product, ad revenue, no billing/subscriptions), with privacy compliance (consent management) — and harden the free tier against abuse, since there is no paywall friction.

Depends on: Phase 8 (product is feature-complete enough to launch); quota plumbing from §16 exists since P1.

## 9A — Advertising

### Integration
- Provider: **Google AdSense** primary (network with self-serve onboarding). All integration behind our own abstraction so a swap (EthicalAds/Carbon for dev-audiences, or direct campaigns) is config-level: `AdSlotComponent` in `shared/` renders a slot by logical name; the concrete adapter (adsense) is chosen by `/api/config/` payload (`ads: {enabled, provider, client_id, slots: {…}}`).
- **Placements (deliberate, UX-first):** dashboard right rail (desktop ≥1280px) / single inline card in list (mobile); tool-completion surfaces (the natural pause: job-finished panel under the download button — highest-value slot, mirrors Smallpdf); landing page. **Hard exclusions:** NO ads in the editor canvas/viewer area, NO ads anywhere in the signing ceremony `/s/:token` or verify pages (trust surfaces), no popups/interstitials/auto-audio (also AdSense policy).
- Mechanics: AdSense script loaded lazily only when `ads.enabled && consent granted`; responsive units; reserved-height containers (no layout shift, CLS-safe); graceful collapse when unfilled or ad-blocked (never nag users about ad blockers in v1).
- `ads.txt` served at site root (nginx location + dev static); publisher id from env.
- **Public content build-out (dev work, this phase):** polished landing page (hero, tool grid, honest feature copy, SEO meta/OpenGraph, sitemap.xml, robots.txt) plus `/about` and per-tool marketing pages (static routes) — the content substance AdSense review requires and organic acquisition needs.
- CSP additions for ad domains documented in `infra/docker/nginx.conf` comments (activated with the phase-10 CSP work).

### Consent & privacy (launch-blocking prerequisites for ads)
- **CMP:** Google's certified CMP ("Privacy & messaging" / Funding Choices) for EEA/UK/CH consent (TCF), wired to Consent Mode; non-personalized ads when consent declined. Region-aware display. (If AdSense onboarding stalls, ads stay dark — `ADS_ENABLED=false` is the shipped default; the product launches ad-ready, not ad-dependent.)
- **Legal pages** (feature `legal/`, real content, owner-reviewed): Privacy Policy (data handling: files stored until deleted; 30-day trash; processing server-side; ad/consent disclosure; cookies list), Terms of Service (acceptable use, DMCA/abuse contact, no-warranty), E-sign Disclosure (from P8). Footer links everywhere incl. ceremony.
- Signup gains a ToS/Privacy consent checkbox (recorded on User: accepted_tos_at).
- **Data-retention statement** matching actual behavior (trash purge 30 d, exports 24 h, sign artifacts retained while account active) — verified against beat jobs (§15).

### AdSense readiness checklist (documented, owner executes)
Domain + HTTPS live; substantive public content (landing + legal + about/tools pages for crawl); ads.txt; account + site verification; policy review pass (user-generated-content policy: ads never render on pages displaying user document content — our placements already comply).

## 9B — Abuse controls (tightening §16)

- **Signup friction:** email verification required before first upload (`email_verified` gate, resend flow); optional Cloudflare Turnstile on register + public sign endpoints behind `CAPTCHA_ENABLED` flag (adapter pattern, off in dev).
- **Throttle matrix finalized** (per §16 + tuning): auth 10/min/IP, upload 20/hour/user, operations 60/hour/user (heavy ops 20/hour), public-sign 20/min/IP + 200/day/token, verify 10/min/IP. Job concurrency 3/user (queued beyond). 429s carry `Retry-After`.
- **Email abuse:** sign-request recipients cap (10/request), monthly envelope quota (§16: 30/mo), per-domain recipient sanity (no >50 distinct recipients/day/user), unsubscribe/complaint handling: `List-Unsubscribe` header on notification mail + suppression list model (`core.EmailSuppression`) honored by all senders; abuse-report contact in every mail footer.
- **Content abuse:** report-abuse endpoint + page for signing links (`/s/:token` footer "Report this request") → flags SignRequest for admin review, auto-pauses after 3 distinct reports (status canceled-by-abuse, owner notified). Django admin list views for User/Document/SignRequest with ban/soft-delete actions (admin enabled but IP-gated per §17 in prod).
- **Storage hygiene:** dormant-account policy documented only (no auto-delete in v1); oversized-account report (admin command).
- `GET /api/users/me/usage/` → **Usage panel** in settings UI (storage bar, monthly OCR/sign counters vs limits, job history table with filters).

## Tests
Config-driven ads: component renders nothing when disabled/unconsented (unit); consent flip enables script exactly once; CLS: reserved container dimensions asserted in component test; ads absent on ceremony routes (route-level test). Throttles: each limit exercised (DRF override rates in test settings); email verification gate (403 pre-verify on upload, ok after); suppression list stops mail; report-abuse → 3 reports auto-pause + emails; quota UI reflects counters.
E2E: fresh signup → verify email via Mailpit → upload allowed; decline consent → non-personalized/no ads (assert no adsense script); usage panel shows real numbers after an OCR run.

## Acceptance criteria
- [ ] With `ADS_ENABLED=false` (default): zero ad code loaded, product fully functional — launchable state.
- [ ] With ads on + consent granted: slots render in the three allowed surfaces only; ceremony/editor/verify provably ad-free.
- [ ] Consent banner appears for EEA-simulated visitors; declining yields non-personalized ads; choice persisted.
- [ ] Legal pages live, linked, and matching real system behavior (retention numbers cross-checked against beat config in a test).
- [ ] Unverified accounts cannot upload or send sign requests; verified flow smooth (<1 min via Mailpit locally).
- [ ] All throttle/quota limits return the standard error shape with human-readable messaging in the UI.

## Risks
- AdSense approval timing/policy friction → decoupled by default-off flag; product launch does not gate on ad network approval.
- Consent complexity (regional) → certified CMP outsources the hard part; we only wire Consent Mode correctly.
