import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, finalize, map, switchMap } from 'rxjs';

import { Job, Rect, SavedSignature } from '../core/models/models';
import { DocumentsService } from '../core/services/documents.service';
import { EsignService } from '../core/services/esign.service';
import { HistoryStack } from '../shared/history';
import { JobsFacade } from './jobs.facade';

/** A signature the user has placed but not yet applied. */
export interface Placement {
  id: string;
  page: number;
  rect: Rect;
}

/**
 * Self-signing (phase-08 §8A).
 *
 * Holds the signature the user is signing *with* — either a saved one (an
 * account's library) or an ephemeral upload ref (a guest's, which lives as
 * long as the guest session and no longer). Everything below works for both,
 * which is the whole of §21.3's access split in one class.
 */
@Injectable({ providedIn: 'root' })
export class EsignFacade {
  private esign = inject(EsignService);
  private docsSvc = inject(DocumentsService);
  private jobs = inject(JobsFacade);

  private _saved = signal<SavedSignature[]>([]);
  private _placements = signal<Placement[]>([]);
  private _busy = signal(false);
  /** The chosen signature: a saved id, or an uploaded ref for a guest. */
  private _signatureId = signal<string | null>(null);
  private _uploadRef = signal<string | null>(null);
  /** A data URL, so the placement can be previewed before it is applied. */
  private _preview = signal<string | null>(null);

  readonly saved = this._saved.asReadonly();
  /** Undo over where the signature has been put down. */
  private history = new HistoryStack<Placement[]>();

  readonly canUndo = this.history.canUndo;
  readonly canRedo = this.history.canRedo;
  readonly placements = this._placements.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly preview = this._preview.asReadonly();
  readonly hasSignature = computed(
    () => !!this._signatureId() || !!this._uploadRef(),
  );

  private nextPlacementId = 0;

  loadSaved(): void {
    // Guests get 403 `account_required` here, which is not an error worth
    // showing: they simply have no library, and the pad is right there.
    this.esign.listSignatures().subscribe({
      next: (rows) => this._saved.set(rows),
      error: () => this._saved.set([]),
    });
  }

  chooseSaved(row: SavedSignature): void {
    this._signatureId.set(row.id);
    this._uploadRef.set(null);
    this._preview.set(this.esign.signatureImageUrl(row.id));
  }

  /** A freshly drawn/typed/uploaded signature, parked as an ephemeral asset.
   *  This is the guest path: no account, nothing saved. */
  useImage(dataUrl: string): Observable<string> {
    this._busy.set(true);
    return dataUrlToFile(dataUrl, 'signature.png').pipe(
      switchMap((file) => this.docsSvc.uploadImage(file)),
      map((asset) => {
        this._uploadRef.set(asset.ref);
        this._signatureId.set(null);
        this._preview.set(dataUrl);
        return asset.ref;
      }),
      finalize(() => this._busy.set(false)),
    );
  }

  /** Keep it for next time — accounts only, and the UI says so. */
  save(dataUrl: string, kind: 'signature' | 'initials' = 'signature'):
    Observable<SavedSignature> {
    return this.esign.createSignature({ method: 'draw', kind, image: dataUrl,
                                        is_default: true }).pipe(
      map((row) => {
        this._saved.update((rows) => [row, ...rows]);
        this.chooseSaved(row);
        return row;
      }),
    );
  }

  place(page: number, rect: Rect): void {
    this.history.remember([...this._placements()]);
    this._placements.update((list) => [
      ...list, { id: `p${this.nextPlacementId++}`, page, rect },
    ]);
  }

  unplace(id: string): void {
    this.history.remember([...this._placements()]);
    this._placements.update((list) => list.filter((p) => p.id !== id));
  }

  /** Move a placement that is already down, so it can be dragged and nudged. */
  movePlacement(id: string, rect: Rect): void {
    this.history.remember([...this._placements()]);
    this._placements.update((list) =>
      list.map((p) => (p.id === id ? { ...p, rect } : p)));
  }

  undoPlacements(): void {
    const previous = this.history.undo([...this._placements()]);
    if (previous) this._placements.set(previous);
  }

  redoPlacements(): void {
    const next = this.history.redo([...this._placements()]);
    if (next) this._placements.set(next);
  }

  clear(): void {
    this.history.clear();
    this._placements.set([]);
  }

  reset(): void {
    this.clear();
    this._signatureId.set(null);
    this._uploadRef.set(null);
    this._preview.set(null);
  }

  apply(docId: string, baseSeq: number | null, includeDate: boolean):
    Observable<Job> {
    const id = this._signatureId();
    const ref = this._uploadRef();
    this._busy.set(true);
    return this.jobs.dispatch(
      this.docsSvc.operation(docId, {
        type: 'self_sign',
        params: {
          placements: this._placements().map((p) => ({
            ...(id ? { signature_id: id } : { signature_upload_ref: ref }),
            page: p.page,
            rect: p.rect,
          })),
          include_date: includeDate,
        },
        base_version_seq: baseSeq,
      }),
    ).pipe(finalize(() => this._busy.set(false)));
  }
}

/** A data URL → a File, without a round trip through the network. */
export function dataUrlToFile(dataUrl: string, name: string): Observable<File> {
  return new Observable<File>((subscriber) => {
    try {
      const [header, encoded] = dataUrl.split(',');
      const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'image/png';
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      subscriber.next(new File([bytes], name, { type: mime }));
      subscriber.complete();
    } catch (err) {
      subscriber.error(err);
    }
  });
}
