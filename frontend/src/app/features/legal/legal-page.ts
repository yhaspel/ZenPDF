import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AppConfig } from '../../core/models/models';
import { ConfigService } from '../../core/services/config.service';

type LegalKind = 'privacy' | 'terms' | 'about';

/**
 * Privacy, Terms and About (§9A).
 *
 * The retention numbers are **read from `/api/config/`**, not typed into the
 * copy. A privacy policy that says "30 days" while the sweeper says 45 is
 * worse than no policy: it is a written claim that the system contradicts. A
 * backend test asserts the same numbers come from the settings the beat tasks
 * use, so the three cannot drift apart.
 */
@Component({
  selector: 'app-legal-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  templateUrl: './legal-page.html',
})
export class LegalPage {
  private route = inject(ActivatedRoute);
  private configSvc = inject(ConfigService);
  private title = inject(Title);
  private meta = inject(Meta);

  protected kind = signal<LegalKind>('privacy');
  protected config = signal<AppConfig | null>(null);

  protected readonly retention = computed(() => this.config()?.retention ?? {
    guest_hours: 24, trash_days: 30, export_hours: 24,
  });

  constructor() {
    const kind = (this.route.snapshot.data['kind'] ?? 'privacy') as LegalKind;
    this.kind.set(kind);
    const meta = {
      privacy: {
        title: 'Privacy policy | ZenPDF',
        description: 'What ZenPDF stores, for how long, and who else sees it.',
      },
      terms: {
        title: 'Terms of service | ZenPDF',
        description: 'The terms you agree to by using ZenPDF.',
      },
      about: {
        title: 'About ZenPDF — a free PDF workspace',
        description: 'What ZenPDF is, how it is paid for, and what it will not do.',
      },
    }[kind];
    this.title.setTitle(meta.title);
    this.meta.updateTag({ name: 'description', content: meta.description });

    this.configSvc.config().subscribe({
      next: (config) => this.config.set(config),
      error: () => this.config.set(null),
    });
  }
}
