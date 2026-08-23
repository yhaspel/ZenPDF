import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';

import { VerifyReport } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';

/**
 * `/verify` — public, ad-free (phase-08 §8C).
 *
 * The person here has been sent a PDF by somebody and wants to know whether to
 * believe it. So the answer leads with what is actually true and says what it
 * does *not* prove: our development certificate is self-signed, and a page
 * that showed a green tick for it would be teaching people the wrong lesson.
 */
@Component({
  selector: 'app-verify',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Brand, SiteFooter, ThemeToggle],
  templateUrl: './verify.html',
})
export class Verify {
  private esign = inject(EsignService);
  private title = inject(Title);
  private meta = inject(Meta);
  private destroyRef = inject(DestroyRef);

  protected report = signal<VerifyReport | null>(null);
  protected busy = signal(false);
  protected error = signal('');
  protected filename = signal('');

  constructor() {
    this.title.setTitle('Verify a signed PDF — check a ZenPDF seal | ZenPDF');
    this.meta.updateTag({
      name: 'description',
      content: 'Check whether a signed PDF is intact and who sealed it. Free, '
        + 'no account, nothing stored.',
    });
  }

  protected onFile(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    this.check(file);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) this.check(file);
  }

  protected allowDrop(event: DragEvent): void {
    event.preventDefault();
  }

  private check(file: File): void {
    this.busy.set(true);
    this.error.set('');
    this.report.set(null);
    this.filename.set(file.name);
    this.esign.verify(file).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (report) => {
        this.report.set(report);
        this.busy.set(false);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(err?.error?.error?.message
                       || 'That file could not be checked.');
      },
    });
  }

  protected headline(report: VerifyReport): string {
    if (!report.sealed) return 'This PDF has no signature';
    if (report.integrity === 'modified') return 'This document has been changed';
    if (report.envelope_match.known && report.envelope_match.sha256_match) {
      return 'Signed through ZenPDF, and unchanged since';
    }
    return 'The signature is intact';
  }

  protected tone(report: VerifyReport): 'good' | 'bad' | 'neutral' {
    if (!report.sealed) return 'neutral';
    return report.integrity === 'intact' ? 'good' : 'bad';
  }
}
