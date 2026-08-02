import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';

import { DocumentsService } from '../core/services/documents.service';

/** Fetches a thumbnail as an authed blob (img cannot send the JWT header). */
@Component({
  selector: 'app-pdf-thumbnail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (url(); as u) {
      <img [src]="u" [alt]="'page ' + (page() + 1)" class="h-full w-full object-contain" />
    } @else {
      <div class="flex h-full w-full items-center justify-center bg-slate-100 text-slate-500">
        <span class="text-xs">…</span>
      </div>
    }
  `,
})
export class PdfThumbnail {
  readonly docId = input.required<string>();
  readonly page = input(0);
  readonly width = input(240);
  readonly version = input<number | undefined>(undefined);

  protected url = signal<string | null>(null);
  private current: string | null = null;
  private docsSvc = inject(DocumentsService);

  constructor() {
    effect((onCleanup) => {
      const id = this.docId();
      const page = this.page();
      const w = this.width();
      const v = this.version();
      const sub = this.docsSvc.thumbnailBlob(id, page, w, v).subscribe({
        next: (blob) => {
          this.revoke();
          this.current = URL.createObjectURL(blob);
          this.url.set(this.current);
        },
        error: () => this.url.set(null),
      });
      onCleanup(() => {
        sub.unsubscribe();
        this.revoke();
      });
    });
  }

  private revoke(): void {
    if (this.current) {
      URL.revokeObjectURL(this.current);
      this.current = null;
    }
  }
}
