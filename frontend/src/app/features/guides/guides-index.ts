import { DOCUMENT, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { GUIDE_PAGES } from '../../core/guide-pages';
import { SITE_URL, setCanonical } from '../../core/site';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';

/**
 * `/guides` — the index (design contract §4 "Guides index", phase-11 §11C).
 *
 * On the **reading column**, not the marketing width: this is a page to be
 * read, and the landing directory is already the thing to be scanned. Twelve
 * entries need no filter, no tags and no pagination, and a tag system is the
 * first step toward the CMS this phase forbids.
 *
 * Presentation only — the table in `core/guide-pages.ts` is the source, the
 * same way `tool-pages.ts` is for the tool pages.
 */
@Component({
  selector: 'app-guides-index',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, DatePipe, Brand, SiteFooter, ThemeToggle],
  template: `
    <div class="page-shell" data-test="guides-index">
      <header class="hdr">
        <a routerLink="/" class="brand" aria-label="ZenPDF"><app-brand /></a>
        <nav>
          <app-theme-toggle />
        </nav>
      </header>

      <main class="wrap-reading w-full pb-16 pt-12">
        <h1 data-test="guides-h1">Guides</h1>
        <p class="muted mt-3 text-base leading-[1.75]">
          How the things this site does actually work — what each operation
          trades away, where it fails, and which one to reach for. Written
          against the running product, not around it.
        </p>

        <ul class="mt-8 flex list-none flex-col p-0">
          @for (guide of guides; track guide.slug) {
            <li class="border-border border-b last:border-b-0">
              <a
                class="guide-row"
                [routerLink]="'/guides/' + guide.slug"
                [attr.data-test]="'guide-link-' + guide.slug"
              >
                <span class="guide-row-title">{{ guide.h1 }}</span>
                <span class="guide-row-desc">{{ guide.metaDescription }}</span>
                <time class="guide-row-date" [attr.datetime]="guide.updated">
                  {{ guide.updated | date: 'd MMMM y' : undefined : 'en-GB' }}
                </time>
              </a>
            </li>
          }
        </ul>
      </main>

      <app-site-footer />
    </div>
  `,
})
export class GuidesIndex {
  private title = inject(Title);
  private meta = inject(Meta);
  private doc = inject(DOCUMENT);

  protected readonly guides = GUIDE_PAGES;

  constructor() {
    const title = 'Guides — how PDF tools actually work | ZenPDF';
    const description =
      'Plain guides to merging, compressing, OCR, redaction, encryption, signing and flattening PDFs — written against the running product.';
    this.title.setTitle(title);
    this.meta.updateTag({ name: 'description', content: description });
    this.meta.updateTag({ property: 'og:title', content: title });
    this.meta.updateTag({ property: 'og:description', content: description });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    setCanonical(this.doc, this.meta, `${SITE_URL}/guides`);
  }
}
