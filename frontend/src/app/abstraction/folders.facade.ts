import { Injectable, inject, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { Folder } from '../core/models/models';
import { FoldersService } from '../core/services/folders.service';

@Injectable({ providedIn: 'root' })
export class FoldersFacade {
  private svc = inject(FoldersService);
  private _folders = signal<Folder[]>([]);
  readonly folders = this._folders.asReadonly();

  load(): void {
    this.svc.list().subscribe({ next: (f) => this._folders.set(f) });
  }

  create(name: string, parent: string | null = null): void {
    this.svc.create(name, parent).subscribe({ next: () => this.load() });
  }

  remove(id: string, cascade = false): Observable<unknown> {
    return this.svc.remove(id, cascade);
  }
}
