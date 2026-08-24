import { DOCUMENT, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { GuidePageDef } from '../../core/guide-pages';
import { SITE_URL, setCanonical } from '../../core/site';
import { TOOL_PAGES } from '../../core/tool-pages';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';
import { ToolIcon } from '../../shared/tool-icon';

/** The author line, in one place — it is also the JSON-LD `author.name`. */
const AUTHOR = 'the ZenPDF team';

/**
 * `/guides/<slug>` — one article (design contract §4 "Guide article",
 * phase-11 §11C).
 *
 * The legal pages' 640 px reading column and their typography, so a guide and
 * the privacy policy read as pages of one product. Presentation only; every
 * word comes from `core/guide-pages.ts`.
 *
 * `Article` JSON-LD rather than the tool pages' `FAQPage` +
 * `SoftwareApplication` — a guide is a document, not a widget, and
 * `verify-prerender.mjs` asserts the type is in the served HTML of every slug.
 *
 * The related-tools block reuses the landing directory's `.tool-grid` /
 * `.tool-card` and its icons rather than introducing a component: the tools a
 * guide names are the reason the guide exists, and a link that looks like the
 * thing it links to is worth more than a fresh pattern.
 */
@Component({
  selector: 'app-guide-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, Brand, SiteFooter, ThemeToggle, ToolIcon],
  template: `
    <div class="page-shell" data-test="guide-page">
      <header class="hdr">
        <a routerLink="/" class="brand" aria-label="ZenPDF"><app-brand /></a>
        <nav>
          <app-theme-toggle />
        </nav>
      </header>

      <main class="wrap-reading w-full pb-16 pt-12">
        <h1 data-test="guide-h1">{{ guide().h1 }}</h1>

        <p class="faint mt-3 text-[12.5px]" data-test="guide-byline">
          {{ author }} ·
          <time [attr.datetime]="guide().published">
            Published {{ guide().published | date: 'd MMMM y' : undefined : 'en-GB' }}
          </time>
          @if (wasUpdated()) {
            ·
            <time [attr.datetime]="guide().updated">
              Updated {{ guide().updated | date: 'd MMMM y' : undefined : 'en-GB' }}
            </time>
          }
        </p>

        @for (section of guide().sections; track $index) {
          <section [class]="$first ? 'mt-6' : 'mt-8'" data-test="guide-section">
            @if (section.heading) {
              <h2>{{ section.heading }}</h2>
            }
            @for (paragraph of section.paragraphs; track $index) {
              <p class="mt-3 text-base leading-[1.75]">{{ paragraph }}</p>
            }
            @if (section.note; as note) {
              <p class="notice notice-info mt-4" data-test="guide-note">
                <span>{{ note.text }}</span>
                @if (note.link; as link) {
                  <a [routerLink]="link.href" data-test="guide-note-link">{{ link.label }}</a>
                }
              </p>
            }
          </section>
        }

        @if (relatedTools().length) {
          <section class="mt-12" data-test="guide-related">
            <h2>Tools this uses</h2>
            <div class="tool-grid tool-grid-2">
              @for (tool of relatedTools(); track tool.slug) {
                <a
                  class="tool-card"
                  [routerLink]="'/' + tool.slug"
                  [attr.data-test]="'guide-tool-' + tool.slug"
                >
                  <app-tool-icon [slug]="tool.slug" />
                  <span>{{ tool.h1 }}</span>
                </a>
              }
            </div>
          </section>
        }

        <p class="faint mt-12 text-[12.5px]">
          <a routerLink="/guides">All guides</a> ·
          <a routerLink="/">Home</a>
        </p>
      </main>

      <app-site-footer />
    </div>
  `,
})
export class GuidePage {
  readonly guide = input.required<GuidePageDef>();

  private title = inject(Title);
  private meta = inject(Meta);
  private doc = inject(DOCUMENT);

  protected readonly author = AUTHOR;

  /** "Updated" is shown only when it says something (§4) — otherwise the line
   *  reads "Published 24 August · Updated 24 August", which is noise. */
  protected readonly wasUpdated = computed(() => this.guide().updated !== this.guide().published);

  /**
   * `ToolKind` → the tool page it belongs to. Resolved against `TOOL_PAGES`
   * rather than a second table, so a guide cannot name a tool that does not
   * exist — `guide-pages.spec.ts` asserts every one of them resolves.
   */
  protected readonly relatedTools = computed(() =>
    this.guide()
      .relatedTools.map((kind) => TOOL_PAGES.find((t) => t.kind === kind))
      .filter((t) => t !== undefined),
  );

  constructor() {
    // On the server too, so the crawler is handed the real title and meta.
    queueMicrotask(() => this.applySeo());
  }

  private applySeo(): void {
    const guide = this.guide();
    this.title.setTitle(guide.title);
    this.meta.updateTag({ name: 'description', content: guide.metaDescription });
    this.meta.updateTag({ property: 'og:title', content: guide.title });
    this.meta.updateTag({ property: 'og:description', content: guide.metaDescription });
    this.meta.updateTag({ property: 'og:type', content: 'article' });
    // `SITE_URL`, never `document.location`: these prerender, where that is
    // Angular's synthetic `http://ng-localhost`.
    const canonical = `${SITE_URL}/guides/${guide.slug}`;
    setCanonical(this.doc, this.meta, canonical);

    const payload = {
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: guide.h1,
      description: guide.metaDescription,
      datePublished: guide.published,
      dateModified: guide.updated,
      author: { '@type': 'Organization', name: AUTHOR },
      publisher: { '@type': 'Organization', name: 'ZenPDF', url: SITE_URL },
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      url: canonical,
    };
    const id = 'zen-guide-jsonld';
    this.doc.getElementById(id)?.remove();
    const script = this.doc.createElement('script');
    script.id = id;
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(payload);
    this.doc.head.appendChild(script);
  }
}
