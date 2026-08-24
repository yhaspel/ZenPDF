# Phase 11 (pre-domain half) — browser evidence, 2026-08-24

Driven on the local stack (`http://localhost:4200`) and, where the question was
about the *built* artifact, against real nginx serving
`frontend/dist/zenpdf-web/browser` with `infra/railway/nginx.railway.conf`.
Branch `feat/phase-11-guides-and-contact`.

## Screenshots

| File | What it shows |
|---|---|
| `contact-light-1280.png` | `/contact` — 640 px reading column, Mincho headings, the `mailto:` as body copy, **no form**, the legal crosslink row unchanged, the seven-link footer |
| `contact-dark-1280.png` | the same in dark |
| `guides-index-dark-1280.png` | `/guides` — twelve entries, title / one-line description / date per row, hairline separators, no filter and no ads |
| `guide-esign-light-1280.png` | a guide article — H1, byline "the ZenPDF team · Published 24 August 2026", and the `.notice .notice-info` with its link inside it |
| `guide-esign-dark-related-1280.png` | the related-tools block as the landing directory's own `.tool-card`s, two-up, in dark |
| `guide-esign-light-390.png` | the same article at a true 390 px — cards 2-up at 56 px, footer wrapped to two centred lines, no horizontal scroll |

*(The faint text along the top edge of the full-page dark capture is a Chrome
full-page stitching artifact, not an element: the DOM has exactly one
`footer`, at y=1849, and nothing but the brand above y=70.)*

## Measured, not eyeballed

**Footer, both themes.** Seven links in the contracted order with their
`data-test` names, on `/`, `/merge-pdf`, `/legal/privacy`, `/contact`,
`/guides` and a guide. One line at 1280 px; two centred lines at 390 px.
`scrollWidth === clientWidth` at every width tried (390, 500, 1280) — no
horizontal scroll anywhere. Link colour `#5F574A` light / `#BDB29E` dark =
`--color-ink-muted` in both modes.

**The wrap point is not fixed**, which is why the contract now specifies the
behaviour instead: the break falls after "E-sign disclosure" at 390 px and
after "Verify a signed PDF" at 500 px. A middot does end the wrapped line;
that is recorded and accepted in §3 with the reason, rather than being
described away.

**Contrast (computed from the rendered pixels, light / dark).** Body 12.07 /
15.15 · notice text on its surface 11.18 / 11.92 · notice rule on its surface
5.24 / 7.54 (UI floor is 3) · tool-card text 12.84 / 14.29 · index title 12.07
/ 15.15 · index description 6.31 / 8.82 · index date 5.01 / 5.87. Everything
clears AA in both modes.

**Geometry.** Reading column exactly **640 px** on the index and the article,
as §4 requires. Index rows 125 px and tool cards 56–58 px — both well over the
44 px floor, met by the row's own height rather than by padding a text link.
Four related tools render 2-up in two rows; two render 2-up in one.

**Typography.** H1 Shippori Mincho, body Zen Kaku Gothic New at 16 px / 28 px
(1.75) — the legal pages' own values, so a guide and the privacy policy read
as pages of one product.

**Tokens.** The notice's inline-start rule is `#3D6478` light / `#9CC0D4`
dark on `#E2EAEE` / `#1D2B33` — `--color-info` and `--color-info-surface`
exactly, in both modes. Nothing hardcoded.

**RTL.** Under `document.documentElement.dir = 'rtl'` the notice's 3 px rule
moves from the left edge to the right (`border-right-width: 3px`), the contact
page's list padding flips (`padding-left: 20px` → `padding-right: 20px`), the
H1 keeps `text-align: start`, and nothing overflows. Logical properties
throughout.

**Ceremony footer, both themes.** Exactly its own five entries —
`footer-about`, `footer-privacy`, `footer-terms`, `footer-esign`,
`report-open` — with **no** `footer-contact` and **no** `footer-guides`, the
not-a-QES sentence intact, and it is *not* the shared `site-footer`
component. This is the invariant Phase 11 was most able to break by being
helpful.

**Console.** Zero messages of any level on `/contact` and on a guide article.

## The built bundle, before hydration

Read out of `dist/…/guides/what-is-ocr-make-a-scanned-pdf-searchable/index.html`:
its own `<title>`, `rel="canonical"`, `og:url`, `og:type="article"`, the meta
description, the complete `Article` JSON-LD (headline, `datePublished`,
`dateModified`, author "the ZenPDF team", publisher, `mainEntityOfPage`), and
**17 paragraphs of prose in the served HTML**. Nothing about a guide waits for
hydration.

Status codes from that nginx: `/`, `/guides`, a guide, `/contact`,
`/merge-pdf`, `/sitemap.xml`, `/robots.txt` → **200**;
`/guides/does-not-exist` and `/nonsense-page` → **404**. The served sitemap
carries **43 `<loc>`s**. The whole of `phase-11.spec.ts` passes against that
origin, including the 404-status test that `test.skip`s on the dev server.

## Lighthouse — the built bundle, desktop

| Page | Accessibility | Best practices | SEO |
|---|---|---|---|
| `/` | **100** | **100** | **100** |
| `/merge-pdf` | **100** | **100** | **100** |
| `/guides/how-to-redact-a-pdf-properly` | **100** | **100** | **100** |

First runs scored best practices **96** on all three, from one failed audit:
`errors-in-console`, a single network 404. It was `/api/config/` — the sandbox
nginx here had its `/api/` proxy stripped, because there is no Django upstream
beside it. Stubbing that one endpoint, as production's proxy provides it,
takes all three to 100 with **zero** failed audits. Recorded rather than
quietly re-run, because "we changed the config and the score went up" is a
claim that should show its working.
