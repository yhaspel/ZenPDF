import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import {
  RecipientRole,
  SignFieldType,
  SignRequestModel,
} from '../../core/models/models';
import { EsignService } from '../../core/services/esign.service';
import {
  VerificationService,
  isEmailNotVerified,
} from '../../core/services/verification.service';
import { HistoryStack } from '../../shared/history';
import {
  OverlayDraft,
  OverlayGeometryChange,
  OverlayItem,
  OverlayMenuAction,
} from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { resolveShortcut, shortcutTitle } from '../../shared/shortcuts';
import { ToastService } from '../../shared/toast.service';

interface DraftRecipient {
  id?: string;
  email: string;
  name: string;
  role: RecipientRole;
  order: number;
}

interface DraftField {
  id?: string;
  recipient_id: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: SignFieldType;
  required: boolean;
  label: string;
}

/** One colour per recipient, so a page of boxes is readable at a glance. */
const COLORS = ['#B23A26', '#2F6B46', '#8A6212', '#8E2A38', '#3D6478', '#5F574A'];

/**
 * The request builder (`/app/sign/new/:docId`, phase-08 §8B).
 *
 * Four steps in one page rather than a wizard with four URLs: recipients,
 * fields, message, send. The layout survives a reload because every step
 * PATCHes the draft — a builder that loses twenty minutes of field placement
 * to a stray refresh is one people stop trusting.
 */
@Component({
  selector: 'app-request-builder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, PageOverlay],
  templateUrl: './request-builder.html',
})
export class RequestBuilder {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private esign = inject(EsignService);
  private toast = inject(ToastService);

  protected readonly roles: RecipientRole[] = ['signer', 'approver', 'viewer', 'cc'];
  protected readonly fieldTypes: SignFieldType[] =
    ['signature', 'initials', 'date_signed', 'text', 'checkbox'];

  protected docId = signal('');
  protected request = signal<SignRequestModel | null>(null);
  protected step = signal(1);
  protected page = signal(0);
  protected zoom = signal(680);
  protected busy = signal(false);

  protected recipients = signal<DraftRecipient[]>([
    { email: '', name: '', role: 'signer', order: 1 },
  ]);
  protected fields = signal<DraftField[]>([]);
  /**
   * Which placed field is selected.
   *
   * Before phase-12 a click *deleted* a field — `onSelect` filtered it out of
   * the list — which is the same trap the redaction layer had, in a builder
   * where twenty minutes of placement is normal. A click now selects; removing
   * is Delete, the right-click menu, or the ✕ on its row.
   */
  protected selectedFieldId = signal<string | null>(null);
  private history = new HistoryStack<DraftField[]>();
  protected readonly canUndo = this.history.canUndo;
  protected readonly canRedo = this.history.canRedo;
  protected readonly key = shortcutTitle;
  protected armedFor = signal<string | null>(null);
  protected armedType = signal<SignFieldType>('signature');
  /** phase-08's "required toggle" — an optional field is a real thing:
   *  a middle name, a second phone number, an initial box some people
   *  use and others do not. */
  protected armedRequired = signal(true);
  protected message = signal('');
  protected expiresInDays = signal(30);
  protected reminderDays = signal(3);

  protected readonly pageCount = computed(() => this.request()?.page_count ?? 1);
  protected readonly signers = computed(
    () => this.recipients().filter((r) => r.role === 'signer'),
  );
  protected readonly overlayItems = computed<OverlayItem[]>(() =>
    this.fields()
      .filter((f) => f.page === this.page())
      .map((f, index) => ({
        id: `${index}`,
        page: f.page,
        shape: 'rect' as const,
        rect: { x: f.x, y: f.y, w: f.w, h: f.h },
        stroke: this.colorFor(f.recipient_id),
        fill: this.colorFor(f.recipient_id),
        opacity: 0.15,
        width: 1,
        label: `${this.shortName(f.recipient_id)} · ${f.type}`,
      })),
  );

  constructor() {
    const docId = this.route.snapshot.paramMap.get('docId') ?? '';
    this.docId.set(docId);
    this.esign.createRequest({ document: docId }).subscribe({
      next: (row) => {
        this.request.set(row);
        this.message.set(row.message);
      },
      error: (err) => {
        this.toast.error(err?.error?.error?.message
                         || 'That document cannot be sent for signature.');
        this.router.navigate(['/app/doc', docId]);
      },
    });
    effect((onCleanup) => {
      if (typeof window === 'undefined') return;
      const handler = (event: KeyboardEvent) => this.onShortcut(event);
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
    });
  }

  /**
   * Undo and redo placed fields from the keyboard.
   *
   * Gated to step 2 because that is the only step whose bar carries the two
   * buttons — undoing a placement from the message step would be an invisible
   * change to a screen the user is not looking at.
   */
  private onShortcut(event: KeyboardEvent): void {
    if (this.step() !== 2) return;
    const action = resolveShortcut(event);
    if (action === 'undo') this.undoFields();
    else if (action === 'redo') this.redoFields();
    else return;
    event.preventDefault();
  }

  protected colorFor(recipientId: string): string {
    const index = this.recipients().findIndex((r) => r.id === recipientId);
    return COLORS[Math.max(0, index) % COLORS.length];
  }

  protected shortName(recipientId: string): string {
    const row = this.recipients().find((r) => r.id === recipientId);
    if (!row) return '?';
    return row.name || row.email.split('@')[0];
  }

  // ---- step 1: recipients -------------------------------------------- //
  protected addRecipient(): void {
    this.recipients.update((rows) => [
      ...rows,
      { email: '', name: '', role: 'signer', order: rows.length + 1 },
    ]);
  }

  protected removeRecipient(index: number): void {
    this.recipients.update((rows) => rows.filter((_, i) => i !== index));
    this.fields.set([]);
  }

  protected update(index: number, patch: Partial<DraftRecipient>): void {
    this.recipients.update((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  protected saveRecipients(): void {
    const request = this.request();
    if (!request) return;
    const rows = this.recipients().filter((r) => r.email.trim());
    if (!rows.some((r) => r.role === 'signer')) {
      this.toast.info('At least one person has to sign.');
      return;
    }
    this.busy.set(true);
    this.esign.patchRequest(request.id, { recipients: rows }).subscribe({
      next: (updated) => {
        this.request.set(updated);
        // The ids come back from the server; the field step binds to them.
        this.recipients.set(updated.recipients.map((r) => ({
          id: r.id, email: r.email, name: r.name, role: r.role, order: r.order,
        })));
        this.armedFor.set(updated.recipients.find(
          (r) => r.role === 'signer')?.id ?? null);
        this.fields.set([]);
        this.history.clear();
        this.selectedFieldId.set(null);
        this.busy.set(false);
        this.step.set(2);
      },
      error: (err) => {
        this.busy.set(false);
        this.toast.error(err?.error?.error?.message || 'Could not save that.');
      },
    });
  }

  // ---- step 2: fields ------------------------------------------------- //
  protected onDrawn(draft: OverlayDraft): void {
    const recipientId = this.armedFor();
    if (!draft.rect || !recipientId) {
      this.toast.info('Pick whose field this is first.');
      return;
    }
    this.history.remember([...this.fields()]);
    this.fields.update((rows) => [...rows, {
      recipient_id: recipientId,
      page: draft.page,
      x: draft.rect!.x, y: draft.rect!.y, w: draft.rect!.w, h: draft.rect!.h,
      type: this.armedType(),
      required: this.armedRequired(),
      label: '',
    }]);
  }

  private overlay = viewChild(PageOverlay);

  protected onSelect(id: string | null): void {
    this.selectedFieldId.set(id);
    if (id !== null) this.overlay()?.focusSurface();
  }

  /** The overlay addresses a field by its index *within the current page*. */
  private fieldAt(id: string | null): DraftField | undefined {
    if (id === null) return undefined;
    return this.fields().filter((f) => f.page === this.page())[Number(id)];
  }

  protected removeField(id: string | null): void {
    const target = this.fieldAt(id);
    if (!target) return;
    this.history.remember([...this.fields()]);
    this.fields.update((rows) => rows.filter((f) => f !== target));
    this.selectedFieldId.set(null);
  }

  protected onGeometryChanged(change: OverlayGeometryChange): void {
    const target = this.fieldAt(change.id);
    if (!target) return;
    this.history.remember([...this.fields()]);
    const { x, y, w, h } = change.rect;
    this.fields.update((rows) =>
      rows.map((f) => (f === target ? { ...f, x, y, w, h } : f)));
  }

  protected undoFields(): void {
    const previous = this.history.undo([...this.fields()]);
    if (previous) {
      this.fields.set(previous);
      this.selectedFieldId.set(null);
    }
  }

  protected redoFields(): void {
    const next = this.history.redo([...this.fields()]);
    if (next) {
      this.fields.set(next);
      this.selectedFieldId.set(null);
    }
  }

  protected onContextTarget(id: string | null): void {
    if (id !== null) this.selectedFieldId.set(id);
  }

  protected onMenuAction(choice: { action: string; itemId: string | null }): void {
    if (choice.action === 'remove') this.removeField(choice.itemId);
  }

  protected menuActionsFor = (id: string | null): OverlayMenuAction[] => {
    const onPage = this.fields().filter((f) => f.page === this.page());
    if (id === null || !onPage[Number(id)]) return [];
    return [{
      id: 'remove', label: 'Remove field', danger: true, shortcut: this.key('delete'),
    }];
  };

  /** The rows of the per-page list — the touch and keyboard route to removal. */
  protected readonly fieldsOnPage = computed(() =>
    this.fields()
      .filter((f) => f.page === this.page())
      .map((field, index) => ({ id: `${index}`, field })),
  );

  protected fieldLabel(field: DraftField): string {
    const who = this.recipients().find((r) => r.id === field.recipient_id);
    return `${field.type.replace('_', ' ')} — ${who?.email || 'unassigned'}`;
  }

  protected saveFields(): void {
    const request = this.request();
    if (!request) return;
    const missing = this.signers().filter(
      (r) => !this.fields().some((f) => f.recipient_id === r.id));
    if (missing.length) {
      this.toast.info(
        `${missing[0].email} has nothing to sign — place a field for them.`);
      return;
    }
    this.busy.set(true);
    this.esign.patchRequest(request.id, { fields: this.fields() }).subscribe({
      next: (updated) => {
        this.request.set(updated);
        this.busy.set(false);
        this.step.set(3);
      },
      error: (err) => {
        this.busy.set(false);
        this.toast.error(err?.error?.error?.message || 'Could not save those.');
      },
    });
  }

  // ---- step 3/4: message and send ------------------------------------- //
  protected saveMessage(): void {
    const request = this.request();
    if (!request) return;
    this.busy.set(true);
    this.esign.patchRequest(request.id, {
      message: this.message(),
      expires_in_days: this.expiresInDays(),
      reminder_every_days: this.reminderDays(),
    }).subscribe({
      next: (updated) => {
        this.request.set(updated);
        this.busy.set(false);
        this.step.set(4);
      },
      error: () => {
        this.busy.set(false);
        this.toast.error('Could not save that.');
      },
    });
  }

  protected send(): void {
    const request = this.request();
    if (!request) return;
    this.busy.set(true);
    this.esign.sendRequest(request.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.toast.success('Sent — the first signer has been emailed.');
        this.router.navigate(['/app/sign', request.id]);
      },
      error: (err) => {
        this.busy.set(false);
        if (isEmailNotVerified(err)) {
          // Not a toast: the way out of this refusal is a button, and a toast
          // that fades takes it with it.
          this.needsVerification.set(true);
          return;
        }
        this.toast.error(err?.error?.error?.message || 'Could not send that.');
      },
    });
  }

  /** The verification gate, answered where it is hit (§9B). */
  protected needsVerification = signal(false);
  protected verification = inject(VerificationService);

  protected fieldsFor(recipientId: string): number {
    return this.fields().filter((f) => f.recipient_id === recipientId).length;
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount() - 1, p + 1));
  }
}
