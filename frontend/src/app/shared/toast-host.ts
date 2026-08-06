import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ToastService } from './toast.service';

@Component({
  selector: 'app-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- A live region: a job finishing is announced rather than only shown,
         which is the whole point of a toast for somebody using a screen reader
         (§10.3). aria-atomic belongs on each toast, not here: on the
         container it re-announces the whole stack every time one arrives or
         expires. -->
    <div class="fixed bottom-4 end-4 z-50 flex flex-col gap-2" data-test="toast-host"
         aria-live="polite">
      @for (t of toasts.toasts(); track t.id) {
        <!-- Ink on paper with a colored spine — never a colored fill (design
             contract §3). role=alert on errors, because an error is the one a
             screen reader should hear before the sentence it was reading
             finishes. -->
        <button
          type="button"
          class="toast text-start"
          [class.toast-success]="t.type === 'success'"
          [class.toast-error]="t.type === 'error'"
          [attr.role]="t.type === 'error' ? 'alert' : 'status'"
          aria-atomic="true"
          [attr.data-test]="'toast-' + t.type"
          [attr.aria-label]="t.message + ' — dismiss'"
          (click)="toasts.dismiss(t.id)"
        >
          {{ t.message }}
        </button>
      }
    </div>
  `,
})
export class ToastHost {
  protected toasts = inject(ToastService);
}
