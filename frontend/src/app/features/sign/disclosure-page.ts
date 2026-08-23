import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { EsignService } from '../../core/services/esign.service';
import { SITE_URL, setCanonical } from '../../core/site';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';

/**
 * `/legal/esign-disclosure` — the consent text as a page of its own (§7).
 *
 * The ceremony shows this text inline, which is where it has to be read. This
 * page exists so it also has a **stable address**: a signer who wants to read
 * what they agreed to a year later should not need a live signing link, and
 * the version and hash printed here are the same ones recorded in the audit
 * trail at the moment of consent.
 */
@Component({
  selector: 'app-disclosure-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Brand, SiteFooter, ThemeToggle],
  template: `
    <div class="page-shell" data-test="disclosure-page">
      <header class="hdr">
        <a routerLink="/" class="brand" aria-label="ZenPDF"><app-brand /></a>
        <nav>
          <app-theme-toggle />
        </nav>
      </header>

      <main class="wrap-reading w-full pb-16 pt-12">
        <h1 data-test="disclosure-h1">
          Consent to use electronic records and signatures
        </h1>
        <p class="faint mt-2 text-[12.5px]">
          Version {{ version() }}
          @if (hash()) {
            · SHA-256 <span class="font-mono">{{ hash() }}</span>
          }
        </p>
        <p class="muted mt-4 text-base leading-[1.75]">
          This is the exact text every signer agrees to before signing through
          ZenPDF. Its fingerprint is recorded in the audit trail alongside each
          consent, so the record still identifies this wording after it changes.
        </p>
        <pre class="border-border bg-surface-raised rounded-2 text-ink-muted mt-6 whitespace-pre-wrap border p-5 font-ui text-base leading-[1.75]"
             data-test="disclosure-text">{{ text() }}</pre>
      </main>

      <app-site-footer />
    </div>
  `,
})
export class DisclosurePage {
  private esign = inject(EsignService);
  private title = inject(Title);
  private meta = inject(Meta);
  private doc = inject(DOCUMENT);
  private destroyRef = inject(DestroyRef);

  protected text = signal('');
  protected version = signal('');
  protected hash = signal('');

  constructor() {
    this.title.setTitle('Electronic signature disclosure | ZenPDF');
    this.meta.updateTag({
      name: 'description',
      content: 'The consent to use electronic records and signatures that every '
        + 'ZenPDF signer agrees to, with its version and fingerprint.',
    });
    // Prerendered and listed in the sitemap, so it needs a canonical of its own.
    setCanonical(this.doc, this.meta, `${SITE_URL}/legal/esign-disclosure`);
    this.esign.disclosure().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (body) => {
        this.text.set(body.text);
        this.version.set(body.version);
        this.hash.set(body.disclosure_sha256);
      },
      error: () => this.text.set('This text could not be loaded just now.'),
    });
  }
}
