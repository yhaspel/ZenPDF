import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ToastService } from './toast.service';

@Component({
  selector: 'app-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2" data-test="toast-host">
      @for (t of toasts.toasts(); track t.id) {
        <div
          class="rounded-lg px-4 py-3 text-sm text-white shadow-lg"
          [class.bg-emerald-600]="t.type === 'success'"
          [class.bg-rose-600]="t.type === 'error'"
          [class.bg-slate-700]="t.type === 'info'"
          [attr.data-test]="'toast-' + t.type"
          (click)="toasts.dismiss(t.id)"
        >
          {{ t.message }}
        </div>
      }
    </div>
  `,
})
export class ToastHost {
  protected toasts = inject(ToastService);
}
