import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';

import { DocumentsService } from '../core/services/documents.service';

export interface UploadItem {
  id: string;
  name: string;
  progress: number;
  status: 'uploading' | 'done' | 'error' | 'repairable';
  error?: string;
  file: File;
}

@Injectable({ providedIn: 'root' })
export class UploadFacade {
  private docsSvc = inject(DocumentsService);
  private _uploads = signal<UploadItem[]>([]);
  readonly uploads = this._uploads.asReadonly();

  /** Upload files in parallel with per-file progress. Calls `onComplete` after each success. */
  uploadFiles(files: File[], folder: string | null, onComplete: () => void): void {
    for (const file of files) {
      this.startOne(file, folder, false, onComplete);
    }
  }

  retryWithRepair(item: UploadItem, folder: string | null, onComplete: () => void): void {
    this.startOne(item.file, folder, true, onComplete, item.id);
  }

  clearFinished(): void {
    this._uploads.update((items) => items.filter((i) => i.status === 'uploading'));
  }

  private startOne(
    file: File,
    folder: string | null,
    repair: boolean,
    onComplete: () => void,
    reuseId?: string,
  ): void {
    const id = reuseId ?? `${file.name}-${file.size}-${this._uploads().length}`;
    this.upsert({ id, name: file.name, progress: 0, status: 'uploading', file });

    this.docsSvc.upload(file, folder, repair).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress && event.total) {
          this.upsert({
            id,
            name: file.name,
            progress: Math.round((event.loaded / event.total) * 100),
            status: 'uploading',
            file,
          });
        } else if (event.type === HttpEventType.Response) {
          this.upsert({ id, name: file.name, progress: 100, status: 'done', file });
          onComplete();
        }
      },
      error: (err: HttpErrorResponse) => {
        const repairable = err.status === 415 && err.error?.error?.details?.repair_offer === true;
        this.upsert({
          id,
          name: file.name,
          progress: 0,
          status: repairable ? 'repairable' : 'error',
          error: err.error?.error?.message ?? 'Upload failed',
          file,
        });
      },
    });
  }

  private upsert(item: UploadItem): void {
    this._uploads.update((items) => {
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx >= 0) {
        const copy = [...items];
        copy[idx] = item;
        return copy;
      }
      return [...items, item];
    });
  }
}
