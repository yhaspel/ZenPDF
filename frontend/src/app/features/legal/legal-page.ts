import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AppConfig } from '../../core/models/models';
import { RETENTION } from '../../core/retention';
import { ConfigService } from '../../core/services/config.service';
import { SITE_URL, setCanonical } from '../../core/site';
import { Brand } from '../../shared/brand';
import { SiteFooter } from '../../shared/site-footer';
import { ThemeToggle } from '../../shared/theme-toggle';

type LegalKind = 'privacy' | 'terms' | 'about';

/**
 * Privacy, Terms and About (§9A).
 *
 * The retention numbers are **read from `/api/config/`**, not typed into the
 * copy. A privacy policy that says "30 days" while the sweeper says 45 is
 * worse than no policy: it is a written claim that the system contradicts.
 *
 * These pages prerender, where no API call is possible, so the pre-hydration
 * copy comes from `core/retention.ts` — and a backend test asserts *that* file
 * and the settings the beat tasks use agree. Live config still wins once it
 * loads.
 */
@Component({
  selector: 'app-legal-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Brand, SiteFooter, ThemeToggle],
  templateUrl: './legal-page.html',
})
export class LegalPage {
  private route = inject(ActivatedRoute);
  private configSvc = inject(ConfigService);
  private title = inject(Title);
  private meta = inject(Meta);
  private doc = inject(DOCUMENT);
  private destroyRef = inject(DestroyRef);

  protected kind = signal<LegalKind>('privacy');
  protected config = signal<AppConfig | null>(null);

  /** Live config when it has arrived; otherwise the build-time constant that
   *  the prerendered HTML was rendered from — which a backend test pins to the
   *  settings the sweepers use, so it is a checked claim and not a guess. */
  protected readonly retention = computed(
    () => this.config()?.retention ?? RETENTION,
  );

  constructor() {
    const kind = (this.route.snapshot.data['kind'] ?? 'privacy') as LegalKind;
    this.kind.set(kind);
    const meta = {
      privacy: {
        title: 'Privacy policy | ZenPDF',
        description: 'What ZenPDF stores, for how long, and who else sees it.',
        path: 'legal/privacy',
      },
      terms: {
        title: 'Terms of service | ZenPDF',
        description: 'The terms you agree to by using ZenPDF.',
        path: 'legal/terms',
      },
      about: {
        title: 'About ZenPDF — a free PDF workspace',
        description: 'What ZenPDF is, how it is paid for, and what it will not do.',
        path: 'about',
      },
    }[kind];
    this.title.setTitle(meta.title);
    this.meta.updateTag({ name: 'description', content: meta.description });
    // These three prerender and are in the sitemap, but shipped with no
    // canonical at all — so the trailing-slash form and the bare form were two
    // indexable URLs for one page.
    setCanonical(this.doc, this.meta, `${SITE_URL}/${meta.path}`);

    this.configSvc.config().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (config) => this.config.set(config),
      error: () => this.config.set(null),
    });
  }
}
