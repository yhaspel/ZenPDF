import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { apiError } from '../../core/api-error';
import { CeremonyMeta, SignFieldModel } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { Brand } from '../../shared/brand';
import { ZenModal } from '../../shared/modal.directive';
import { SignaturePad } from '../../shared/signature-pad';
import { ThemeToggle } from '../../shared/theme-toggle';

type Screen = 'loading' | 'consent' | 'sign' | 'wait' | 'done' | 'closed' | 'error';

/**
 * The signing ceremony (`/s/:token`, phase-08 §8B).
 *
 * The person here has no account, did not choose to be here, and is quite
 * possibly on a phone. So: one column, one thing to do at a time, the consent
 * screen first because it must be unskippable, and a rail that says which
 * field is next rather than leaving them to hunt.
 */
@Component({
  selector: 'app-ceremony',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, SignaturePad, ZenModal, Brand, ThemeToggle],
  templateUrl: './ceremony.html',
})
export class Ceremony {
  private route = inject(ActivatedRoute);
  private esign = inject(EsignService);
  private destroyRef = inject(DestroyRef);

  protected token = signal('');
  protected screen = signal<Screen>('loading');
  protected meta = signal<CeremonyMeta | null>(null);
  protected error = signal('');
  protected disclosure = signal('');
  protected agreed = signal(false);
  protected busy = signal(false);
  protected padFor = signal<SignFieldModel | null>(null);
  protected declining = signal(false);
  protected declineReason = signal('');
  protected finalizing = signal(false);
  protected reporting = signal(false);
  protected reportReason = signal('');
  protected values = signal<Record<string, string>>({});
  protected filled = signal<Record<string, boolean>>({});

  protected readonly fields = computed(() => this.meta()?.fields ?? []);
  protected readonly required = computed(
    () => this.fields().filter((f) => f.required && f.type !== 'date_signed'),
  );
  protected readonly doneCount = computed(() => {
    const filled = this.filled();
    return this.required().filter((f) => filled[f.id] || f.filled).length;
  });
  protected readonly nextField = computed(() => {
    const filled = this.filled();
    return this.required().find((f) => !(filled[f.id] || f.filled)) ?? null;
  });
  protected readonly canFinish = computed(() => this.nextField() === null);

  protected readonly contentUrl = computed(
    () => this.esign.ceremonyContentUrl(this.token()),
  );

  /** Which page is on screen, and the fields that belong on it. */
  protected page = signal(0);
  protected readonly pageUrl = computed(
    () => this.esign.ceremonyPageUrl(this.token(), this.page()),
  );
  protected readonly fieldsOnPage = computed(
    () => this.fields().filter((f) => f.page === this.page()),
  );

  /** A field's box as a CSS percentage rectangle — §8 normalized geometry maps
   *  straight onto the rendered page image, with no conversion at all. */
  protected boxStyle(field: SignFieldModel): Record<string, string> {
    return {
      left: `${field.x * 100}%`,
      top: `${field.y * 100}%`,
      width: `${field.w * 100}%`,
      height: `${field.h * 100}%`,
    };
  }

  protected goToField(field: SignFieldModel): void {
    this.page.set(field.page);
  }

  /** Tapping the box on the page is the same as tapping its card. */
  protected onBoxClick(field: SignFieldModel): void {
    if (field.type === 'date_signed') return;
    if (field.type === 'signature' || field.type === 'initials') {
      this.openPad(field);
      return;
    }
    if (field.type === 'checkbox') {
      this.saveValue(field, this.values()[field.id] !== 'true');
      return;
    }
    document.querySelector<HTMLInputElement>(
      `[data-test="field-${field.id}"]`)?.focus();
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    const last = (this.meta()?.page_count ?? 1) - 1;
    this.page.update((p) => Math.min(last, p + 1));
  }

  constructor() {
    this.token.set(this.route.snapshot.paramMap.get('token') ?? '');
    this.load();
    this.esign.disclosure().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (body) => this.disclosure.set(body.text),
      error: () => this.disclosure.set(''),
    });
  }

  private load(): void {
    this.esign.ceremony(this.token()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (meta) => {
        this.meta.set(meta);
        this.filled.set(Object.fromEntries(
          meta.fields.map((f) => [f.id, !!f.filled]),
        ));
        this.values.set(Object.fromEntries(
          meta.fields.map((f) => [f.id, f.value ?? '']),
        ));
        this.saved = Object.fromEntries(meta.fields.map((f) => [f.id, f.value ?? '']));
        this.screen.set(this.screenFor(meta));
      },
      error: (err: unknown) => {
        const { message, status } = apiError(err);
        this.error.set(message || 'This link is not valid.');
        // 410 is `token_expired` (§6) — expired, completed or cancelled. That
        // is a closed request, not a broken one, and gets its own screen.
        this.screen.set(status === 410 ? 'closed' : 'error');
      },
    });
  }

  private screenFor(meta: CeremonyMeta): Screen {
    if (meta.me.status === 'completed') return 'done';
    if (!meta.me.my_turn) return 'wait';
    if (meta.me.needs_consent && !meta.me.consented) return 'consent';
    return 'sign';
  }

  // ------------------------------------------------------------------ //
  protected consent(): void {
    if (!this.agreed()) return;
    this.busy.set(true);
    this.esign.consent(this.token()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busy.set(false);
        this.screen.set('sign');
        // After ZenModal's own focus restore, so this wins: the person has
        // just agreed and should land on what they are signing.
        setTimeout(() => document
          .querySelector<HTMLElement>('[data-test="sign-heading"]')?.focus());
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(apiError(err).message || 'That did not work.');
      },
    });
  }

  protected openPad(field: SignFieldModel): void {
    this.padFor.set(field);
  }

  protected onSignature(dataUrl: string): void {
    const field = this.padFor();
    if (!field) return;
    this.busy.set(true);
    this.esign.fillField(this.token(),
                         { field_id: field.id, signature_image: dataUrl })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.filled.update((map) => ({ ...map, [field.id]: true }));
          this.padFor.set(null);
          this.busy.set(false);
          this.restoreFocusAfterField(field.id);
        },
        error: (err) => {
          this.busy.set(false);
          this.error.set(apiError(err).message || 'That did not work.');
        },
      });
  }

  /** Type freely; nothing leaves the browser until the field is left. */
  protected stage(field: SignFieldModel, value: string): void {
    this.values.update((map) => ({ ...map, [field.id]: value }));
  }

  /** What the server last accepted, so a *cleared* field is still a change. */
  private saved: Record<string, string> = {};

  protected commit(field: SignFieldModel): void {
    const value = this.values()[field.id] ?? '';
    // Compared against what was last *saved*, not against the value the field
    // had at load: clearing a filled box left both at '' and the deletion was
    // never sent, so the ceremony showed empty and the signed PDF did not.
    if (this.saved[field.id] === value) return;
    this.saveValue(field, value);
  }

  protected saveValue(field: SignFieldModel, value: string | boolean): void {
    this.values.update((map) => ({ ...map, [field.id]: String(value) }));
    this.esign.fillField(this.token(), { field_id: field.id, value })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          this.saved[field.id] = String(value);
          this.filled.update((map) => ({ ...map, [field.id]: res.filled }));
        },
        error: () => this.error.set('That did not save — check your connection.'),
      });
  }

  protected finish(): void {
    this.busy.set(true);
    this.esign.complete(this.token()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        this.busy.set(false);
        this.screen.set('done');
        // Sealing happens on a worker, so the last signer's first refetch still
        // says `sent` — and they were told "we are waiting for the others",
        // which is exactly who they had just stopped being. Poll briefly for
        // the completion instead.
        this.finalizing.set(res.next === 'completed');
        this.load();
        if (res.next === 'completed') this.awaitCompletion();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(apiError(err).message || 'That did not work.');
      },
    });
  }

  protected decline(): void {
    this.busy.set(true);
    this.esign.decline(this.token(), this.declineReason())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: () => {
        this.busy.set(false);
        this.declining.set(false);
        this.screen.set('closed');
        this.error.set('You declined to sign. The sender has been told.');
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(apiError(err).message || 'That did not work.');
      },
    });
  }

  private awaitCompletion(attempt = 0): void {
    if (attempt > 12) {
      this.finalizing.set(false);
      return;
    }
    setTimeout(() => {
      this.esign.ceremony(this.token()).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (meta) => {
          this.meta.set(meta);
          if (meta.status === 'completed') {
            this.finalizing.set(false);
          } else {
            this.awaitCompletion(attempt + 1);
          }
        },
        error: () => this.finalizing.set(false),
      });
    }, 1500);
  }

  /** "I did not ask for this" (§9B). Three distinct reporters pause it. */
  protected report(): void {
    this.busy.set(true);
    this.reportError.set('');
    this.esign.report(this.token(), this.reportReason())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
      next: (res) => {
        this.busy.set(false);
        this.reporting.set(false);
        // A thank-you is not an error. It used to be written into `error()`,
        // which renders in the red banner — telling somebody who just did the
        // right thing that something went wrong.
        this.notice.set(
          res.paused
            ? 'Thank you — this request has been paused and the sender told.'
            : 'Thank you. We have recorded your report.',
        );
      },
      error: () => {
        this.busy.set(false);
        // Inside the dialog: the modal covers the page banner, so a failure
        // written there is invisible and the person just clicks again.
        this.reportError.set('That did not send. Try again in a moment.');
      },
    });
  }

  /** A confirmation, shown in its own (green) banner — never in `error`. */
  protected notice = signal('');
  /** A failure *inside* the report dialog, where the person can see it. */
  protected reportError = signal('');

  /** After a signature is applied the field's button is replaced by a "done"
   *  line, so focus falls to `<body>`. Put it on the control that replaced it,
   *  so the next Tab continues from where the person was. */
  private restoreFocusAfterField(fieldId: string): void {
    setTimeout(() => {
      const next = document.querySelector<HTMLElement>(
        `[data-test="change-${fieldId}"]`);
      (next ?? document.querySelector<HTMLElement>('[data-test=sign-heading]'))
        ?.focus();
    });
  }

  protected downloadUrl(what: 'final' | 'certificate'): string {
    return this.esign.recipientDownloadUrl(this.token(), what);
  }

  protected label(field: SignFieldModel): string {
    if (field.label) return field.label;
    return {
      signature: 'Signature', initials: 'Initials', date_signed: 'Date',
      text: 'Text', checkbox: 'Tick',
    }[field.type];
  }

  protected isFilled(field: SignFieldModel): boolean {
    return !!this.filled()[field.id];
  }
}
