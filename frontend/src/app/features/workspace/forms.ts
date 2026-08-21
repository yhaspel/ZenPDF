import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
import { EditorClipboard } from '../../shared/editor-clipboard.service';
import {
  OverlayDraft,
  OverlayItem,
  OverlayMenuAction,
  nudgeRect,
} from '../../shared/page-overlay/overlay-model';
import { PageOverlay } from '../../shared/page-overlay/page-overlay';
import { ShortcutId, resolveShortcut, shortcutTitle } from '../../shared/shortcuts';
import { saveBlob } from '../../shared/save-blob';
import { ToastService } from '../../shared/toast.service';

export type FormsTab = 'fill' | 'build';

const TYPES: FormFieldType[] = [
  'text', 'checkbox', 'radio', 'combobox', 'listbox', 'signature',
];

const NEEDS_OPTIONS: FormFieldType[] = ['radio', 'combobox', 'listbox'];

/** Vertical gap between the auto-laid-out placements of a radio group. */
const RADIO_GAP = 0.012;

/** How far a duplicated or pasted field lands from its original. */
const PASTE_OFFSET = 0.02;

/**
 * One drawn box → N placements running down the page.
 *
 * Clamping each row to the page instead of laying the group out as a whole
 * gave every option past the bottom the *same* rect — a group whose last few
 * choices were invisible and unclickable, with no error anywhere, because each
 * rect was individually valid. So the block is shifted up to fit, and only if
 * it still cannot fit is the spacing compressed.
 */
/**
 * An existing field as the spec that would recreate it.
 *
 * An update is delete-then-**add**, so every property the spec leaves out is
 * reset: dragging a field used to silently wipe its max length, alignment,
 * font size and default. Everything the read model reports goes back.
 */
export function specOf(field: FormField): FormFieldSpec {
  return {
    name: field.name,
    type: field.type,
    page: field.page,
    rect: field.rect,
    rects: field.widgets.length > 1 ? field.widgets.map((w) => w.rect) : undefined,
    options: field.options.length ? field.options : undefined,
    required: field.flags.required,
    readonly: field.flags.readonly,
    multiline: field.flags.multiline,
    align: field.align,
    max_len: field.max_len || undefined,
    font_size: field.font_size || undefined,
    default: field.default || undefined,
  };
}

export function radioLayout(rect: Rect, count: number): Rect[] {
  const step = rect.h + RADIO_GAP;
  const span = step * (count - 1) + rect.h;
  const scale = span <= 1 ? 1 : Math.max(0, (1 - rect.h) / (step * (count - 1)));
  const start = span <= 1 ? Math.min(rect.y, 1 - span) : 0;
  return Array.from({ length: count }, (_, i) => ({
    ...rect,
    y: start + i * step * scale,
  }));
}

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
  private clipboard = inject(EditorClipboard);
  private destroyRef = inject(DestroyRef);
  protected readonly key = shortcutTitle;

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
      stroke: selected ? '#B23A26' : (staged ? '#2F6B46' : '#776E5E'),
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

    // The builder's keyboard. Its lifetime is the component's, and it is inert
    // outside the build tab (see `onShortcut`).
    effect((onCleanup) => {
      if (typeof window === 'undefined') return;
      const handler = (event: KeyboardEvent) => this.onShortcut(event);
      window.addEventListener('keydown', handler);
      onCleanup(() => window.removeEventListener('keydown', handler));
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
      spec.rects = radioLayout(draft.rect, options.length);
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

  // ------------------------------------------------------------------ //
  // Keyboard, clipboard and the context menu (phase-12)
  // ------------------------------------------------------------------ //

  protected readonly canPaste = computed(() => this.clipboard.has('form-field'));

  protected menuActionsFor = (id: string | null): OverlayMenuAction[] => {
    const name = id ? id.split('#')[0] : null;
    if (!name) {
      return this.canPaste()
        ? [{ id: 'paste', label: 'Paste a field here', shortcut: this.key('paste') }]
        : [];
    }
    return [
      { id: 'copy', label: 'Copy', shortcut: this.key('copy') },
      { id: 'duplicate', label: 'Duplicate', shortcut: this.key('duplicate') },
      { id: 'properties', label: 'Properties' },
      { id: 'delete', label: 'Remove field', danger: true, shortcut: this.key('delete') },
    ];
  };

  protected onContextTarget(id: string | null): void {
    if (id) this.select(id.split('#')[0], false);
  }

  protected onMenuAction(choice: { action: string; itemId: string | null }): void {
    const name = choice.itemId ? choice.itemId.split('#')[0] : null;
    switch (choice.action) {
      case 'copy':
        this.copyField(name);
        break;
      case 'duplicate':
        this.duplicateField(name);
        break;
      case 'properties':
        if (name) this.select(name, false);
        break;
      case 'paste':
        this.pasteField();
        break;
      case 'delete':
        void this.deleteSelected(name);
        break;
    }
  }

  private specFor(name: string | null): FormFieldSpec | null {
    if (!name) return null;
    const staged = this.forms.pendingOps().find(
      (op) => op.action !== 'delete' && op.field.name === name,
    );
    if (staged) return staged.field;
    const existing = this.forms.fields().find((f) => f.name === name);
    return existing ? specOf(existing) : null;
  }

  protected copyField(name: string | null = this.selectedName()): boolean {
    const spec = this.specFor(name);
    if (!spec) return false;
    this.clipboard.copy('form-field', spec);
    this.toast.info('Copied');
    return true;
  }

  protected duplicateField(name: string | null = this.selectedName()): boolean {
    const spec = this.specFor(name);
    if (!spec) return false;
    this.placeCopy(spec, spec.page ?? this.page());
    return true;
  }

  protected pasteField(): boolean {
    const held = this.clipboard.read<FormFieldSpec>('form-field');
    if (!held) return false;
    this.placeCopy(held, this.page());
    return true;
  }

  /**
   * A copy of a field, offset, with a name of its own.
   *
   * A name is a field's identity in the AcroForm — two fields sharing one are
   * two views of the same value, which is emphatically not what "duplicate"
   * means here — so the copy takes a fresh one from the same generator that
   * names a newly drawn field.
   */
  private placeCopy(spec: FormFieldSpec, page: number): void {
    const type = spec.type ?? 'text';
    const name = this.forms.suggestName(type);
    const copy: FormFieldSpec = { ...spec, name, page };
    if (spec.rect) copy.rect = nudgeRect(spec.rect, PASTE_OFFSET, PASTE_OFFSET);
    if (spec.rects?.length) {
      // Re-lay the group out from the moved first row, so the placements stay
      // the even column the layout helper guarantees.
      copy.rects = radioLayout(
        nudgeRect(spec.rects[0], PASTE_OFFSET, PASTE_OFFSET), spec.rects.length,
      );
    }
    this.forms.stageAdd(copy);
    this.select(name, true);
  }

  private onShortcut(event: KeyboardEvent): void {
    // The builder's keyboard, and only the builder's: the Fill tab hands the
    // page to pdf.js, which binds `window` keydown itself and owns ⌘S there.
    if (this.tab() !== 'build') return;
    const hasTextSelection = !(window.getSelection()?.isCollapsed ?? true);
    const action = resolveShortcut(event, { hasTextSelection });
    if (!action) return;
    if (action === 'cancel' || action === 'delete' || action === 'context-menu') return;
    if (action.startsWith('nudge-')) return;
    if (this.runAction(action)) event.preventDefault();
  }

  private runAction(action: ShortcutId): boolean {
    switch (action) {
      case 'undo':
        this.forms.undo();
        return true;
      case 'redo':
        this.forms.redo();
        return true;
      case 'copy':
        return this.copyField();
      case 'cut':
        if (!this.copyField()) return false;
        void this.deleteSelected(this.selectedName());
        return true;
      case 'paste':
        return this.pasteField();
      case 'duplicate':
        return this.duplicateField();
      case 'save':
        this.saveFields();
        return true;
      default:
        return false;
    }
  }

  private select(name: string, isNew: boolean): void {
    this.selectedName.set(name);
    const staged = this.forms.pendingOps().find((op) => op.field.name === name);
    const existing = this.forms.fields().find((f) => f.name === name);
    const spec: FormFieldSpec | null = staged?.field ?? (existing ? specOf(existing) : null);
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
      spec.rects = radioLayout(spec.rects[0], options.length);
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
      this.forms.stageUpdate({ ...specOf(existing), rect: change.rect });
    }
    if (this.selectedName() === name) this.select(name, this.draftIsNew);
  }

  protected async deleteSelected(target: string | null = this.selectedName()): Promise<void> {
    const name = target;
    if (!name) return;
    if (!(await this.confirm.ask(`Remove the field “${name}”?`, 'Remove'))) return;
    this.forms.stageDelete(name);
    if (this.selectedName() === name) this.selectedName.set(null);
  }

  /** The overlay's Delete key, which carries the placement index. */
  protected onDeleteRequested(id: string): void {
    void this.deleteSelected(id.split('#')[0]);
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
    job$ = job$.pipe(takeUntilDestroyed(this.destroyRef));
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
