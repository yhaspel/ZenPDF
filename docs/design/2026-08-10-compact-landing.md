# Compact landing — moving the hero into the header

Proposal, 2026-08-10. Amends design contract §2/§3/§4 (landing only). Status: **Variant A approved & implemented 2026-08-10**.

## Problem

On `/` today, ~570 px of intro stand between the top of the page and the first tool card: kicker → 42 px two-line h1 → paragraph → the folded trust sheet → 64 px of air → the filter. On a 13″ laptop (~780 px viewport) a visitor sees roughly one row of tools. The tools are the product; the intro is restating what the header and the cards already say.

## Goal

First tool card at ~195 px from the top — about two full groups (11 tools) above the fold instead of three cards. Same design language: paper, ink, one seal, ma. Nothing new is added; content is condensed and relocated.

## Recommended: Variant A — the masthead

Like a newspaper masthead: the title becomes a motto in the header, the trust sheet shrinks to one line beside the filter, and the directory starts immediately.

**Header** (landing's own header — no other page changes):

```
[seal ZenPDF] │ Every PDF tool, no account needed          Log in  [Create free account]  ◐
```

- The page `<h1>` moves into the header, restyled as a masthead motto: Shippori Mincho 500, 16 px, `--color-ink-muted`, hairline start divider after the brand. Exact text kept — it is still the page's single h1, prerendered, visible at every viewport.
- Below `lg` (1024 px) it wraps to a second header line (13.5 px) so nothing collides with the nav; header grows from ~57 px to ~80 px on small screens only.
- Nav unchanged (`cta-login`, `cta-register`, `cta-library` untouched).

**Main** starts 32 px under the header with the **filter row**:

- Type-to-filter input at start (max-width 380 px, placeholder unchanged, `tool-filter` untouched).
- **One-line trust sheet** at end: the same `.sheet` (folded corner kept — still the screen's single sheet), 13 px muted, all three facts verbatim: *No watermarks · Files delete automatically after 24 hours · Free, paid for by advertising*. The seal inside the sheet is dropped — the brand sits directly above it. Below ~1100 px the sheet wraps under the filter, still one compact strip.

**Then the directory**, unchanged: six kicker-headed groups, ad frame, footer.

### What gets removed, and why it's safe

| Removed | Why safe |
|---|---|
| Kicker "PDF tools & e-signature" | The wordmark + masthead + group headings carry it; "Sign" group and card keep the e-sign keyword on page. |
| Intro paragraph | Its instruction ("pick a tool, drop a file") is demonstrated by the directory itself and every tool page's dropzone. The SEO meta description is set in code and is unchanged. |
| 42 px hero + 64 px pre-filter gap | That's the point. Ma stays *between groups* (48 px rhythm), not in front of the product. |

### Fold math

| | Today | Variant A | Variant B |
|---|---|---|---|
| First tool card (from top) | ~570 px | ~195 px | ~250 px |
| Visible on a 780 px viewport | ~1 card row | 2 full groups + 3rd heading | ~1.5 groups |

## Fallback: Variant B — compact hero

If an h1 inside `<header>` feels wrong (it is valid and prerendered, but it is unconventional): the h1 stays in `main`, shrunk to 24 px on one line, directly above the same filter row + one-line trust sheet. Header untouched. Costs ~55 px vs A.

## Contract compliance (both variants)

- Semantic tokens only; both themes covered by existing tokens (no new colors).
- All `data-test` attributes preserved; **0 removed / 0 added**.
- No new affordances — layout and copy condensation only (§10 sanctioned-additions rule respected).
- One `<h1>` per page, exact wording kept; landmarks header/nav/main/footer intact.
- One `.sheet` per screen (the trust line), folded corner kept; contrast: masthead + trust line are ink-muted ≥ 6.3:1 light / 8.8:1 dark.
- Logical properties only; masthead divider and trust separators use `border-inline-start`; the seal never mirrors.
- Ads, footer, filter behavior, group structure: untouched.

## Contract amendments (applied on implementation, Variant A wording)

1. **§2 Typography roles**: "(landing hero 42 px)" → "(the landing h1 is the header masthead — §3)".
2. **§3 Headers → Marketing**: add: "On `/` only, the header carries the page's `<h1>` as a masthead motto after the brand: display 500 16 px `--color-ink-muted`, hairline inline-start divider; below `lg` it wraps to a second header line (13.5 px). Text: 'Every PDF tool, no account needed'."
3. **§4 Landing**: hero sentence replaced with: "marketing header with masthead h1 → filter row (type-to-filter at start; compact one-line folded-sheet trust strip at end — the three facts verbatim, 13 px) → six kicker-headed groups … The directory begins 32 px under the header; there is no hero block. No other CTAs; the directory is the hero."

## Implementation plan

- `frontend/src/app/features/landing/landing.ts` — template only: header gains the masthead h1; hero block + big sheet removed; filter row rebuilt with the compact sheet (~30 lines net removed).
- `frontend/src/styles.scss` — §3 gains `.hdr-mast` + `.masthead` (~12 lines); §16b: `.hero-h1` deleted if no longer referenced anywhere.
- `docs/design/design-instructions.md` — the three amendments above; this file lands as `docs/design/2026-08-10-compact-landing.md`.
- Verify: 211 unit tests, build + 29 prerendered routes + `verify:prerender`, data-test parity (expect 0/0), both themes + RTL screenshots of `/`.

## Mockup

`compact-landing-mockup.html` — toggle **Today / A / B**, light/dark, and a 780 px fold guide. Real tokens, real component CSS, real icons.
