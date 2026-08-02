import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

import { EsignService } from '../../core/services/esign.service';

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
  template: `
    <div class="mx-auto w-full max-w-2xl p-6" data-test="disclosure-page">
      <h1 class="text-2xl font-semibold text-slate-800" data-test="disclosure-h1">
        Consent to use electronic records and signatures
      </h1>
      <p class="mt-1 text-xs text-slate-500">
        Version {{ version() }}
        @if (hash()) {
          · SHA-256 <span class="font-mono">{{ hash() }}</span>
        }
      </p>
      <p class="mt-3 text-sm text-slate-600">
        This is the exact text every signer agrees to before signing through
        ZenPDF. Its fingerprint is recorded in the audit trail alongside each
        consent, so the record still identifies this wording after it changes.
      </p>
      <pre class="mt-4 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-4 font-sans text-sm leading-6 text-slate-700"
           data-test="disclosure-text">{{ text() }}</pre>
    </div>
  `,
})
export class DisclosurePage {
  private esign = inject(EsignService);
  private title = inject(Title);
  private meta = inject(Meta);

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
    this.esign.disclosure().subscribe({
      next: (body) => {
        this.text.set(body.text);
        this.version.set(body.version);
        this.hash.set(body.disclosure_sha256);
      },
      error: () => this.text.set('This text could not be loaded just now.'),
    });
  }
}
