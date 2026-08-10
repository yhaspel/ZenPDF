import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { AuthFacade } from '../../abstraction/auth.facade';
import { SITE_URL, setCanonical } from '../../core/site';
import { TOOL_PAGES } from '../../core/tool-pages';
import { AdSlot } from '../../shared/ad-slot';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';
import { ToolIcon } from '../../shared/tool-icon';

interface DirectoryEntry {
  slug: string;
  /** The short card name — the group heading carries the rest of the context (D4). */
  name: string;
  /** What the filter matches besides the name: synonyms people actually type. */
  keywords: string;
}

interface DirectoryGroup {
  heading: string;
  tools: DirectoryEntry[];
}

/**
 * The six kicker-headed groups of the landing directory (design contract §4).
 * Every slug here must exist in TOOL_PAGES; anything in TOOL_PAGES that is not
 * placed in a group is appended to a trailing group so no tool can silently
 * fall out of the directory.
 */
const DIRECTORY: DirectoryGroup[] = [
  {
    heading: 'Organize',
    tools: [
      { slug: 'merge-pdf', name: 'Merge PDFs', keywords: 'merge pdf files combine' },
      { slug: 'split-pdf', name: 'Split a PDF', keywords: 'split a pdf' },
      { slug: 'organize-pdf', name: 'Organize pages', keywords: 'organize pdf pages reorder' },
      { slug: 'rotate-pdf', name: 'Rotate pages', keywords: 'rotate pdf pages' },
      { slug: 'delete-pdf-pages', name: 'Delete pages', keywords: 'delete pages from a pdf remove' },
      { slug: 'extract-pdf-pages', name: 'Extract pages', keywords: 'extract pages from a pdf' },
      { slug: 'add-page-numbers', name: 'Page numbers', keywords: 'add page numbers to a pdf' },
    ],
  },
  {
    heading: 'Edit & annotate',
    tools: [
      { slug: 'edit-pdf', name: 'Edit a PDF', keywords: 'edit a pdf text' },
      { slug: 'annotate-pdf', name: 'Annotate', keywords: 'annotate a pdf highlight comment' },
      { slug: 'fill-pdf-form', name: 'Fill out a form', keywords: 'fill out a pdf form' },
      { slug: 'watermark-pdf', name: 'Watermark', keywords: 'add a watermark to a pdf' },
    ],
  },
  {
    heading: 'Convert & OCR',
    tools: [
      { slug: 'pdf-to-word', name: 'PDF to Word', keywords: 'convert pdf to word docx' },
      { slug: 'word-to-pdf', name: 'Word to PDF', keywords: 'convert word to pdf' },
      { slug: 'jpg-to-pdf', name: 'Images to PDF', keywords: 'convert images jpg jpeg png to pdf' },
      { slug: 'pdf-to-jpg', name: 'PDF to images', keywords: 'convert pdf to images jpg jpeg png' },
      { slug: 'html-to-pdf', name: 'HTML to PDF', keywords: 'convert html to pdf web page' },
      { slug: 'ocr-pdf', name: 'OCR a scan', keywords: 'ocr make a scanned pdf searchable' },
    ],
  },
  {
    heading: 'Optimize & review',
    tools: [
      { slug: 'compress-pdf', name: 'Compress', keywords: 'compress a pdf smaller shrink' },
      { slug: 'repair-pdf', name: 'Repair', keywords: 'repair a damaged broken pdf' },
      { slug: 'compare-pdf', name: 'Compare two PDFs', keywords: 'compare two pdfs diff' },
    ],
  },
  {
    heading: 'Protect',
    tools: [
      { slug: 'protect-pdf', name: 'Protect', keywords: 'password protect encrypt a pdf' },
      { slug: 'unlock-pdf', name: 'Unlock', keywords: 'remove a password from a pdf unlock decrypt' },
      { slug: 'redact-pdf', name: 'Redact', keywords: 'redact a pdf black out' },
    ],
  },
  {
    heading: 'Sign',
    tools: [{ slug: 'sign-pdf', name: 'Sign a PDF', keywords: 'sign a pdf signature esign' }],
  },
];

/**
 * The landing page is a directory of working tools, not a signup wall (§21.1).
 * The directory IS the hero (design contract §4, compact since 2026-08-10 —
 * see docs/design/2026-08-10-compact-landing.md): the header carries the h1 as
 * a masthead motto, the folded sheet is one line of the three trust facts
 * beside the client-side type-to-filter, then six groups of icon+name cards,
 * one ad frame, footer. No hero block, no other CTAs.
 *
 * An authenticated visitor is no longer bounced to the dashboard: the tools are
 * the product for both principals, and the library is one click away in the nav.
 */
@Component({
  selector: 'app-landing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AdSlot, SiteFooter, Brand, ThemeToggle, ToolIcon],
  template: `
    <div class="page-shell">
      <!-- The masthead: on this page only, the header carries the page's h1
           as a motto after the brand (§3). It wraps to a second header line
           below lg so the h1 stays visible at every viewport. -->
      <header class="hdr hdr-mast">
        <a routerLink="/" class="brand" aria-label="ZenPDF"><app-brand /></a>
        <h1 class="masthead">Every PDF tool, no&nbsp;account&nbsp;needed</h1>
        <nav>
          @if (auth.isAuthenticated()) {
            <a routerLink="/app/dashboard" data-test="cta-library">My files</a>
          } @else {
            <a routerLink="/auth/login" data-test="cta-login">Log in</a>
            <a routerLink="/auth/register" class="btn btn-secondary btn-sm" data-test="cta-register"
              >Create free account</a
            >
          }
          <app-theme-toggle />
        </nav>
      </header>

      <main class="wrap w-full pb-24 pt-8">
        <!-- The directory begins immediately (§4): the type-to-filter (one of
             the redesign's two sanctioned additions, contract §0/§4) at the
             start, and the folded sheet — the three trust promises, stated as
             facts (§1) — shrunk to one line at the end. -->
        <div class="flex flex-wrap items-center justify-between gap-6">
          <div class="input-wrap grow max-w-[380px]">
            <input
              class="input"
              type="search"
              placeholder='Filter the tools… try "merge" or "sign"'
              aria-label="Filter the 24 tools"
              [value]="query()"
              (input)="onQuery($event)"
              data-test="tool-filter"
            />
            <span class="input-eye pointer-events-none" aria-hidden="true">
              <svg class="ti" viewBox="0 0 24 24" style="width:18px;height:18px">
                <circle cx="11" cy="11" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
            </span>
          </div>
          <div class="sheet trust-line">
            <span>No watermarks</span>
            <span>Files delete automatically after 24&nbsp;hours</span>
            <span>Free, paid for by advertising</span>
          </div>
        </div>
        @if (nothingMatches()) {
          <p class="faint mt-4" data-test="tool-filter-empty">
            No tool matches that. Clear the filter to see all 24.
          </p>
        }

        <div class="mt-8 flex flex-col gap-12" data-test="tool-grid" aria-live="polite">
          @for (group of visibleGroups(); track group.heading) {
            <section>
              <h2 class="kicker">{{ group.heading }}</h2>
              <div class="tool-grid">
                @for (tool of group.tools; track tool.slug) {
                  <a
                    class="tool-card"
                    [routerLink]="'/' + tool.slug"
                    [attr.data-test]="'tool-link-' + tool.slug"
                  >
                    <app-tool-icon [slug]="tool.slug" />
                    <span>{{ tool.name }}</span>
                  </a>
                }
              </div>
            </section>
          }
        </div>

        <!-- One of the three allowed surfaces (§9A). Renders nothing at all
             unless ads are enabled *and* this visitor consented. -->
        <div class="mt-24">
          <app-ad-slot name="landing" [height]="250" />
        </div>
      </main>

      <app-site-footer />
    </div>
  `,
})
export class Landing {
  private title = inject(Title);
  private meta = inject(Meta);
  private doc = inject(DOCUMENT);

  constructor() {
    // Prerendered, so a crawler and a link preview see the real thing rather
    // than the shell's defaults — this page is the acquisition channel an
    // ad-funded product lives on (§9A).
    const title = 'ZenPDF — every PDF tool, free and without an account';
    const description =
      'Merge, split, compress, sign, OCR and convert PDFs in your browser. '
      + 'Free, no watermark, no account needed, and files are deleted '
      + 'automatically.';
    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ name: 'twitter:card', content: 'summary' });
    // `SITE_URL`, not `document.location`: this page is prerendered, where the
    // location is Angular's synthetic `http://ng-localhost`.
    setCanonical(this.doc, this.meta, `${SITE_URL}/`);
  }

  protected auth = inject(AuthFacade);

  protected readonly query = signal('');

  /** The static groups, plus a safety net for any TOOL_PAGES slug left out. */
  private readonly groups: DirectoryGroup[] = (() => {
    const placed = new Set(DIRECTORY.flatMap((g) => g.tools.map((t) => t.slug)));
    const missing = TOOL_PAGES.filter((t) => !placed.has(t.slug));
    return missing.length
      ? [
          ...DIRECTORY,
          {
            heading: 'More',
            tools: missing.map((t) => ({ slug: t.slug, name: t.h1, keywords: t.slug })),
          },
        ]
      : DIRECTORY;
  })();

  protected readonly visibleGroups = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.groups;
    const terms = q.split(/\s+/);
    return this.groups
      .map((group) => ({
        heading: group.heading,
        tools: group.tools.filter((tool) => {
          const haystack = `${tool.name} ${tool.keywords} ${tool.slug}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        }),
      }))
      .filter((group) => group.tools.length > 0);
  });

  protected readonly nothingMatches = computed(
    () => this.query().trim().length > 0 && this.visibleGroups().length === 0,
  );

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
