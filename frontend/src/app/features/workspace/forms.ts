import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FormDataType, NgxExtendedPdfViewerModule } from 'ngx-extended-pdf-viewer';

import { FormsFacade } from '../../abstraction/forms.facade';
import {
  FormField,
  FormFieldSpec,
  FormFieldType,
  Job,
  Rect,
} from '../../core/models/models';
import { ConfirmService } from '../../shared/confirm.service';
import { OverlayDraft, OverlayItem } from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { saveBlob } from '../../shared/save-blob';
import { ToastService } from '../../shared/toast.service';

export type FormsTab = 'fill' | 'build';

const TYPES: FormFieldType[] = [
  'text', 'checkbox', 'radio', 'combobox', 'listbox', 'signature',
];

const NEEDS_OPTIONS: FormFieldType[] = ['radio', 'combobox', 'listbox'];

/** Vertical gap between the auto-laid-out placements of a radio group. */
const RADIO_GAP = 0.012;

/**
 * Forms mode (phase-05) — fill an AcroForm, or build one.
 *
 * **Fill** hands the page to the viewer: PDF.js renders the real widgets and
 * `[(formData)]` reports what the user types, keyed by field name. Filling in
 * the actual widget is the only version of this that behaves like every other
 * PDF reader — tab order, appearance, choice lists and all.
 *
 * **Build** uses our own overlay instead, because placing a field is a drawing
 * gesture on a page raster we control, not an interaction with a rendered
 * widget that does not exist yet.
 *
 * Both stage locally and commit once: one `fill_form` / one
 * `edit_form_fields_batch` per session, one version.
 */
@Component({
  selector: 'app-forms',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, NgxExtendedPdfViewerModule, PageOverlay],
  templateUrl: './forms.html',
})
export class Forms {
  readonly docId = input.required<string>();
  readonly pageCount = input(1);
  readonly currentSeq = input<number | null>(null);
  /** The viewer's source — assembled by the workspace, credentials and all. */
  readonly src = input('');
  readonly httpHeaders = input<Record<string, string>>({});

  readonly saved = output<Job>();
  readonly conflict = output<void>();

  protected forms = inject(FormsFacade);
  private toast = inject(ToastService);
  private confirm = inject(ConfirmService);

  protected readonly types = TYPES;
  protected tab = signal<FormsTab>('fill');
  protected page = signal(0);
  protected zoom = signal(750);
  protected busy = signal(false);
  /** What the viewer's form layer currently holds, for `[(formData)]`. */
  protected viewerData = signal<FormDataType>({});

  // builder
  protected armed = signal<FormFieldType | null>(null);
  protected selectedName = signal<string | null>(null);
  protected draftName = signal('');
  protected draftOptions = signal('');
  protected draftRequired = signal(false);
  protected draftReadonly = signal(false);
  protected draftMultiline = signal(false);
  protected draftAlign = signal<'left' | 'center' | 'right'>('left');
  protected draftFontSize = signal(11);
  /** Set while the property panel is describing a field that is not saved yet. */
  private draftIsNew = false;
  private draftOriginal: FormFieldSpec | null = null;

  protected readonly needsOptions = computed(() => {
    const type = this.selectedType();
    return type ? NEEDS_OPTIONS.includes(type) : false;
  });

  /** Overlay ids carry the placement index; the selection is the field. */
  protected readonly selectedItemId = computed(() =>
    this.selectedName() ? `${this.selectedName()}#0` : null,
  );

  protected readonly selectedType = computed<FormFieldType | null>(() => {
    const name = this.selectedName();
    if (!name) return null;
    const staged = this.forms.pendingOps().find((op) => op.field.name === name);
    if (staged?.field.type) return staged.field.type;
    return this.forms.fields().find((f) => f.name === name)?.type ?? null;
  });

  /** Every field placement on this page — saved ones plus what is staged. */
  protected readonly overlayItems = computed<OverlayItem[]>(() => {
    const page = this.page();
    const ops = this.forms.pendingOps();
    const deleted = new Set(
      ops.filter((op) => op.action === 'delete').map((op) => op.field.name),
    );
    const replaced = new Set(
      ops.filter((op) => op.action === 'update').map((op) => op.field.name),
    );
    const items: OverlayItem[] = [];

    for (const field of this.forms.fields()) {
      if (deleted.has(field.name) || replaced.has(field.name)) continue;
      field.widgets
        .filter((w) => w.page === page)
        .forEach((widget, index) => {
          items.push(this.item(field.name, field.type, widget.rect, index, false));
        });
    }
    for (const op of ops) {
      if (op.action === 'delete') continue;
      const spec = op.field;
      if ((spec.page ?? 0) !== page) continue;
      const rects = spec.rects ?? (spec.rect ? [spec.rect] : []);
      rects.forEach((rect, index) => {
        items.push(this.item(spec.name, spec.type ?? 'text', rect, index, true));
      });
    }
    return items;
  });

  private item(name: string, type: FormFieldType, rect: Rect, index: number,
               staged: boolean): OverlayItem {
    const selected = this.selectedName() === name;
    return {
      id: `${name}#${index}`,
      page: this.page(),
      shape: 'rect',
      rect,
      stroke: selected ? '#4f46e5' : (staged ? '#059669' : '#64748b'),
      fill: staged ? '#a7f3d0' : '#e2e8f0',
      opacity: 0.45,
      width: selected ? 2 : 1,
      label: `${name} · ${type}`,
      // A radio group's placements are one field; dragging one of them alone
      // has no meaning the batch op could express.
      locked: type === 'radio',
      data: { name },
    };
  }

  constructor() {
    let lastSeq: number | null | undefined;
    effect(() => {
      const seq = this.currentSeq();
      if (lastSeq === seq) return;
      lastSeq = seq;
      // A new version is a new set of fields *and* new values in them.
      this.forms.reset();
      this.viewerData.set({});
      this.selectedName.set(null);
      this.forms.load(this.docId(), seq);
    });
  }

  // ------------------------------------------------------------------ //
  // Fill
  // ------------------------------------------------------------------ //
  protected onViewerData(data: FormDataType): void {
    this.viewerData.set(data);
    this.forms.syncFromViewer(data);
  }

  /** The panel's own inputs — the same values, for fields the viewer cannot
   *  render interactively and for keyboard-only use. */
  protected setValue(field: FormField, value: string | boolean): void {
    this.forms.setValue(field.name, value);
    this.viewerData.update((data) => ({ ...data, [field.name]: value }));
  }

  protected stringValue(field: FormField): string {
    return String(this.forms.valueOf(field) ?? '');
  }

  protected boolValue(field: FormField): boolean {
    return Boolean(this.forms.valueOf(field));
  }

  protected save(): void {
    const job$ = this.forms.saveFill(this.docId(), this.currentSeq());
    if (!job$) {
      this.toast.info('Nothing filled in yet');
      return;
    }
    this.track(job$, 'Form saved');
  }

  protected async saveAndFlatten(): Promise<void> {
    if (!(await this.confirm.ask(
      'Flattening makes the filled values permanent — the fields are removed and '
      + 'cannot be edited again, except by reverting in version history. Continue?',
      'Flatten',
    ))) return;
    const job$ = this.forms.saveFill(this.docId(), this.currentSeq(), true)
      ?? this.forms.flatten(this.docId(), this.currentSeq());
    this.track(job$, 'Form flattened');
  }

  protected exportData(format: 'json' | 'csv'): void {
    this.forms.exportData(this.docId(), format).subscribe({
      next: (blob) => saveBlob(blob, `form-data.${format}`),
      error: () => this.toast.error('Export failed'),
    });
  }

  protected onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const format = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'json';
    file.text().then(
      (text) => {
        this.busy.set(true);
        this.forms.importData(this.docId(), this.currentSeq(), format, text).subscribe({
          next: (job) => this.onJob(job, 'Form data imported'),
          error: () => this.fail(),
        });
      },
      () => this.toast.error('That file could not be read'),
    );
  }

  // ------------------------------------------------------------------ //
  // Build
  // ------------------------------------------------------------------ //
  protected arm(type: FormFieldType): void {
    this.armed.update((current) => (current === type ? null : type));
    if (this.armed()) {
      this.selectedName.set(null);
      this.draftOptions.set(NEEDS_OPTIONS.includes(type) ? 'Option 1\nOption 2' : '');
    }
  }

  protected onCreated(draft: OverlayDraft): void {
    const type = this.armed();
    if (!type || !draft.rect) return;
    const options = this.optionList();
    if (NEEDS_OPTIONS.includes(type) && options.length < (type === 'radio' ? 2 : 1)) {
      this.toast.info('Give the field its options first');
      return;
    }

    const name = this.forms.suggestName(type);
    const spec: FormFieldSpec = { name, type, page: draft.page };
    if (type === 'radio') {
      // One drawn box, N placements: the group is laid out down the page from
      // where it was drawn, so the user is not asked to draw the same box
      // repeatedly and get the sizes subtly wrong.
      spec.rects = options.map((_, i) => ({
        ...draft.rect!,
        y: Math.min(1 - draft.rect!.h, draft.rect!.y + i * (draft.rect!.h + RADIO_GAP)),
      }));
      spec.options = options;
    } else {
      spec.rect = draft.rect;
      if (options.length) spec.options = options;
    }
    this.forms.stageAdd(spec);
    this.armed.set(null);
    this.select(name, true);
  }

  protected onSelect(id: string | null): void {
    if (!id) {
      this.selectedName.set(null);
      return;
    }
    this.select(id.split('#')[0], false);
  }

  private select(name: string, isNew: boolean): void {
    this.selectedName.set(name);
    const staged = this.forms.pendingOps().find((op) => op.field.name === name);
    const existing = this.forms.fields().find((f) => f.name === name);
    const spec: FormFieldSpec | null = staged?.field ?? (existing ? {
      name: existing.name,
      type: existing.type,
      page: existing.page,
      rect: existing.rect,
      rects: existing.widgets.length > 1
        ? existing.widgets.map((w) => w.rect) : undefined,
      options: existing.options,
      required: existing.flags.required,
      readonly: existing.flags.readonly,
      multiline: existing.flags.multiline,
    } : null);
    this.draftIsNew = isNew || staged?.action === 'add';
    this.draftOriginal = spec;
    this.draftName.set(spec?.name ?? name);
    this.draftOptions.set((spec?.options ?? []).join('\n'));
    this.draftRequired.set(Boolean(spec?.required));
    this.draftReadonly.set(Boolean(spec?.readonly));
    this.draftMultiline.set(Boolean(spec?.multiline));
    this.draftAlign.set(spec?.align ?? 'left');
    this.draftFontSize.set(spec?.font_size ?? 11);
  }

  private optionList(): string[] {
    return this.draftOptions().split('\n').map((o) => o.trim()).filter(Boolean);
  }

  protected applyProperties(): void {
    const original = this.draftOriginal;
    if (!original) return;
    const name = this.draftName().trim();
    if (!name) {
      this.toast.info('A field needs a name');
      return;
    }
    if (name !== original.name && this.forms.nameTaken(name)) {
      this.toast.error(`A field called “${name}” already exists`);
      return;
    }
    const type = original.type ?? 'text';
    const options = this.optionList();
    if (NEEDS_OPTIONS.includes(type) && options.length < (type === 'radio' ? 2 : 1)) {
      this.toast.info('That field type needs its options');
      return;
    }
    const spec: FormFieldSpec = {
      ...original,
      name,
      options: options.length ? options : undefined,
      required: this.draftRequired(),
      readonly: this.draftReadonly(),
      multiline: this.draftMultiline(),
      align: this.draftAlign(),
      font_size: this.draftFontSize(),
    };
    if (type === 'radio' && spec.rects) {
      // The option count drives the placement count; the engine rejects a
      // mismatch, so keep them in step here rather than at save time.
      const first = spec.rects[0];
      spec.rects = options.map((_, i) => ({
        ...first,
        y: Math.min(1 - first.h, first.y + i * (first.h + RADIO_GAP)),
      }));
    }

    if (this.draftIsNew) {
      this.forms.stageDelete(original.name); // cancels the staged add
      this.forms.stageAdd(spec);
    } else if (name !== original.name) {
      // `update` is keyed on the name, so a rename is a delete plus an add —
      // in that order, which is exactly how the batch applies them.
      this.forms.stageDelete(original.name);
      this.forms.stageAdd(spec);
      this.draftIsNew = true;
    } else {
      this.forms.stageUpdate(spec);
    }
    this.draftOriginal = spec;
    this.selectedName.set(name);
    this.toast.success('Field updated — save to apply');
  }

  protected onGeometryChanged(change: { id: string; rect: Rect }): void {
    const name = change.id.split('#')[0];
    const staged = this.forms.pendingOps().find(
      (op) => op.action !== 'delete' && op.field.name === name,
    );
    const existing = this.forms.fields().find((f) => f.name === name);
    if (staged) {
      this.forms.stageUpdate({ ...staged.field, rect: change.rect });
    } else if (existing) {
      this.forms.stageUpdate({
        name: existing.name,
        type: existing.type,
        page: existing.page,
        rect: change.rect,
        options: existing.options.length ? existing.options : undefined,
        required: existing.flags.required,
        readonly: existing.flags.readonly,
        multiline: existing.flags.multiline,
      });
    }
    if (this.selectedName() === name) this.select(name, this.draftIsNew);
  }

  protected async deleteSelected(): Promise<void> {
    const name = this.selectedName();
    if (!name) return;
    if (!(await this.confirm.ask(`Remove the field “${name}”?`, 'Remove'))) return;
    this.forms.stageDelete(name);
    this.selectedName.set(null);
  }

  protected saveFields(): void {
    const job$ = this.forms.commitFields(this.docId(), this.currentSeq());
    if (!job$) {
      this.toast.info('No field changes to save');
      return;
    }
    this.track(job$, 'Form fields saved');
  }

  protected discardFields(): void {
    this.forms.clearOps();
    this.selectedName.set(null);
  }

  // ------------------------------------------------------------------ //
  // Shared job plumbing
  // ------------------------------------------------------------------ //
  private track(job$: ReturnType<FormsFacade['flatten']>, label: string): void {
    this.busy.set(true);
    job$.subscribe({
      next: (job) => this.onJob(job, label),
      error: () => this.fail(),
    });
  }

  private onJob(job: Job, label: string): void {
    if (job.status === 'succeeded') {
      this.busy.set(false);
      this.toast.success(label);
      this.forms.reset();
      this.selectedName.set(null);
      this.saved.emit(job);
    } else if (job.status === 'failed') {
      this.busy.set(false);
      if (job.error_code === 'version_conflict') {
        this.toast.info('Document changed — refreshed');
        this.conflict.emit();
      } else {
        this.toast.error(job.error_message || 'That did not work');
      }
    }
  }

  private fail(): void {
    this.busy.set(false);
    this.toast.error('That did not work');
  }

  protected prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }

  protected nextPage(): void {
    this.page.update((p) => Math.min(this.pageCount() - 1, p + 1));
  }
}
