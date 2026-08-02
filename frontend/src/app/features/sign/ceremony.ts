import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';

import { CeremonyMeta, SignFieldModel } from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import { SignaturePad } from '../../shared/signature-pad';

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
  imports: [FormsModule, SignaturePad],
  templateUrl: './ceremony.html',
})
export class Ceremony {
  private route = inject(ActivatedRoute);
  private esign = inject(EsignService);

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

  constructor() {
    this.token.set(this.route.snapshot.paramMap.get('token') ?? '');
    this.load();
    this.esign.disclosure().subscribe({
      next: (body) => this.disclosure.set(body.text),
      error: () => this.disclosure.set(''),
    });
  }

  private load(): void {
    this.esign.ceremony(this.token()).subscribe({
      next: (meta) => {
        this.meta.set(meta);
        this.filled.set(Object.fromEntries(
          meta.fields.map((f) => [f.id, !!f.filled]),
        ));
        this.values.set(Object.fromEntries(
          meta.fields.map((f) => [f.id, f.value ?? '']),
        ));
        this.screen.set(this.screenFor(meta));
      },
      error: (err) => {
        this.error.set(err?.error?.error?.message || 'This link is not valid.');
        this.screen.set(err?.status === 410 ? 'closed' : 'error');
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
    this.esign.consent(this.token()).subscribe({
      next: () => {
        this.busy.set(false);
        this.screen.set('sign');
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(err?.error?.error?.message || 'That did not work.');
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
      .subscribe({
        next: () => {
          this.filled.update((map) => ({ ...map, [field.id]: true }));
          this.padFor.set(null);
          this.busy.set(false);
        },
        error: (err) => {
          this.busy.set(false);
          this.error.set(err?.error?.error?.message || 'That did not work.');
        },
      });
  }

  /** Type freely; nothing leaves the browser until the field is left. */
  protected stage(field: SignFieldModel, value: string): void {
    this.values.update((map) => ({ ...map, [field.id]: value }));
  }

  protected commit(field: SignFieldModel): void {
    const value = this.values()[field.id] ?? '';
    if (value === (field.value ?? '') && this.filled()[field.id]) return;
    this.saveValue(field, value);
  }

  protected saveValue(field: SignFieldModel, value: string | boolean): void {
    this.values.update((map) => ({ ...map, [field.id]: String(value) }));
    this.esign.fillField(this.token(), { field_id: field.id, value })
      .subscribe({
        next: (res) => this.filled.update((map) => ({ ...map, [field.id]: res.filled })),
        error: () => this.error.set('That did not save — check your connection.'),
      });
  }

  protected finish(): void {
    this.busy.set(true);
    this.esign.complete(this.token()).subscribe({
      next: () => {
        this.busy.set(false);
        this.screen.set('done');
        this.load();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(err?.error?.error?.message || 'That did not work.');
      },
    });
  }

  protected decline(): void {
    this.busy.set(true);
    this.esign.decline(this.token(), this.declineReason()).subscribe({
      next: () => {
        this.busy.set(false);
        this.declining.set(false);
        this.screen.set('closed');
        this.error.set('You declined to sign. The sender has been told.');
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(err?.error?.error?.message || 'That did not work.');
      },
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
