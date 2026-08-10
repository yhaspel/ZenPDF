# ZenPDF — design-instructions.md

**The design contract for the "Zen ink & paper" redesign.** This file is law; the mockups in `mockups/` are reference. Where a mockup and this contract disagree, the contract wins. Every future UI change is validated against this document.

Grounding: built from the repo at `yhaspel/ZenPDF@main` (frontend: Angular 22 + Tailwind CSS v4). Every affordance specified here maps to an action that exists in the codebase today, plus exactly two sanctioned additions: the Light/Dark/System theme toggle and the landing directory's client-side type-to-filter. Nothing else new. No pricing, AI, sharing, templates, blogs, chat, or notification UI — ever.

---

## 1. Design language

### Concept — Zen ink & paper
ZenPDF is a quiet desk: warm paper surfaces, ink text, and one vermilion seal that marks the moments that matter. The name finally means something: calm, not decoration. Emptiness (ma) is deliberate — a screen should feel like a well-set page, not a dashboard.

### Principles
1. **Paper, not gray.** Every surface is a warm paper tone. Never blue-slate, never `#FFFFFF` as a page background (pure white is reserved for rendered PDF pages, which must read as *paper on the desk*).
2. **Ink, not black.** Hierarchy comes from size, weight and space — color is almost never the differentiator.
3. **One accent, used like a seal.** Vermilion (`--color-accent`) appears only on: the logo seal, the single primary action of a screen, focus rings, selection marks, and completion stamps. If vermilion is on screen twice with no reason, that is a bug to fix.
4. **Ma.** Section gaps on marketing pages are `--space-8`/`--space-9`. Do not fill space; compose it.
5. **Calm motion.** 150–300 ms, `cubic-bezier(.4,0,.2,1)`, garnish only. Everything must be fully usable with animation removed (the global `prefers-reduced-motion` collapse stays).

### Signature motifs
- **The seal (logo mark).** A vermilion rounded square (radius ≈ 22% of its size) carrying a stroked "Z" glyph (two horizontals joined by a diagonal, stroke 2.6/32 units, round caps, drawn in `--color-on-accent`). SVG source is in every mockup header (`.brand` block). Used at 28 px in headers, 20 px in compact bars, 56 px on the auth brand panel, and as the favicon (16/32 px). The wordmark is the seal + `Zen` (Shippori Mincho 700, `--color-ink-strong`) + `PDF` (Shippori Mincho 500, `--color-ink-muted`). Never the 🧘‍♀️ emoji, never typed-with-an-emoji.
- **The hanko stamp (completion).** Class `.stamp`: 2 px vermilion border + 1.5 px inset inner border (`box-shadow: inset 0 0 0 1.5px` at 45% accent), radius 6 px, Shippori Mincho 700, letter-spacing .22em, uppercase, rotated −4°, 7% accent wash fill. Appears **only when something finished**: a merged/converted result ("MERGED", "DONE"), a completed signature ("SIGNED"), a fresh upload's card ("JUST UPLOADED", small variant `.stamp-sm`). Entrance: scale 1.08→1 over 200 ms (static under reduced motion). Never used as a label, tag, or decoration.
- **The folded sheet.** Class `.sheet`: raised paper with a folded top-end corner (16 px CSS triangle). Reserved for trust/retention notices and empty states — at most one per screen.

### Voice & microcopy
Calm, plain, honest. States facts, never shouts, never upsells. Sentence case everywhere; no exclamation marks in chrome. Examples (use these verbatim where they fit):
1. "Files delete automatically after 24 hours."
2. "Merging… 3 of 5 pages"
3. "Everything already works without an account. An account is for keeping things."
4. "Free, paid for by advertising."
5. "Two files became one."
6. "Drop PDFs here, or click to browse"
7. "You were the last one — sealing the document now."
Processing copy breathes (progress counts pages/steps); errors say what happened and what to do next; the retention promise is surfaced proudly, not hidden.

---

## 2. Design tokens

Paste-ready for a Tailwind v4 `@theme` block (primitives + semantic aliases). **Components consume semantic tokens only.** Dark mode = `.dark` class on `<html>` overriding the semantic layer.

```css
@theme {
  /* --- primitives: paper --- */
  --paper-0: #FFFDF7;  --paper-50: #FBF8F1;  --paper-100: #F5F1E6;
  --paper-200: #EDE7D8; --paper-300: #E3DBC8; --paper-400: #C6BBA1;
  /* --- primitives: ink --- */
  --ink-900: #211C15; --ink-800: #332D24; --ink-700: #4A4337;
  --ink-600: #5F574A; --ink-500: #776E5E; --ink-400: #948A77;
  /* --- primitives: night paper --- */
  --night-900: #171310; --night-800: #1E1915; --night-700: #26201A;
  --night-600: #362F26; --night-500: #4A4234;
  /* --- primitives: vermilion (the seal) --- */
  --verm-700: #7E2717; --verm-600: #96301F; --verm-500: #B23A26;
  --verm-400: #D96A50; --verm-300: #E98B72;
  /* --- primitives: status --- */
  --pine-600: #2F6B46;   --pine-300: #8CC3A0;
  --ochre-600: #8A6212;  --ochre-300: #D8B25E;
  --crimson-600: #8E2A38; --crimson-300: #E08296;
  --water-600: #3D6478;  --water-300: #9CC0D4;

  /* --- typography --- */
  --font-display: "Shippori Mincho", Georgia, "Times New Roman", serif;
  --font-ui: "Zen Kaku Gothic New", -apple-system, "Segoe UI", system-ui, sans-serif;

  /* --- rhythm --- */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px; --space-9: 96px;
  --radius-1: 4px; --radius-2: 6px; --radius-3: 10px;
  --border-hairline: 1px; --border-emphasis: 2px;
  --shadow-1: 0 1px 2px rgba(50,40,25,.06);
  --shadow-2: 0 2px 8px rgba(50,40,25,.10);
  --shadow-3: 0 8px 28px rgba(50,40,25,.16);
  --dur-1: 150ms; --dur-2: 220ms; --dur-3: 300ms;
  --ease: cubic-bezier(.4,0,.2,1);
}
```

Semantic aliases — **every token has both values**; light in `:root`, dark under `.dark`:

| Semantic token | Light | Dark ("night ink") |
|---|---|---|
| `--color-bg` | `--paper-100` #F5F1E6 | `--night-900` #171310 |
| `--color-surface` | `--paper-50` #FBF8F1 | `--night-800` #1E1915 |
| `--color-surface-raised` | `--paper-0` #FFFDF7 | `--night-700` #26201A |
| `--color-ink` | `--ink-800` #332D24 | #EFE8DA |
| `--color-ink-strong` | `--ink-900` #211C15 | #F8F3E7 |
| `--color-ink-muted` | `--ink-600` #5F574A | #BDB29E |
| `--color-ink-faint` | #6F6656 | #9A9080 |
| `--color-accent` | `--verm-500` #B23A26 | `--verm-400` #D96A50 |
| `--color-accent-hover` | `--verm-600` #96301F | `--verm-300` #E98B72 |
| `--color-accent-active` | `--verm-700` #7E2717 | #F2A992 |
| `--color-on-accent` | #FFFDF7 | #171310 |
| `--color-accent-surface` | #F6E4DD | #3B241C |
| `--color-border` | `--paper-300` #E3DBC8 | `--night-600` #362F26 |
| `--color-border-strong` | `--paper-400` #C6BBA1 | `--night-500` #4A4234 |
| `--color-focus` | `--verm-500` | `--verm-400` |
| `--color-success` / `-surface` | #2F6B46 / #E6EEE2 | #8CC3A0 / #22301F |
| `--color-warning` / `-surface` | #8A6212 / #F3EAD2 | #D8B25E / #332A14 |
| `--color-danger` / `-surface` | #8E2A38 / #F3E0E0 | #E08296 / #38202A |
| `--color-info` / `-surface` | #3D6478 / #E2EAEE | #9CC0D4 / #1D2B33 |
| `--color-canvas-backdrop` | #E9E2D0 | #121009 |
| `--color-page-shadow` | rgba(60,50,30,.18) | rgba(0,0,0,.55) |
| `--color-ad-frame` | `--paper-200` #EDE7D8 | #231E18 |
| `--color-scrim` | rgba(33,28,21,.45) | rgba(0,0,0,.6) |

Dark shadows: `--shadow-1/2/3` swap to rgba(0,0,0,.40/.45/.55). Dark surfaces lift by **lightness step + hairline border**, never by heavier shadow alone.

### Typography
- **Display: Shippori Mincho** — weights 500, 600, 700. Humanist Mincho serif; carries the "ink & paper" character in Latin as well as it does in Japanese. OFL (Google Fonts), self-host woff2, `font-display: swap`; metric fallback Georgia.
- **UI: Zen Kaku Gothic New** — weights 400, 500, 700. Quiet, highly legible gothic sans, chosen (over a default grotesque) because its round terminals sit naturally beside a Mincho. OFL, self-host woff2, `font-display: swap`; fallback `-apple-system, "Segoe UI", system-ui, sans-serif` with `size-adjust` tuned at implementation.
- Roles: h1 display 600 at 34 px/1.25 (the landing h1 is the header masthead — §3); h2 display 600 22 px; h3 display 600 17 px; body UI 400 15 px/1.6; small 13.5 px; caption/hints 12.5 px; kicker UI 500 11 px, tracking .14em, uppercase, `--color-ink-faint`. Minimum text size anywhere: 11 px (kickers/legal footers only).

### Layout rhythm
Spacing scale above (4-based). Container widths: **marketing 1120 px**, **tool pages 720 px**, **reading (legal) 640 px**, **app shell full-width with 32 px gutters** (16 px under 768 px). Grid gaps: cards 12–16 px, page thumbnails 20 px. Radii: inputs/buttons 6 px, cards 10 px, sheets/page thumbs 2–4 px. Borders are hairline 1 px; 2 px only for emphasis (focus, selection, stamp).

### Icon grid
24×24 viewBox, 20×20 live area (2 px padding), stroke 1.5, round caps and joins, no fills (single exception: the redact bar and star-when-starred fill with `currentColor`), corner radius 1 on document shapes. Icons inherit `currentColor`; default color `--color-ink-muted`. All 24 tool icons are drawn on this grid — 24 reference SVGs ship in the mockups (see the landing directory); any new icon must be derivable from this spec.

### Z-index layers
`0` content · `10` sticky bars · `20` popover menus · `30` banners · `40` modals + scrim · `50` toasts.

### Breakpoints
`sm 640` · `md 768` · `lg 1024` · `xl 1280` (dashboard rail appears ≥ xl, as today) · `2xl 1440`.

---

## 3. Component specs

All values are for both modes via semantic tokens. Every interactive element keeps its existing `data-test` attribute.

### Buttons (`.btn`)
Base: UI 500 15 px, min-height 44 px (compact `.btn-sm` 36 px, never under 32 px), padding 0 20 px, radius 6 px, transitions `--dur-1`.
- **Primary** (one per screen, the screen's real action): bg `--color-accent`, text `--color-on-accent`. Hover `--color-accent-hover`; active `--color-accent-active`; loading: 14 px currentColor ring spinner + progressive label ("Merging…"). **This includes the ceremony's final CTA and the request builder's "Send it"** — the green/lavender variants are retired (defect D1).
- **Secondary**: bg `--color-surface-raised`, 1 px `--color-border-strong`, text `--color-ink`. Hover: border `--color-ink-faint`.
- **Ghost**: transparent, text `--color-ink-muted`; hover bg `--color-surface-raised` (dark: `--color-surface`).
- **Destructive**: transparent, 1 px `--color-danger` border, text `--color-danger`; hover bg `--color-danger-surface`. Filled `--color-danger` + white only on final confirmation inside a confirm panel.
- **Disabled (all variants, one treatment — defect D5)**: transparent bg, 1 px **dashed** `--color-border-strong` border, text `--color-ink-muted` (6.3:1 light / 8.8:1 dark — comfortably ≥3:1), `cursor: not-allowed`. Unmistakably distinct from every enabled variant (dashed hairline vs solid fill/border).
- **Focus-visible (everything interactive)**: `outline: 2px solid var(--color-focus); outline-offset: 2px`.

### Inputs & validation
Min-height 44 px, padding 0 14 px, radius 6 px, bg `--color-surface-raised`, 1 px `--color-border-strong`; placeholder `--color-ink-faint`; hover border `--color-ink-faint`; focus = focus ring (border transparent); disabled: bg `--color-bg`, dashed border, text `--color-ink-muted`. Invalid: border `--color-danger` + `aria-invalid` + error line 13 px `--color-danger` below (always in the DOM for screen readers where the code already does this). Hints 12.5 px `--color-ink-faint`. Password fields get a 44×44 px visibility toggle inside the field (eye icon) and an inline rules hint (defect D6). Checkboxes/ranges: `accent-color: var(--color-accent)`.

### Cards
- **Tool card (landing)**: icon (24 px, `--color-ink-muted`) + name (UI 500 15 px), padding 16/18, bg `--color-surface`, hairline border, radius 10 px. Hover: border `--color-ink-faint`, name `--color-ink-strong`. No sublabels — the group heading carries context (defect D4).
- **File card (dashboard)**: radius 10 px, padding 12, thumbnail 3:4 white with `--color-page-shadow`, checkbox top-start, ⋯ menu top-end (menu: raised surface, shadow-3, existing actions only: Rename / Download / Trash, or Restore / Delete forever in trash), star toggle (accent when starred), title UI 500 14 px, meta 12 px faint (`N pages · N MB`, lock glyph if encrypted). **A just-uploaded file appears once, as its grid card wearing a transient "JUST UPLOADED" `.stamp-sm` for ~6 s (fade 300 ms; no separate confirmation list — defect D2).** Upload *progress* rows may exist only while the upload is in flight and must disappear on completion.

### Dropzone
"Paper laid on a desk": bg `--color-surface-raised`, 1 px **dashed** `--color-border-strong`, radius 4 px, padding 48/24 (compact 24), sheet-with-arrow icon 36 px, prompt UI 500 15 px, hint 12.5 px faint. Drag-over: border solid `--color-accent`, bg `--color-accent-surface` (transition `--dur-2` — the sheet "receives" the paper). Whole zone is the click target and a labelled file input.

### Progress / processing
- **The breath**: 34 px circle, 2 px `--color-accent` border, scaling .82→1 with opacity .55→1 over 2.6 s ease-in-out, beside counting copy ("Merging… 3 of 5 pages"). Under reduced motion the circle is static at full scale and the counter alone carries progress. No frantic spinners anywhere.
- **Meter**: 6 px track `--color-bg` + hairline, fill `--color-accent`, radius 3 px (storage, upload %).

### Toasts
Bottom-end stack, max-width 360 px, raised surface + hairline + shadow-3, radius 6 px, 3 px inline-start rule: success `--color-success`, error `--color-danger`, info `--color-ink-faint`. Text 14 px ink. Click dismisses (as today); `role=alert` on errors, `status` otherwise. No colored fills — toasts are ink on paper with a colored spine.

### Modals
Scrim `--color-scrim`; dialog raised surface, radius 10 px, shadow-3, padding 24, max-width 28 rem (signature pad 32 rem); title display 600 17 px; actions end-aligned, primary last. Esc closes (existing `zenModal` behavior).

### Empty states
`.sheet` (folded corner), centered, icon 24 px faint, title display 500 16 px, subtitle 13.5 px muted. No emoji.

### Tabs / segmented workspace nav (`.seg`)
Row of 36 px text buttons, radius 6 px; idle `--color-ink-muted`; hover bg `--color-bg`; **selected: bg `--color-ink-strong`, text `--color-bg`** (ink stamp, not accent — accent stays reserved). Used for workspace modes, signature-pad tabs, job filters (badge-sized variant).

**Semantics — toggle buttons, not ARIA tabs.** Each is a plain `<button>` carrying `aria-pressed`; the row is a `<div role="group">` with an `aria-label`. Never `aria-selected` (invalid on `role=button`) and never `role="tablist"` (it obliges every child to be a `role=tab`, which then needs `aria-controls`, `role=tabpanel` and roving tabindex). Both mistakes shipped once and were caught only after an earlier contrast failure stopped masking them — every `.seg` button stays individually tabbable.

### Badges / stamps
Badge: pill, hairline `--color-border-strong`, 12 px muted text; status tints use the status surface+color pairs (`completed` pine, `declined` crimson). The `.stamp` is specified in §1 and is not a badge — never use it for status words that aren't completions.

### Ad container (`.ad-frame`)
Honest and bounded: 1 px **dashed** `--color-border-strong` frame, radius 6 px, bg `--color-ad-frame`, 12 px padding, top label "ADVERTISEMENT" (10 px, tracking .16em, `--color-ink-faint`). The inner unit box is **reserved at fixed min-height before load** (zero CLS): landing 250 px, tool-result 280 px, dashboard rail 300×600, dashboard mobile inline 250 px. Unfilled collapses silently (existing behavior). Never styled to resemble content; never borderless.

### Signature pad
Tabs Draw / Type / Upload as `.seg` pills. Canvas: pure white (`#FFFFFF` — it is paper), 1 px `--color-border-strong`, radius 6 px, 3:1 ratio, dashed baseline rule 16 px above the bottom edge; ink stroke #332D24 at 2.6 px. Type tab keeps the existing four server-rendered fonts as pill choices. "Use this" is the dialog's primary (vermilion); Clear/Cancel ghost.

### Headers (all variants carry the theme toggle, 44×44 px)
- **Marketing** (`/`, `/<slug>`, legal): 65 px, `--color-surface`, hairline bottom; brand start; nav end: contextual links (exactly today's: My files ⁄ Log in + Create free account ⁄ register) + toggle. On `/` only, the brand is followed by the page's `<h1>` as a masthead motto: display 500 16 px `--color-ink-muted`, hairline inline-start divider, exact text "Every PDF tool, no account needed"; below `lg` it wraps to a second 13.5 px header line so it stays visible at every viewport (compact landing, 2026-08-10).
- **App shell**: same bar; nav = Documents, Settings, user email (plain text), Log out, toggle. Active route: ink-strong + 500.
- **Workspace bar** (replaces app header inside `/app/doc/:id`): ← back, 20 px seal, document title (click to rename, as today), `vN · N pages` meta, then the `.seg` mode nav (View · Organize · Edit · Annotate · Forms · Convert · Compare · Sign · Protect), divider, Split and Compress (ghost), Download (secondary), toggle.
- **Ceremony / auth**: minimal — brand, (envelope code in ceremony), toggle. Nothing else.

### Guest & consent banners
Guest banner: `--color-surface` strip under the header, hairline bottom, 13.5 px muted text stating the fact + time left, end link "Create a free account to keep these files" (plain accent-hover link, not a button). Expired notice uses `--color-warning-surface`; account-required prompt uses `--color-info-surface`. Consent banner: fixed bottom raised sheet, hairline top, two **equal-weight secondary buttons** ("No thanks" / "Allow") — symmetry is deliberate and stays.

### Footer (`.ftr`)
Hairline top, centered, 12.5 px faint; exactly the five existing links — About · Privacy · Terms · E-sign disclosure · Verify a signed PDF — plus the fact line "Free, paid for by advertising. Files are deleted automatically." Nothing added. The ceremony's footer keeps its own existing set (About · Privacy · Terms · E-sign disclosure · Report this request) plus the not-a-QES sentence, verbatim.

### PDF thumbnails & canvas
Rendered pages and thumbnails sit on `--color-canvas-backdrop` and are pure white with `--color-page-shadow` (1 px hairline in dark mode so a white page reads as intentional, floating paper). Thumbnails radius 2 px.

---

## 4. Screen guidance

Every surface, including unmocked ones. Compose only from §3 components.

- **Landing `/`** *(mockups 01, 10 — superseded by the compact landing 2026-08-10, see `2026-08-10-compact-landing.md`; the contract wins)*: marketing header carrying the masthead h1 (§3) → filter row, 32 px under the header: type-to-filter input at start (max-width 380 px; filters the 24 cards by name/synonyms, hides empty groups, shows a calm empty line; pure client-side) + compact one-line folded-sheet trust strip at end (the three facts verbatim, 13 px muted, hairline separators; wraps under the filter on narrow viewports) → six kicker-headed groups (Organize 7 · Edit & annotate 4 · Convert & OCR 6 · Optimize & review 3 · Protect 3 · Sign 1) of icon+name tool cards, 3-up (2-up mobile) → landing ad frame → footer. There is no hero block. No other CTAs; the directory is the hero.
- **Tool page `/<slug>`** *(02, 03, 11)*: marketing header; 720 px column; existing H1 + meta description line; widget card = dropzone → picked-file rows (name, size, Remove ghost) → min-files hint when short → full-width primary CTA (existing `cta` text) → retention line. Running: the breath + counting copy replaces the CTA. Result: stamp + one-line summary, result rows (Download primary-sm, Open in workspace secondary-sm), retention line, tool-result ad frame, "Do another one" ghost, guest keep-note (hairline box, fact + register link). Below: existing intro paragraphs and FAQ (reading width), footer.
- **Workspace `/app/doc/:id`** *(04, 05)*: the workspace bar (§3) is the **single owner of every editing affordance — defect D3**. The pdf.js (ngx-extended-pdf-viewer) toolbar is reduced by visibility config to exactly: **zoom out/in, zoom select, page up/down + page number, and find**. Hidden: pdf.js download, print, open-file, rotate, draw/ink editor, text editor, stamp editor, presentation, scrolling/spread menus, sidebar toggle (our rail replaces it) — rotate lives only in Organize, download only in our bar, annotation only in Annotate. View mode: left rail (Pages / Outline / History tabs), canvas center. Organize: toolbar row (N selected · Rotate · Delete · Duplicate · Extract · Insert blank · Crop · Scale · N-up · "Drag pages to reorder") over a 6-up thumbnail grid on the backdrop; selection = 2 px accent outline + corner seal tick. Annotate: left tool palette (16 existing tools, icon+label), colour/width/opacity (+font size, stamp picker contextually), custom stamp upload; center page bar (page nav, zoom, unsaved badge, Save primary-sm, Flatten secondary-sm); right comments rail. Dialogs (Split/Compress/Scale/N-up/Insert) per §3 modals. **First paint rule (defect D7): initial zoom fit-to-width, content centered, backdrop `--color-canvas-backdrop` — for every page size and for RTL documents; no small-and-clipped first render.**
- **Dashboard `/app/dashboard`** *(06)*: app header; three columns ≥ xl (sidebar 224 / main / rail 300). Sidebar cards: storage meter; folders (All + user folders + new-folder input); Starred / Trash toggles. Main: search + (when ≥2 selected) "Merge N" primary; dropzone (imports anything convertible — keep existing hint copy); import-from-URL row; converting/uploading transient rows; file-card grid 4-up (D2 rule in §3); Load more (secondary) + "Showing X of Y". Rail: dashboard ad frame. Mobile: one inline ad card after the third card (existing behavior). Claim banner (post-signup) = success-surface strip, "Got it" dismiss.
- **Sign request builder `/app/sign/new/:docId`** *(unmocked)*: workspace-style top bar (← back to the document, "Send for signature", doc title) + step dots 1–4 (filled dot = `--color-ink-strong`). Step 1 recipients: rows (email, name, role select, order number, ✕ ghost) + "Add someone" secondary + role explainer 11 px faint + "Next: place fields" primary. Step 2: left rail (recipient pills with per-recipient dot colors — recipient colors are content, exempt from the one-accent rule; field-type grid; Required checkbox) + page canvas with drag-to-place boxes. Step 3: message textarea, expiry/reminder number inputs. Step 4 review: recipient list, freeze note, email-verification gate (warning surface) when unverified, **"Send it" as a standard vermilion primary**.
- **Sign request list `/app/sign`** *(unmocked)*: 768 px column; ← Documents; h1 "Sent for signature"; request rows (title, envelope code faint, status badge, recipient chips). Empty state sheet: "Nothing sent yet. Open a document and choose 'Send for signature'."
- **Sign request detail `/app/sign/:id`** *(unmocked)*: title, envelope + status line; Progress/Audit `.seg`; recipient rows with status badges and decline reasons; completed → Download signed (primary) + Certificate (secondary) + SHA-256 fingerprint 11 px faint; sent → Send a reminder / Cancel the request (secondary / destructive). Audit tab: chain-intact notice (success/danger surface) + plain `.tbl`.
- **Ceremony `/s/:token`** *(07, 12)*: minimal header (seal, ZenPDF, envelope code, toggle). Zero ads, zero playfulness, phone-first (single column, max-width 42 rem). Consent: title, sender line, quoted message, scrollable disclosure region (focusable, labelled), version+fingerprint note, consent checkbox, **"Agree and continue" vermilion primary**, decline ghost. Sign: sticky title + progress line ("2 of 3 fields done · next: …"); field cards (active = accent border); page image with overlay boxes (pending accent-tinted, done success-tinted with ✓); **"Finish signing" vermilion primary** (disabled treatment until complete); decline ghost. Done: "SIGNED" stamp + downloads. Wait/closed/error: plain reading pages. Ceremony footer per §3.
- **Verify `/verify`** *(unmocked)*: marketing header, 720 px column, h1, explainer, dropzone, "Checking…" breath, report card: neutral = raised surface, intact = success surface, modified = danger surface; headline display 600; detail `dl` grid 12.5 px; envelope-match block; the existing what-this-checks caveat 11 px faint. No ads (enforced in code).
- **Auth `/auth/login`, `/auth/register`** *(08)*: slim header (brand + toggle — the way home, defect D6). Register: 44% brand panel (56 px seal, "Everything already works without an account." display h2, the three real reasons as icon rows, "← Back to the tools") + form card (reason banner on info surface when `?reason=`, guest claim note, Name/Email/Password with eye toggle + rules hint, terms checkbox, primary, login link). Login: same frame, shorter form (Email, Password+eye, primary, register link). Error banner: danger surface, 13.5 px.
- **Settings `/app/settings`** *(09)*: app header; 720 px column; four cards exactly: Profile (email disabled input, display name + Save secondary); email-verification banner when unverified (warning surface card); Storage and usage (meter, four-row usage table, Recent jobs filter pills + table); Advertising (only when ads enabled; current choice sentence + Decline/Allow equal secondaries); Your data (Download my data secondary, Delete my account destructive → inline danger-surface confirm panel with password input and filled-danger "Delete everything").
- **Legal / about / disclosure `/legal/*`, `/about`**: marketing header, 640 px reading column, display headings, 16 px/1.75 body, no ads (enforced), footer.
- **404**: marketing header, centered sheet: display "This page does not exist.", one muted line, "← Back to the tools" link. No search, no illustration.
- **Unsubscribe / verify-email `/unsubscribe/:token`, `/verify-email/:token`**: single centered card stating the outcome in one sentence + one link home. Verify-email success may carry the "DONE" stamp.

---

## 5. Theming implementation notes

- `.dark` on `<html>`; semantic custom properties re-declared under `.dark` (see §2). Components never reference primitives or raw hex.
- **Toggle**: icon button (sun / moon / monitor at 20 px on the 1.5-stroke grid), ≥44 px hit target, in **every** header variant including ceremony and auth. Cycles Light → Dark → System (default System). `aria-label` announces current state ("Theme: Dark — change theme"). Persist under `localStorage["zenpdf.theme"]` with values `light|dark|system`.
- **FOUC prevention**: a classic, non-deferred `<head>` script (before any stylesheet paint) on the prerendered pages: read the key, resolve `system` via `matchMedia('(prefers-color-scheme: dark)')`, set the class synchronously. Also listen for system changes while `system` is active. It must be an **external same-origin file** (`public/theme-boot.js`), never an inline block — production serves `script-src 'self' 'wasm-unsafe-eval'`, so inline script is refused and the theme is silently never applied before hydration. For the same reason the production build sets `styles.inlineCritical: false`: Angular's critical-CSS inlining ships the stylesheet as `media="print"` with an inline `onload` handler to activate it, and that handler is an inline event handler the CSP also refuses — which left the entire non-critical stylesheet, `.dark` tokens included, inert in production. Neither may be reintroduced without adding a CSP hash for it.
- `<meta name="theme-color">` per mode: light `#F5F1E6`, dark `#171310` (swap on toggle; both emitted with `media` attrs for prerender).
- PDF canvas: backdrop `--color-canvas-backdrop` responds to mode; pages stay white; in dark mode add the hairline page border. The viewer shell (`ngx-extended-pdf-viewer` frame/toolbar) is restyled via its CSS variables/theme hooks to surface + ink tokens — shell and visibility rules only, no pixel re-skin of internals.

## 6. Accessibility contract

Computed WCAG 2.1 contrast (relative-luminance math, rounded):

| Pair | Light | Dark | Requirement |
|---|---|---|---|
| body: ink on bg | #332D24/#F5F1E6 **12.1:1** | #EFE8DA/#171310 **15.2:1** | ≥4.5 ✓ |
| muted: ink-muted on bg | **6.3:1** | **8.8:1** | ≥4.5 ✓ |
| faint: ink-faint on bg | **5.0:1** | **5.9:1** | ≥4.5 ✓ |
| faint: ink-faint on surface-raised | **5.6:1** | **5.1:1** | ≥4.5 ✓ |
| faint: ink-faint on ad-frame | **4.6:1** | **5.3:1** | ≥4.5 ✓ (10 px ad label) |
| primary btn: on-accent on accent | **5.9:1** | **5.4:1** | ≥4.5 ✓ |
| accent as text/icon on bg | **5.3:1** | **5.1:1** (on surface) | ≥3 (UI) ✓, also passes 4.5 |
| disabled btn text: ink-muted on bg | **6.3:1** | **8.8:1** | ≥3 ✓ (D5 resolved) |
| focus ring on bg | **5.3:1** | **4.4:1** | ≥3 ✓ |

- Focus: `:focus-visible` 2 px `--color-focus`, offset 2 px, everywhere; never removed, never browser default.
- Hit targets ≥44×44 px for all controls (compact 36 px buttons only inside dense desktop toolbars, with ≥8 px spacing).
- Reduced motion: the existing global collapse stays; the breath and stamp degrade to static as specified.
- Landmarks: one `<h1>` per page (tool pages keep their exact H1s); `header/nav/main/footer` on every screen; toasts remain live regions; disclosure box remains a focusable labelled region; error messages keep their always-present `role=alert` pattern.
- Disabled controls remain ≥3:1 and pattern-distinct (dashed border), per D5.

## 7. Ad surface rules

Exactly three surfaces, all in `.ad-frame` with the "ADVERTISEMENT" label and reserved heights: **landing** (bottom of directory, 250 px), **dashboard rail** (300×600, ≥ xl; one inline 250 px card after the third file card below xl), **tool result** (280 px, inside the result panel, below the download row). Forbidden and enforced in code: `/s/*`, `/verify`, `/legal/*`, `/app/doc/*` — never beside an open document canvas. Nothing loads without consent; unfilled collapses silently; no ad-blocker nagging. The frame is never disguised as content.

## 8. RTL & future localization

Logical properties only: `margin-inline-start`, `padding-inline-end`, `inset-inline-start`, `border-start-start-radius`, `text-align: start` — never left/right physical properties in new CSS. Layouts flip cleanly under `dir="rtl"`. Icon mirroring: directional icons (back arrow, extract, next/prev chevrons, the convert arrows) mirror in RTL; document, seal, stamp, lock, star and signature icons do not. The seal glyph "Z" never mirrors. Dates/numbers via locale-aware formatting when localization lands.

## 9. Do & Don't

| Do | Don't |
|---|---|
| Reserve vermilion for the seal, one primary action, focus, selection, stamps | Use accent for decoration, headings, hover tints on random text |
| Warm paper bgs from the token table | Blue-slate grays, pure #FFF page backgrounds, `#6366F1`/Tailwind indigo anywhere |
| Hierarchy by size/weight/space | Hierarchy by rainbow of text colors |
| One primary treatment everywhere incl. ceremony (D1) | Green/lavender/indigo primaries per page |
| Dashed-hairline disabled treatment, ≥3:1 (D5) | Opacity-40 disabled or white-on-lavender |
| The stamp only on completions | Stamps as labels, badges as stamps |
| `.sheet` folded corner at most once per screen | Folded corners on every card |
| Reserved-height dashed ad frames labeled "Advertisement" | Ads that shift layout or masquerade as content |
| Shippori Mincho display + Zen Kaku Gothic New UI, self-hosted, swap | Inter/Roboto/Open Sans display; CDN-only fonts; >2 families |
| Logical properties, mirrored directional icons | `margin-left`, physical insets, mirrored wordmark |
| Calm 150–300 ms garnish motion, reduced-motion safe | Meaningful motion, spinners that spin frantically, parallax |
| State facts: "Files delete automatically after 24 hours." | Upsell copy, exclamation marks, countdown pressure |
| Emoji only in user content | Emoji as icons or logo (🧘‍♀️ is retired) |
| Gradient-free paper surfaces | Indigo-to-blue gradients, gradient text, glassmorphism, 3D blobs, fake testimonials/logo walls |

## 10. Invariants (do not touch)

Routes and all 24 tool slugs; tool-page H1s and SEO copy semantics (wording may be polished, meaning and keywords kept); every existing `data-test` attribute on interactive elements; the three-ad-surface limit and the ad-forbidden routes; legal and e-sign disclosure texts verbatim (incl. the ceremony's not-a-QES footer sentence); anonymous-first flows — no login walls, gates, teaser blurs or nags on anonymous use, ever; the global `prefers-reduced-motion` collapse; RTL-safe logical properties; the footer's exact five links; no dead UI — every affordance maps to an implemented action (the theme toggle and landing filter are the only two additions sanctioned with this redesign).
