import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ToastService } from './toast.service';

@Component({
  selector: 'app-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- A live region: a job finishing is announced rather than only shown,
         which is the whole point of a toast for somebody using a screen
         reader (§10.3). Polite, because it must not interrupt typing. -->
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2" data-test="toast-host"
         role="status" aria-live="polite" aria-atomic="true">
      @for (t of toasts.toasts(); track t.id) {
        <!-- emerald-700/rose-700 rather than -600: white on emerald-600 is
             3.1:1, under the 4.5:1 AA threshold for text this size. -->
        <div
          class="rounded-lg px-4 py-3 text-sm text-white shadow-lg"
          [class.bg-emerald-700]="t.type === 'success'"
          [class.bg-rose-700]="t.type === 'error'"
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
