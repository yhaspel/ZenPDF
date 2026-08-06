# ZenPDF redesign — one-shot prompt for Claude Design

Usage: paste everything below the line into Claude Design (claude.ai/design) as a single message, with the GitHub connection to `yhaspel/ZenPDF` active — the prompt directs Claude Design to read the repo. Save its `design-instructions.md` output to `docs/design/design-instructions.md` in this repo and its mockups to `docs/design/mockups/` — the implementation prompt for Claude CLI / Cowork starts from those two paths.

---

You are doing a complete, ground-up UI redesign of **ZenPDF**, a shipping web product. You are the design authority; a separate coding agent (Claude Code / Cowork) will implement your output inside the existing codebase without you in the loop. Your deliverables must therefore carry *everything*: a machine-actionable design contract (`design-instructions.md`) plus high-fidelity mockups. Where a mockup and the contract disagree, the contract wins — write it accordingly.

## 0. Source of truth — the repository (you have access)

The full codebase is on GitHub and you have access to it: **https://github.com/yhaspel/ZenPDF**. Read it before and while designing — the inventory in this brief is orientation; **where the brief and the code disagree, the code wins.** Key paths: `frontend/src/app/features/` (every screen), `frontend/src/app/shared/` (global components, incl. `ad-slot.ts`, `guest-banner.ts`, `site-footer.ts`, `signature-pad.ts`), `frontend/src/app/core/tool-pages.ts` (copy, steps, FAQs and slugs of all 24 tools), `frontend/src/app/app.routes.ts` (all routes).

**Design only what exists — zero dead UI.** Every button, link, menu item, toggle, and control in your mockups and specs must correspond to an action implemented in this codebase today; verify it in the code before you draw it. Exactly two new interactive elements are sanctioned by this brief and will be implemented with the redesign: (1) the Light/Dark/System theme toggle (§4), and (2) the landing directory's type-to-filter — a pure client-side filter over the existing 24 tool links (§5 D4). Nothing else new. Do not invent: sharing/collaboration/comments, AI features of any kind (the product deliberately has none), pricing/upgrade/billing UI (a `pro` tier exists in config but is not purchasable — no upsell affordances anywhere), template galleries, blog/newsletter/social links, app-store badges, live chat, notification centers, or account menus beyond what the header actually has (email + log out). The footer restyles but keeps exactly its five existing links (About, Privacy, Terms, E-sign disclosure, Verify a signed PDF) — nothing added. Developer/debug-only controls never appear in a design, even if you find one in the code.

## 1. What ZenPDF is (product facts — fixed, not yours to change)

- Free, ad-supported, in-browser **PDF editor + e-signature** suite. English UI (design must be RTL-ready — see §10).
- **Anonymous-first.** Every tool works with zero account and zero friction. Accounts are an *upgrade* (persistent library, folders, saved signatures, sending signature requests, higher limits) — never a wall. Do not design any gate, teaser blur, or nag that taxes anonymous use.
- **Trust promises are UI content:** no watermarks, files auto-delete (24 h sliding, 72 h max — the existing retention notice is worth designing as a visible trust signal, not hiding), free because ads.
- **Ads run on exactly three surfaces** — landing page, dashboard rail, tool result panel — as responsive AdSense units in **reserved-height containers** (zero layout shift), each labeled "Advertisement". Ads NEVER appear on the signing ceremony, `/verify`, legal pages, or beside the open document canvas. Design the ad container as a first-class, honest component: clearly bounded, quietly framed, never disguised as content.
- **E-sign is legally careful** and must look it: version-stamped disclosure, an unskippable consent gate, and an honest "not a qualified electronic signature" footer. The ceremony a signer sees at `/s/<token>` is the product's most solemn surface — calm, minimal chrome, zero ads, zero playfulness, works beautifully on a phone.

### The 24 tools (slugs are routes — fixed)

Suggested grouping for the directory (you may refine group labels, not slugs):

- **Organize:** merge-pdf, split-pdf, organize-pdf, rotate-pdf, delete-pdf-pages, extract-pdf-pages, add-page-numbers
- **Edit & annotate:** edit-pdf, annotate-pdf, fill-pdf-form, watermark-pdf
- **Convert & OCR:** pdf-to-word, word-to-pdf, jpg-to-pdf, pdf-to-jpg, html-to-pdf, ocr-pdf
- **Optimize & review:** compress-pdf, repair-pdf, compare-pdf
- **Protect:** protect-pdf, unlock-pdf, redact-pdf
- **Sign:** sign-pdf

### Screen inventory (all of these exist and need the new language)

| Surface | Route | Notes |
|---|---|---|
| Landing / tool directory | `/` | Hero + all 24 tools; the SEO acquisition channel |
| Tool page (×24, one template) | `/<slug>` | H1 + dropzone → options → progress → result panel (download, "continue in workspace", tool-result ad) + SEO copy blocks (steps, FAQ, related tools) |
| Workspace (viewer/editor) | `/app/doc/:id` | pdf.js canvas + app tool nav (Organize, Edit, Annotate, Forms, Convert, Compare, Sign, Protect, Split, Compress, Download) with per-tool panels/overlays; open to guests |
| Dashboard (account library) | `/app/dashboard` | Upload, file cards w/ thumbnails, folders, rename, trash/restore; dashboard-rail ad |
| Sign request builder / detail / list | `/app/sign/…` | Account-only sender flows |
| Signing ceremony (public) | `/s/:token` | Consent gate → field fill → signature (draw/type/upload) → finish |
| Signature verify | `/verify` | Public checker, trust surface |
| Auth | `/auth/login`, `/auth/register` | Contextual "why an account" reasons exist (library / sign / settings) |
| Settings | `/app/settings` | Profile, password, saved signatures, consent, data controls |
| Legal / about / disclosure | `/legal/*`, `/about` | Long-form reading pages |
| System pages | 404, `/unsubscribe/:token`, `/verify-email/:token` | |
| Global components | — | App header + marketing header, guest banner, cookie-consent banner, toasts, modals, empty states, progress/processing states, upload dropzone, signature pad, PDF thumbnails, footer |

### Implementation constraints (design within these)

- Frontend is **Angular 22 + Tailwind CSS v4** (CSS-first config). Deliver all tokens as CSS custom properties ready to paste into a Tailwind v4 `@theme` block. Dark mode will be a `.dark` class on `<html>`.
- The PDF canvas is **ngx-extended-pdf-viewer (pdf.js)**: you can restyle its frame, backdrop, and choose which of its native toolbar controls are hidden — you cannot redraw its internals pixel-by-pixel. Spec it as "shell + visibility rules", not a fantasy re-skin.
- Typography must be **self-hostable open-license faces** (Google-Fonts-downloadable or equivalent), max 2 families, woff2/variable preferred, `font-display: swap` with metric-compatible fallbacks. The site is ad-funded and prerendered for SEO — LCP and CLS are money.
- Motion never carries meaning: the codebase globally collapses all animation under `prefers-reduced-motion` and that stays. Motion is garnish only, 150–300 ms, calm.

## 2. Design brief — "Zen ink & paper"

The current app is a competent but anonymous indigo/slate Tailwind SaaS look with an emoji (🧘‍♀️) for a logo. Replace it wholesale. **Full rebrand: only the name "ZenPDF" is fixed.**

Make the name finally mean something. The direction is **Japanese stationery minimalism — paper and ink**:

- **Paper, not gray.** Warm paper-white neutrals for light mode (not blue-slate, not #FFFFFF everywhere — think washi, cream, bone). Surfaces feel like sheets: hairline rules, crisp edges, restrained shadows, maybe a folded-corner or deckle detail used sparingly.
- **Ink, not black.** Text in deep warm ink tones. Hierarchy through weight, size, and spacing more than through color.
- **One accent, used like a seal.** Pick ONE accent — vermilion seal-stamp red (hanko) or deep matcha green — and commit. It marks actions and moments that matter (primary CTA, "signed", completion), never decorates. If it's on the screen twice for no reason, that's a bug.
- **Ma (negative space) is the signature.** Generous, deliberate emptiness; asymmetric balance where it helps; a layout rhythm you define precisely (spacing scale + container widths), not vibes.
- **Signature motifs you must design:** (a) a real wordmark + compact logo mark (usable as favicon) — drawn, not typed-with-an-emoji; (b) a **hanko/seal-stamp motif** for completion states — a merged file, a signed document, a finished job gets "stamped"; (c) a **custom line-icon set for all 24 tools** on one grid with one stroke width — specify grid, stroke, corner radius, and show at least 8; the rest must be derivable from the spec.
- **Type with intent.** A characterful display face (humanist serif or calligraphic-influenced — your call) paired with a quiet, highly-legible UI sans. Name exact faces + weights + licensing note. Not Inter-because-default; if you choose a grotesque, justify the pairing in one sentence in the doc.
- **Voice:** calm, plain, honest. Microcopy never shouts, never upsells, states facts ("Files delete automatically after 24 hours"). Processing states breathe ("Merging… 3 of 5 pages") rather than spin frantically.
- **Zen moments (fresh UX, cheap to build):** a calm breathing progress indicator for jobs (static under reduced motion); the existing auto-delete/retention notice elevated into a designed trust element; drag-and-drop that feels like laying paper on a desk; the ceremony's finish moment sealed with the hanko stamp.

## 3. Originality bars (hard bans — this is the anti-slop clause)

**Banned outright:** indigo/purple-to-blue gradients; gradient text; glassmorphism; floating 3D blobs and clip-art mockup phones; emoji as icons anywhere in chrome; undraw/humaaans-style stock illustration; the default shadcn/Linear/Stripe cosplay look; a centered hero with two pill buttons over a soft gradient; three-feature-cards-with-emoji rows; fake logo walls or invented testimonials; dark mode as naive color inversion; #6366F1 and its Tailwind indigo family; Inter/Roboto/Open Sans as the display face.

**Required instead:** at least one ownable, repeatable signature element (the seal/stamp counts) applied consistently across screens; a precise, named layout rhythm; the **cover test** — a screenshot of any screen with the logo covered must still be recognizably ZenPDF and mistakable for no competitor (iLovePDF, Smallpdf, Adobe, Canva).

## 4. Light & dark mode (both first-class)

- **Two-layer tokens.** Primitive scales (paper, ink, accent, semantic status colors) → **semantic aliases** (`--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-ink`, `--color-ink-muted`, `--color-ink-faint`, `--color-accent`, `--color-accent-hover`, `--color-on-accent`, `--color-border`, `--color-border-strong`, `--color-focus`, `--color-success|warning|danger|info` + their subtle surface variants, `--color-canvas-backdrop`, `--color-ad-frame`…). Rename if you have better names, but components must consume **semantic tokens only**, and every semantic token needs a light and a dark value, side by side.
- **Dark is "night ink", not inversion.** Deep warm charcoal paper (never pure black, never blue-slate), surfaces lift via lightness + hairline borders rather than heavy shadow, accent recalibrated for dark backgrounds. PDF pages themselves stay white — design the canvas backdrop and page shadow for both modes so a white page looks intentional in dark mode.
- **Contrast is a gate, not a goal:** WCAG 2.1 AA in BOTH modes — ≥4.5:1 body text, ≥3:1 large text and UI components. **Disabled controls must still hit ≥3:1 and be unmistakably distinct from enabled ones** (see defect D5). Publish computed ratios for the key pairs in the doc.
- **Theme toggle in the header — every header variant** (marketing, app shell, auth, and the ceremony's minimal chrome): an icon button ≥44 px hit target, cycling or menu of **Light / Dark / System, default System**, choice persisted (`localStorage`), `aria-label` that announces the current state. Document as implementation notes: pre-paint inline script to prevent theme flash on the prerendered pages, and a per-mode `<meta name="theme-color">`.

## 5. Known defects the redesign must resolve (from the 2026-08-03 QA review)

- **D1** Primary buttons are currently three different colors (indigo, pale lavender, green on the ceremony) and the lavender doubles as the disabled look. Define exactly one primary treatment, one disabled treatment, and show them in every mockup including the ceremony's final CTA.
- **D2** After upload, the dashboard shows each file twice (a checkmarked confirmation list AND a grid card). Design one source of truth — e.g. the new card carries a transient "just uploaded" stamp.
- **D3** The workspace stacks the app's own tool nav on top of the full pdf.js toolbar — two rotates, two downloads, a rogue annotation pen. Your design decides the single owner of every editing affordance and lists exactly which pdf.js controls stay visible.
- **D4** The landing is 24 identical text cards with near-duplicate sublabels. Your directory uses the groups above, the custom icons, an instant type-to-filter, and clear scan hierarchy.
- **D5** Disabled buttons are white-on-lavender and illegible. Covered by the contrast gate in §4.
- **D6** Auth pages are bare floating cards: no logo, no way home, no password visibility toggle, no inline hint for the password rules, and no context for *why* an account helps (reasons exist: library / sign / settings). Design them as full citizens of the brand.
- **D7** First paint of unusual page sizes / RTL documents in the viewer can load small and clipped. State the rule: initial fit-to-width, content centered, calm.

## 6. Deliverable A — `design-instructions.md` (the contract)

A single self-contained markdown file, exactly this name. It will live in the repo and **every future UI change by any agent will be validated against it**, so it must let an agent build a screen you never mocked. Required sections:

1. **Design language** — concept, principles, the signature motifs, voice & microcopy rules (with 5+ example strings), logo/wordmark usage.
2. **Design tokens** — the complete two-layer system as CSS custom properties in a paste-ready Tailwind v4 `@theme` block: color primitives + semantic aliases (light AND dark values), typography (families, fallback stacks, sizes, line-heights, tracking, weights per role), spacing scale, radii, border widths, elevation/shadow, z-index layers, motion durations/easings, breakpoints, icon grid spec.
3. **Component specs** — for every global component in the inventory (§1), plus buttons (primary/secondary/ghost/destructive × default/hover/focus-visible/active/disabled/loading), inputs & validation, cards (tool card, file card), dropzone, progress/processing, toasts, modals, empty states, tabs/segmented workspace nav, badges/stamps, ad containers (per-surface sizes + reserved heights), signature pad, footer. Every state, both modes, concrete values.
4. **Screen guidance** — layout recipe per surface in the inventory, including the ones you don't mock (sign request builder/list/detail, verify, legal, 404, unsubscribe, verify-email), each in a few sentences + which components it composes.
5. **Theming implementation notes** — `.dark` class strategy, the Light/Dark/System toggle behavior, persistence key, FOUC-prevention script requirement, `theme-color` metas, how the PDF canvas backdrop responds.
6. **Accessibility contract** — computed AA contrast table for key pairs (both modes), focus-ring spec, hit targets ≥44 px, reduced-motion rule, landmark/heading structure expectations.
7. **Ad surface rules** — the three placements, container design, reserved heights, label, forbidden routes.
8. **RTL & future localization** — logical properties only (`margin-inline-start`, not `margin-left`), icon mirroring rules.
9. **Do & Don't** — 10+ pairs, including the bans from §3.
10. **Invariants** — restate §9 below so the contract carries it.

Numbers everywhere: no "generous spacing" without the value. No token without both mode values. No component without its disabled and focus states. **No affordance without an existing action behind it (§0)** — the contract's component and screen specs may only reference behavior that is in the repo today (plus the two sanctioned additions).

## 7. Deliverable B — mockups (core set)

High-fidelity, realistic content (real tool names, real file names like `lease-agreement.pdf`, no lorem, no fake metrics), every desktop frame showing the real header with the theme toggle, and **every interactive element backed by an existing action (§0)**. **Each of the nine core screens is delivered in BOTH modes** (`a` = light, `b` = dark — same layout, only tokens change; this is the proof the token system works). Name artboards/files exactly:

1. `01a/01b-landing-desktop` — hero + grouped, iconed, filterable tool directory (D4 solved), landing ad container
2. `02a/02b-tool-merge-desktop` — dropzone with two files added, options visible
3. `03a/03b-tool-merge-result-desktop` — result panel with download, "continue in workspace", tool-result ad container
4. `04a/04b-workspace-organize-desktop` — doc open, page thumbnails, single unified toolbar (D3 solved: show exactly which pdf.js controls survive)
5. `05a/05b-workspace-annotate-desktop` — the custom annotate overlay on the canvas
6. `06a/06b-dashboard-desktop` — post-upload state (D2 solved), dashboard-rail ad, and the library controls that exist today: storage meter, folders, search, star/trash filters, multi-select merge, import-from-URL
7. `07a/07b-ceremony-desktop` — consent gate + document, finish CTA (D1-consistent)
8. `08a/08b-auth-register-desktop` — D6 solved: branded header/home link, password affordances, contextual "why an account"
9. `09a/09b-settings-desktop` — the four sections that exist: profile (display name, email-verification state), storage & usage (incl. recent jobs), advertising consent, your data (export, delete account)
10. `10-landing-mobile-light`
11. `11-tool-merge-mobile-dark`
12. `12-ceremony-mobile-light` — signature step on a phone, where real signers live
13. `13a/13b-components` — component sheet in both modes: buttons all states, inputs & validation, cards, toasts, stamps, ad frame, theme-toggle states, empty state, progress

## 8. Handoff format

Produce a **handoff bundle for Claude Code**: `design-instructions.md` at the bundle root plus a `mockups/` folder (self-contained HTML per screen preferred, PNG acceptable) using the names above. The implementing agent works inside the existing Angular codebase — do not scaffold an app, do not output React, do not produce partial CSS frameworks. Mockups are reference; the contract file is law.

## 9. Product invariants (do not touch)

Routes and tool slugs; tool-page H1s and SEO copy semantics (polish wording, keep meaning and keywords); `data-test` attributes on interactive elements; the three-ad-surface limit and ad-forbidden routes; legal and e-sign disclosure texts verbatim; anonymous-first flows (no login walls, ever); the global reduced-motion collapse; RTL-safe logical properties.

## 10. Before you finish — self-check

Walk this list and fix anything that fails: (1) every semantic token has light + dark values and key pairs pass AA with ratios written down, including disabled states; (2) the theme toggle appears in every header variant of every mockup; (3) each of D1–D7 is resolved and you can point to where; (4) nothing from the §3 ban list appears; (5) token names used in mockups match the contract exactly; (6) an agent could build the sign request builder or `/verify` (unmocked) from the contract alone; (7) the cover test passes; (8) files are named exactly as specified, with `design-instructions.md` at the bundle root; (9) every interactive element in every mockup and spec maps to an action you can point to in the repo — or is one of the two sanctioned additions (§0) — with zero dead buttons or links, and the footer carries exactly the existing five links.
