import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import {
  FormField,
  FormFieldOp,
  FormFieldSpec,
  FormModel,
  FormValue,
  Job,
} from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { JobsFacade } from './jobs.facade';

/**
 * Form session state (phase-05).
 *
 * Two independent sessions live here because the phase gives the user two
 * modes over the same read model:
 *
 *   *fill*  — `_values`, mirrored against the viewer's form layer, saved as one
 *             `fill_form` job;
 *   *build* — `_ops`, add/update/delete of field definitions, saved as one
 *             `edit_form_fields_batch` job.
 *
 * Both are staged rather than sent per keystroke: an editing session is one
 * version, the same rule Phase 3 and Phase 4 follow.
 */
@Injectable({ providedIn: 'root' })
export class FormsFacade {
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);

  private _model = signal<FormModel | null>(null);
  private _values = signal<Map<string, FormValue>>(new Map());
  private _ops = signal<FormFieldOp[]>([]);
  private _loading = signal(false);
  private docId: string | null = null;

  readonly model = this._model.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly pendingOps = computed<FormFieldOp[]>(() => this._ops());

  readonly fields = computed<FormField[]>(() => this._model()?.fields ?? []);
  readonly hasForm = computed(() => this._model()?.has_form ?? false);
  readonly isXfa = computed(() => this._model()?.is_xfa ?? false);

  /** Only the values that differ from what is already in the file get sent. */
  readonly changed = computed<Record<string, FormValue>>(() => {
    const staged = this._values();
    const out: Record<string, FormValue> = {};
    for (const field of this.fields()) {
      if (!staged.has(field.name)) continue;
      const next = staged.get(field.name)!;
      if (FormsFacade.same(next, field)) continue;
      out[field.name] = next;
    }
    return out;
  });

  readonly dirty = computed(() => Object.keys(this.changed()).length > 0);
  readonly builderDirty = computed(() => this._ops().length > 0);

  /**
   * Is a staged value the same as what the field already holds?
   *
   * The viewer emits its whole form state, including every field the user never
   * touched, so without this every save would rewrite the entire form — and a
   * form with nothing changed would still mint a version.
   */
  private static same(value: FormValue, field: FormField): boolean {
    if (field.type === 'checkbox') {
      return Boolean(value) === Boolean(field.value && field.value !== 'Off');
    }
    return String(value) === String(field.value ?? '');
  }

  /** The value to show for a field: the staged one, else what is in the file. */
  valueOf(field: FormField): FormValue {
    const staged = this._values().get(field.name);
    if (staged !== undefined) return staged;
    if (field.type === 'checkbox') return Boolean(field.value && field.value !== 'Off');
    return field.value ?? '';
  }

  // ------------------------------------------------------------------ //
  // Loading
  // ------------------------------------------------------------------ //
  load(docId: string, version?: number | null): void {
    if (this.docId !== docId) {
      this.reset();
      this.docId = docId;
    }
    this._loading.set(true);
    this.docsSvc.form(docId, version).subscribe({
      next: (model) => {
        this._model.set(model);
        this._loading.set(false);
      },
      error: () => {
        this._model.set(null);
        this._loading.set(false);
      },
    });
  }

  /** A new version replaces the fields themselves — drop everything staged. */
  reset(): void {
    this._model.set(null);
    this._values.set(new Map());
    this._ops.set([]);
  }

  // ------------------------------------------------------------------ //
  // Fill
  // ------------------------------------------------------------------ //
  setValue(name: string, value: FormValue): void {
    this._values.update((map) => new Map(map).set(name, value));
  }

  /**
   * Absorb the viewer's form layer state (`[(formData)]`).
   *
   * Names the read model does not know are dropped: PDF.js also reports the
   * fields of an XFA layer, and sending one of those to `fill_form` fails the
   * whole job on an unknown name.
   */
  syncFromViewer(data: Record<string, unknown> | undefined | null): void {
    if (!data) return;
    const known = new Set(this.fields().map((f) => f.name));
    this._values.update((map) => {
      const next = new Map(map);
      for (const [name, raw] of Object.entries(data)) {
        if (!known.has(name)) continue;
        next.set(name, typeof raw === 'boolean' ? raw : String(raw ?? ''));
      }
      return next;
    });
  }

  /** Everything typed since load, as ONE `fill_form` job. */
  saveFill(docId: string, baseSeq: number | null, flattenAfter = false): Observable<Job> | null {
    const values = this.changed();
    if (!Object.keys(values).length) return null;
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'fill_form',
        params: { values, ...(flattenAfter ? { flatten_after: true } : {}) },
        base_version_seq: baseSeq,
      }),
    );
  }

  /** Bake the widgets into the page — values stay, fields go. */
  flatten(docId: string, baseSeq: number | null): Observable<Job> {
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'flatten',
        params: { what: 'form' },
        base_version_seq: baseSeq,
      }),
    );
  }

  importData(docId: string, baseSeq: number | null, format: 'json' | 'csv',
             data: string): Observable<Job> {
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'import_form_data',
        params: { format, data },
        base_version_seq: baseSeq,
      }),
    );
  }

  exportData(docId: string, format: 'json' | 'csv'): Observable<Blob> {
    return this.docsSvc.exportForm(docId, format);
  }

  // ------------------------------------------------------------------ //
  // Build
  // ------------------------------------------------------------------ //
  /** A name no field and no other staged op is already using. */
  suggestName(type: string): string {
    const taken = new Set(this.fields().map((f) => f.name));
    for (const op of this._ops()) taken.add(op.field.name);
    for (let n = 1; ; n++) {
      const candidate = `${type}_${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  nameTaken(name: string): boolean {
    return this.fields().some((f) => f.name === name)
      || this._ops().some((op) => op.action !== 'delete' && op.field.name === name);
  }

  stageAdd(field: FormFieldSpec): void {
    this._ops.update((ops) => [...ops, { action: 'add', field }]);
  }

  stageUpdate(field: FormFieldSpec): void {
    // One entry per field: re-dragging the same box twice must not send two
    // updates, and an update after an add is just a different add.
    this._ops.update((ops) => {
      const index = ops.findIndex((op) => op.field.name === field.name && op.action !== 'delete');
      if (index === -1) return [...ops, { action: 'update', field }];
      const next = [...ops];
      next[index] = { action: next[index].action, field: { ...next[index].field, ...field } };
      return next;
    });
  }

  stageDelete(name: string): void {
    this._ops.update((ops) => {
      // Deleting a field that was only ever staged locally cancels the add
      // instead of asking the server to remove something it never saw.
      const staged = ops.find((op) => op.action === 'add' && op.field.name === name);
      const rest = ops.filter((op) => op.field.name !== name);
      return staged ? rest : [...rest, { action: 'delete', field: { name } }];
    });
  }

  clearOps(): void {
    this._ops.set([]);
  }

  /** The whole builder session as ONE `edit_form_fields_batch` job. */
  commitFields(docId: string, baseSeq: number | null): Observable<Job> | null {
    const ops = this._ops();
    if (!ops.length) return null;
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'edit_form_fields_batch',
        params: { ops },
        base_version_seq: baseSeq,
      }),
    );
  }
}
